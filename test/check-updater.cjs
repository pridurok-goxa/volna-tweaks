/**
 * Контракт хост-части автообновления из git (tweaks/updater-host.js).
 *
 * Проверяется без сети и без настоящего git: запуск git подставляется
 * заглушкой, поэтому тест не делает ни `fetch`, ни `pull`, ни `merge` в
 * рабочем дереве. Файлы состояния (update.json, update.log) пишутся во
 * временный `DSH_HOME`, профиль настоящего DSH не трогается.
 *
 * Кейсы:
 *   1. `decideUpdate` — behind / same / dirty / ahead / no-upstream / расхождение;
 *   2. `buildStatus` — точный набор полей контракта клиента и нормализация;
 *   3. `formatLogLine` — строка на событие без переводов строки;
 *   4. `checkNow` — no-git, dirty (fetch не зовётся), behind (merge --ff-only),
 *      up-to-date, ahead, no-upstream, offline, сбой merge;
 *   5. `runGitProcess` — запрещённая подкоманда и запрещённые префиксы
 *      (`--force-with-lease`, `-fd`, `--hard=…`, `pull`, `stash`…) не создают
 *      процесс, а разрешённые вызовы до git доходят;
 *   6. роуты — GET status, POST check с троттлингом 30 с, чужой метод → 405;
 *   7. `restartNeeded` — true после merge, false, когда запущенная версия
 *      догнала апстрим (рестарт DSH);
 *   8. настоящий git во временном каталоге (remote — локальный путь, сети нет):
 *      полный клон 1.0.0 + апстрим 2.0.0 → `updated`, файл 2.0.0, клон не
 *      shallow; `clone --depth=1` чинится `--unshallow` и тоже обновляется;
 *      повторная проверка актуального клона — `up-to-date` без merge. Если git
 *      в окружении нет, эти кейсы явно пропускаются с сообщением;
 *   9. `stateDir` — каталог состояния: внутри заданного `DSH_HOME`; при пустой
 *      переменной — под `<homedir>/.dsh/<папка плагина>` (десктопное приложение
 *      `DSH_HOME` не выставляет); недоступный домашний каталог — тихий null.
 *
 * Запуск: node test/check-updater.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// Файлы состояния — во временный каталог: профиль настоящего DSH не трогаем.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tweaks-updater-'));
// Без уборки каждый прогон оставлял каталог в `%TEMP%` навсегда.
process.on('exit', () => {
  try {
    fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (_error) {
    /* каталог в %TEMP% уберёт система */
  }
});

const ROOT = path.join(__dirname, '..');
const HOST_PATH = path.join(ROOT, 'tweaks', 'updater-host.js');
const INDEX_PATH = path.join(ROOT, 'index.js');

/** Каталог состояния твика: тот же, что у светофора. */
const STATE_DIR = path.join(process.env.DSH_HOME, 'dsh-tweaks');
const CACHE_FILE = path.join(STATE_DIR, 'update.json');
const LOG_FILE = path.join(STATE_DIR, 'update.log');

/** Вершины репозитория: полные sha, как их отдаёт `git rev-parse`. */
const HEAD_SHA = 'a'.repeat(40);
const UPSTREAM_SHA = 'b'.repeat(40);

/** Запрещённые команды и аргументы: их не должно быть ни в одном вызове. */
const FORBIDDEN = /(^|\s)(pull|rebase|reset|checkout|switch|restore|clean|stash|--hard|--force)(\s|$)/;

let passed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log('ok', name);
    });
}

/** Успешный ответ заглушки git. */
const okRun = (out = '') => ({ ok: true, code: 0, out, err: '', timedOut: false });

/** Неуспешный ответ заглушки git. */
const failRun = (code = 1) => ({ ok: false, code, out: '', err: '', timedOut: false });

/**
 * Заглушка запуска git: отвечает по подкоманде и запоминает все вызовы.
 * @param {object} [options] - сценарий репозитория.
 * @returns {{git: Function, calls: string[]}} заглушка и журнал вызовов.
 */
function createGit(options = {}) {
  const calls = [];
  const upstreamSha = Object.prototype.hasOwnProperty.call(options, 'upstreamSha') ? options.upstreamSha : UPSTREAM_SHA;
  const ancestorCode = options.ancestorCode === undefined ? 0 : options.ancestorCode;
  const git = async (args) => {
    const command = args.join(' ');
    calls.push(command);
    if (command === 'status --porcelain') return okRun(options.status ?? '');
    if (command === 'rev-parse --is-shallow-repository') return okRun(options.shallow === true ? 'true\n' : 'false\n');
    if (command === 'fetch --quiet --unshallow origin') return options.unshallowOk === false ? failRun(null) : okRun();
    if (command === 'fetch --quiet origin') return options.fetchOk === false ? failRun(null) : okRun();
    if (command === 'rev-parse HEAD') return okRun(`${HEAD_SHA}\n`);
    if (command === 'rev-parse --verify @{u}') return upstreamSha === null ? failRun(1) : okRun(`${upstreamSha}\n`);
    if (command === 'rev-parse --verify origin/main') return upstreamSha === null ? failRun(1) : okRun(`${upstreamSha}\n`);
    if (command.startsWith('merge-base --is-ancestor')) {
      return { ok: ancestorCode === 0, code: ancestorCode, out: '', err: '', timedOut: false };
    }
    if (command.startsWith('show ')) {
      return options.showOk === false ? failRun(1) : okRun(JSON.stringify({ version: options.upstreamVersion ?? '4.2.0' }));
    }
    if (command.startsWith('merge --ff-only')) return options.mergeOk === false ? failRun(1) : okRun();
    return failRun(1);
  };
  return { git, calls };
}

/**
 * Git этой машины для теста с настоящим репозиторием.
 * @returns {{ok: boolean, reason: string}} доступен ли git.
 */
function gitAvailability() {
  try {
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    if (probe.error) return { ok: false, reason: String(probe.error.message ?? probe.error) };
    if (probe.status !== 0) return { ok: false, reason: `git --version → ${probe.status}: ${probe.stderr}` };
    return { ok: true, reason: String(probe.stdout ?? '').trim() };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/**
 * Запустить git в каталоге тестового репозитория.
 * @param {string} cwd - каталог.
 * @param {string[]} args - аргументы git.
 * @returns {string} stdout.
 */
function gitRun(cwd, args) {
  const run = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`git ${args.join(' ')} → ${run.status}: ${String(run.stderr ?? '').trim()}`);
  }
  return String(run.stdout ?? '');
}

/** Идентичность для коммитов тестового репозитория (глобальный конфиг не трогаем). */
const GIT_IDENTITY = ['-c', 'user.name=tweaks-test', '-c', 'user.email=tweaks-test@example.invalid'];

/**
 * Коммит тестового репозитория.
 * @param {string} cwd - каталог репозитория.
 * @param {string} message - сообщение коммита.
 * @returns {void}
 */
function gitCommit(cwd, message) {
  gitRun(cwd, [...GIT_IDENTITY, 'commit', '-q', '-m', message]);
}

/**
 * Записать `package.json` версии в каталог.
 * @param {string} dir - каталог репозитория.
 * @param {string} version - версия.
 * @returns {void}
 */
function writePackage(dir, version) {
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'volna-tweaks', version }, null, 2)}\n`);
}

/**
 * Версия из `package.json` каталога.
 * @param {string} dir - каталог репозитория.
 * @returns {string | null} версия либо null.
 */
function readPackageVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version ?? null;
  } catch (_error) {
    return null;
  }
}

/** Убрать временный каталог теста (Windows любит подержать файлы `.git`). */
function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (_error) {
    /* каталог в %TEMP% уберёт система */
  }
}

/**
 * Временный «origin» и рабочий клон: клон делается до второго коммита, чтобы
 * в (shallow-)копии не было апстримной вершины. Remote — локальный путь, в сеть
 * тест не ходит.
 * @param {object} [options] - поведение фикстуры.
 * @param {boolean} [options.shallow] - клонировать с `--depth=1`.
 * @param {boolean} [options.bump] - сделать второй коммит 2.0.0 в origin.
 * @returns {{root: string, origin: string, work: string}} каталоги фикстуры.
 */
function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tweaks-git-'));
  const origin = path.join(root, 'origin');
  const work = path.join(root, 'work');
  fs.mkdirSync(origin, { recursive: true });
  gitRun(origin, ['init', '-q', '-b', 'main']);
  writePackage(origin, '1.0.0');
  gitRun(origin, ['add', 'package.json']);
  gitCommit(origin, 'one');
  // `--depth` работает только с URL: локальный путь git молча игнорирует.
  const source = options.shallow === true ? pathToFileURL(origin).href : origin;
  gitRun(root, options.shallow === true ? ['clone', '-q', '--depth=1', source, work] : ['clone', '-q', source, work]);
  if (options.bump !== false) {
    writePackage(origin, '2.0.0');
    gitRun(origin, ['add', 'package.json']);
    gitCommit(origin, 'two');
  }
  return { root, origin, work };
}

/** Shallow-клон это или нет, по ответу настоящего git. */
function isShallowClone(dir) {
  return gitRun(dir, ['rev-parse', '--is-shallow-repository']).trim();
}

/** Число коммитов в истории рабочего клона. */
function commitCount(dir) {
  return Number(gitRun(dir, ['rev-list', '--count', 'HEAD']).trim());
}

/** Заглушка хост-контекста: роуты, фильтр соединения и effect. */
function createScope() {
  const routes = new Map();
  const disposers = [];
  const scope = {
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    connection: { requestRejection: () => undefined },
    effect(callback) {
      const off = callback();
      if (typeof off === 'function') disposers.push(off);
      return () => {};
    },
  };
  const ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['webServer', 'connection'], 'роуты просят webServer и connection');
      callback(scope);
      return () => {};
    },
  };
  return { ctx, routes, disposers };
}

/** Вызвать обработчик роута и разобрать JSON-ответ. */
async function callRoute(route, method) {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(text) {
      this.body = typeof text === 'string' ? text : '';
    },
  };
  await route.handler({ method }, res);
  let json = null;
  try {
    json = res.body === '' ? null : JSON.parse(res.body);
  } catch (_error) {
    json = null;
  }
  return { status: res.statusCode, json, headers: res.headers };
}

/** Очистить кэш статуса между кейсами. */
function clearCache() {
  try {
    fs.rmSync(CACHE_FILE, { force: true });
  } catch (_error) {
    /* файла нет */
  }
}

/** Прочитать журнал твика. */
function readLog() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8');
  } catch (_error) {
    return '';
  }
}

(async () => {
  const host = await import(pathToFileURL(HOST_PATH).href);
  /** Имя папки плагина — второе слагаемое каталога состояния. */
  const PLUGIN_FOLDER = path.basename(host.PLUGIN_DIR);

  await test('decideUpdate: мы позади — только fast-forward', () => {
    assert.deepEqual(host.decideUpdate({ head: HEAD_SHA, upstream: UPSTREAM_SHA, dirty: false, behind: true, ahead: false }), {
      action: 'pull',
      reason: 'behind',
    });
  });

  await test('decideUpdate: вершины совпали — обновлять нечего', () => {
    assert.deepEqual(host.decideUpdate({ head: UPSTREAM_SHA, upstream: UPSTREAM_SHA, dirty: false, behind: false, ahead: false }), {
      action: 'up-to-date',
      reason: 'same',
    });
  });

  await test('decideUpdate: грязное дерево отменяет обновление', () => {
    assert.deepEqual(host.decideUpdate({ head: HEAD_SHA, upstream: UPSTREAM_SHA, dirty: true, behind: true, ahead: false }), {
      action: 'skip',
      reason: 'dirty',
    });
  });

  await test('decideUpdate: свои коммиты — не трогаем', () => {
    assert.deepEqual(host.decideUpdate({ head: HEAD_SHA, upstream: UPSTREAM_SHA, dirty: false, behind: false, ahead: true }), {
      action: 'skip',
      reason: 'ahead',
    });
  });

  await test('decideUpdate: расхождение истории — skip/ahead, не pull', () => {
    assert.deepEqual(host.decideUpdate({ head: HEAD_SHA, upstream: UPSTREAM_SHA, dirty: false, behind: true, ahead: true }), {
      action: 'skip',
      reason: 'ahead',
    });
  });

  await test('decideUpdate: нет апстрима — skip/no-upstream', () => {
    assert.deepEqual(host.decideUpdate({ head: HEAD_SHA, upstream: '', dirty: false }), { action: 'skip', reason: 'no-upstream' });
    assert.deepEqual(host.decideUpdate({ head: '', upstream: UPSTREAM_SHA, dirty: false }), { action: 'skip', reason: 'no-upstream' });
  });

  await test('buildStatus: точный набор полей контракта', () => {
    const status = host.buildStatus({
      installed: '4.1.0',
      upstream: '4.2.0',
      checkedAt: 1_700_000_000_000,
      updatedAt: null,
      restartNeeded: true,
      state: 'updated',
      reason: 'behind',
      autoUpdate: true,
    });
    assert.deepEqual(Object.keys(status), [
      'ok',
      'installed',
      'upstream',
      'checkedAt',
      'updatedAt',
      'restartNeeded',
      'state',
      'reason',
      'intervalHours',
      'autoUpdate',
    ]);
    assert.equal(status.ok, true);
    assert.equal(status.installed, '4.1.0');
    assert.equal(status.upstream, '4.2.0');
    assert.equal(status.checkedAt, new Date(1_700_000_000_000).toISOString(), 'время отдаётся ISO-строкой');
    assert.equal(status.updatedAt, null);
    assert.equal(status.restartNeeded, true);
    assert.equal(status.state, 'updated');
    assert.equal(status.reason, 'behind');
    assert.equal(status.intervalHours, 6, 'интервал — 6 часов');
    assert.equal(status.autoUpdate, true);
  });

  await test('buildStatus: пустое состояние и мусор сводятся к безопасным значениям', () => {
    const status = host.buildStatus({ state: 'nonsense', reason: 'nonsense', installed: '', upstream: 42 });
    assert.equal(status.state, 'idle');
    assert.equal(status.reason, null);
    assert.equal(status.installed, null);
    assert.equal(status.upstream, null);
    assert.equal(status.checkedAt, null);
    assert.equal(status.restartNeeded, false);
    assert.equal(status.autoUpdate, true, 'по умолчанию автообновление включено');
    assert.equal(host.buildStatus({ autoUpdate: false }).autoUpdate, false);
  });

  await test('formatLogLine: одна строка с полями события', () => {
    const line = host.formatLogLine({
      at: 1_700_000_000_000,
      event: 'check',
      state: 'updated',
      reason: 'behind',
      head: HEAD_SHA,
      upstream: '4.2.0',
      note: 'merge',
    });
    assert.equal(line.includes('\n'), false, 'перевода строки нет');
    assert.match(line, /^2023-11-1\dT[\d:.]+Z \| check \| /);
    for (const marker of ['state=updated', 'reason=behind', `head=${HEAD_SHA}`, 'upstream=4.2.0', 'note=merge']) {
      assert.ok(line.includes(marker), `в строке есть ${marker}`);
    }
    assert.equal(host.formatLogLine({}).includes('\n'), false, 'пустое событие тоже одна строка');
  });

  await test('stateDir: DSH_HOME задан — каталог состояния внутри него', () => {
    const explicit = path.join(os.tmpdir(), 'dsh-home-explicit');
    assert.equal(host.stateDir({ vars: { DSH_HOME: explicit } }), path.join(explicit, PLUGIN_FOLDER));
    assert.equal(host.stateDir({ vars: { DSH_HOME: process.env.DSH_HOME } }), STATE_DIR, 'в тесте пишем во временный DSH_HOME');
  });

  await test('stateDir: DSH_HOME пустой — путь под <homedir>/.dsh (десктоп переменную не выставляет)', () => {
    for (const vars of [{}, { DSH_HOME: '' }, { DSH_HOME: undefined }]) {
      const dir = host.stateDir({ vars });
      assert.equal(dir, path.join(os.homedir(), '.dsh', PLUGIN_FOLDER), 'корень — домашний каталог DSH');
    }
  });

  await test('stateDir: домашний каталог недоступен — тихий null без исключения', () => {
    const boom = () => {
      throw new Error('homedir недоступен');
    };
    assert.equal(host.stateDir({ vars: {}, home: boom }), null, 'исключение не поднимается');
    assert.equal(host.stateDir({ vars: { DSH_HOME: '' }, home: boom }), null);
    assert.equal(host.stateDir({ vars: { DSH_HOME: '' }, home: () => '' }), null, 'пустой домашний каталог — не путь');
    assert.equal(host.stateDir({ vars: { DSH_HOME: '' }, home: () => 42 }), null, 'не строка — не путь');
    const explicit = path.join(os.tmpdir(), 'dsh-home-explicit');
    assert.equal(host.stateDir({ vars: { DSH_HOME: explicit }, home: boom }), path.join(explicit, PLUGIN_FOLDER), 'заданный DSH_HOME сильнее');
  });

  await test('checkNow: без .git — skipped/no-git, git не зовётся', async () => {
    const stub = createGit();
    const result = await host.checkNow({ dir: ROOT, git: stub.git, hasGit: false });
    assert.equal(result.state, 'skipped');
    assert.equal(result.reason, 'no-git');
    assert.deepEqual(stub.calls, [], 'ни одной команды git');
  });

  await test('checkNow: грязное дерево — skipped/dirty, fetch не выполняется', async () => {
    const stub = createGit({ status: ' M client.js\n' });
    const result = await host.checkNow({ dir: ROOT, git: stub.git, hasGit: true });
    assert.equal(result.state, 'skipped');
    assert.equal(result.reason, 'dirty');
    assert.deepEqual(stub.calls, ['status --porcelain'], 'после грязного дерева ничего не трогаем');
  });

  await test('checkNow: позади — merge --ff-only и состояние updated', async () => {
    const stub = createGit({ ancestorCode: 0 });
    const result = await host.checkNow({ dir: ROOT, git: stub.git, hasGit: true, now: 1_700_000_000_000 });
    assert.equal(result.state, 'updated');
    assert.equal(result.reason, 'behind');
    assert.equal(result.action, 'pull');
    assert.equal(result.upstreamVersion, '4.2.0');
    assert.equal(result.updated, true);
    assert.ok(stub.calls.includes(`merge --ff-only ${UPSTREAM_SHA}`), 'fast-forward выполнен');
    for (const call of stub.calls) assert.doesNotMatch(call, FORBIDDEN, `запрещённой команды нет: ${call}`);
  });

  await test('checkNow: вершины равны — up-to-date без merge', async () => {
    const stub = createGit({ upstreamSha: HEAD_SHA });
    const result = await host.checkNow({ dir: ROOT, git: stub.git, hasGit: true });
    assert.equal(result.state, 'up-to-date');
    assert.equal(result.reason, 'same');
    assert.equal(result.updated, false);
    assert.equal(stub.calls.some((call) => call.startsWith('merge --ff-only')), false, 'merge не зовётся');
  });

  await test('checkNow: мы впереди — skipped/ahead без merge', async () => {
    const stub = createGit({ ancestorCode: 1 });
    const result = await host.checkNow({ dir: ROOT, git: stub.git, hasGit: true });
    assert.equal(result.state, 'skipped');
    assert.equal(result.reason, 'ahead');
    assert.equal(stub.calls.some((call) => call.startsWith('merge --ff-only')), false, 'история не переписывается');
  });

  await test('checkNow: нет upstream — skipped/no-upstream', async () => {
    const stub = createGit({ upstreamSha: null });
    const result = await host.checkNow({ dir: ROOT, git: stub.git, hasGit: true });
    assert.equal(result.state, 'skipped');
    assert.equal(result.reason, 'no-upstream');
    assert.equal(stub.calls.includes('rev-parse --verify origin/main'), true, 'запасной путь к origin/main проверен');
    assert.equal(stub.calls.some((call) => call.startsWith('merge --ff-only')), false);
  });

  await test('checkNow: сеть недоступна — error/offline без сравнения вершин', async () => {
    const stub = createGit({ fetchOk: false });
    const result = await host.checkNow({ dir: ROOT, git: stub.git, hasGit: true });
    assert.equal(result.state, 'error');
    assert.equal(result.reason, 'offline');
    assert.equal(stub.calls.includes('rev-parse HEAD'), false, 'без fetch дальше не идём');
    assert.equal(stub.calls.some((call) => call.startsWith('merge --ff-only')), false, 'merge не запускается');
  });

  await test('checkNow: fetch без --depth, shallow-клон сначала докачивается --unshallow', async () => {
    const deep = createGit();
    await host.checkNow({ dir: ROOT, git: deep.git, hasGit: true });
    assert.ok(deep.calls.includes('fetch --quiet origin'), 'плановый fetch обычный');
    assert.equal(deep.calls.some((call) => call.includes('--depth')), false, '--depth больше не используется');
    assert.equal(deep.calls.includes('fetch --quiet --unshallow origin'), false, 'полному клону unshallow не нужен');

    const shallow = createGit({ shallow: true });
    const result = await host.checkNow({ dir: ROOT, git: shallow.git, hasGit: true });
    assert.equal(result.state, 'updated', 'shallow-клон обновляется');
    assert.ok(shallow.calls.includes('fetch --quiet --unshallow origin'), 'история сначала докачивается');
    assert.ok(
      shallow.calls.indexOf('fetch --quiet --unshallow origin') < shallow.calls.indexOf('fetch --quiet origin'),
      '--unshallow идёт до обычного fetch',
    );

    const broken = createGit({ shallow: true, unshallowOk: false });
    const failed = await host.checkNow({ dir: ROOT, git: broken.git, hasGit: true });
    assert.equal(failed.state, 'error');
    assert.equal(failed.reason, 'offline');
    assert.equal(broken.calls.includes('fetch --quiet origin'), false, 'не докачали историю — дальше не идём');
  });

  await test('checkNow: merge не прошёл — error/failed, updated=false', async () => {
    const stub = createGit({ mergeOk: false });
    const result = await host.checkNow({ dir: ROOT, git: stub.git, hasGit: true });
    assert.equal(result.state, 'error');
    assert.equal(result.reason, 'failed');
    assert.equal(result.updated, false);
  });

  await test('checkNow: нет package.json в апстриме — upstreamVersion null, проверка жива', async () => {
    const stub = createGit({ showOk: false });
    const result = await host.checkNow({ dir: ROOT, git: stub.git, hasGit: true });
    assert.equal(result.upstreamVersion, null);
    assert.equal(result.state, 'updated');
  });

  await test('runGitProcess: запрещённая команда не запускает процесс', async () => {
    const cases = [
      ['reset', '--hard'],
      ['checkout', 'main'],
      ['status', '--porcelain', 'stash'],
      ['pull', '--rebase'],
      ['diff'],
      ['fetch', '--force', 'origin'],
      ['fetch', '--force-with-lease', 'origin'],
      ['fetch', '--quiet', 'origin', 'pull'],
      ['merge', '-fd', HEAD_SHA],
      ['fetch', '--hard=HEAD', 'origin'],
    ];
    for (const args of cases) {
      const result = await host.runGitProcess(args, 1000, ROOT);
      assert.equal(result.ok, false, `отказ для ${args.join(' ')}`);
      assert.match(result.err, /^blocked-command:/);
      assert.equal(result.timedOut, false);
    }
  });

  await test('isForbiddenArg: префиксы режут опасное и пускают разрешённые аргументы', () => {
    for (const arg of ['--force', '--force-with-lease', '-f', '-fd', '--hard', '--hard=HEAD', '--mirror', 'pull', 'rebase', 'reset', 'checkout', 'switch', 'restore', 'clean', 'stash']) {
      assert.equal(host.isForbiddenArg(arg), true, `${arg} запрещён`);
    }
    for (const arg of [
      'status',
      '--porcelain',
      'fetch',
      '--quiet',
      'origin',
      '--unshallow',
      'rev-parse',
      '--verify',
      '@{u}',
      '--is-shallow-repository',
      'merge-base',
      '--is-ancestor',
      'merge',
      '--ff-only',
      'show',
      `${HEAD_SHA}:package.json`,
    ]) {
      assert.equal(host.isForbiddenArg(arg), false, `${arg} разрешён`);
    }
  });

  await test('runGitProcess: разрешённые вызовы доходят до git', async () => {
    const local = await host.runGitProcess(['status', '--porcelain'], 15_000, ROOT);
    assert.equal(local.err.startsWith('blocked-command:'), false, 'status не заблокирован фильтром');
    if (gitAvailability().ok !== true) {
      console.log('skip runGitProcess shallow-флаги: git недоступен в тестовом окружении');
      return;
    }
    // Пустой репозиторий без remote: fetch падает локально и в сеть не идёт.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tweaks-args-'));
    try {
      gitRun(dir, ['init', '-q']);
      for (const args of [['fetch', '--quiet', 'origin'], ['fetch', '--quiet', '--unshallow', 'origin'], ['rev-parse', '--is-shallow-repository']]) {
        const run = await host.runGitProcess(args, 15_000, dir);
        assert.equal(run.err.startsWith('blocked-command:'), false, `${args.join(' ')} не заблокирован`);
      }
    } finally {
      removeTree(dir);
    }
  });

  await test('роуты: GET status отдаёт конверт, POST check запускает проверку', async () => {
    clearCache();
    const stub = createGit({ ancestorCode: 0 });
    const { ctx, routes } = createScope();
    host.activate(ctx, { autoUpdate: false }, { dir: ROOT, git: stub.git, hasGit: true, installed: '4.1.0' });
    try {
      assert.equal([...routes.keys()].sort().join(','), '/volna-tweaks/update/check,/volna-tweaks/update/status');

      const status = await callRoute(routes.get('/volna-tweaks/update/status'), 'GET');
      assert.equal(status.status, 200);
      assert.equal(status.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(status.headers['cache-control'], 'no-store');
      assert.equal(status.json.ok, true);
      assert.equal(status.json.installed, '4.1.0');
      assert.equal(status.json.intervalHours, 6);
      assert.equal(status.json.autoUpdate, false, 'флаг из конфигурации');
      assert.equal(status.json.state, 'idle', 'до проверки состояние idle');
      assert.deepEqual(stub.calls, [], 'GET статуса git не зовёт');

      const checked = await callRoute(routes.get('/volna-tweaks/update/check'), 'POST');
      assert.equal(checked.status, 200);
      assert.equal(checked.json.ok, true);
      assert.equal(checked.json.state, 'updated');
      assert.equal(checked.json.reason, 'behind');
      assert.equal(checked.json.upstream, '4.2.0');
      assert.equal(checked.json.restartNeeded, true, 'после merge нужен перезапуск');
      assert.ok(checked.json.checkedAt, 'время проверки заполнено');
      assert.ok(checked.json.updatedAt, 'время обновления заполнено');
      assert.equal(stub.calls.filter((call) => call.startsWith('merge --ff-only')).length, 1);
    } finally {
      await host.deactivate();
    }
  });

  await test('роуты: повторная проверка в пределах 30 с — троттлинг, git не зовётся', async () => {
    const stub = createGit({ ancestorCode: 1 });
    const { ctx, routes } = createScope();
    host.activate(ctx, { autoUpdate: false }, { dir: ROOT, git: stub.git, hasGit: true, installed: '4.1.0' });
    try {
      const first = await callRoute(routes.get('/volna-tweaks/update/check'), 'POST');
      assert.equal(first.json.state, 'skipped');
      const callsAfterFirst = stub.calls.length;
      assert.ok(callsAfterFirst > 0, 'первая проверка выполнилась');

      const second = await callRoute(routes.get('/volna-tweaks/update/check'), 'POST');
      assert.equal(second.json.state, first.json.state, 'второй ответ — тот же статус');
      assert.equal(second.json.checkedAt, first.json.checkedAt, 'время проверки не сдвинулось');
      assert.equal(stub.calls.length, callsAfterFirst, 'повтор git не зовёт');
      assert.match(readLog(), /note=throttled/, 'троттлинг отмечен в журнале');
    } finally {
      await host.deactivate();
    }
  });

  await test('роуты: чужой метод — 405, тело — тот же конверт', async () => {
    const stub = createGit();
    const { ctx, routes } = createScope();
    host.activate(ctx, { autoUpdate: false }, { dir: ROOT, git: stub.git, hasGit: true, installed: '4.1.0' });
    try {
      const wrongStatus = await callRoute(routes.get('/volna-tweaks/update/status'), 'POST');
      assert.equal(wrongStatus.status, 405);
      assert.equal(wrongStatus.json.ok, false);
      assert.equal(wrongStatus.json.code, 'method-not-allowed');

      const wrongCheck = await callRoute(routes.get('/volna-tweaks/update/check'), 'GET');
      assert.equal(wrongCheck.status, 405);
      assert.equal(wrongCheck.json.ok, false);
      assert.deepEqual(stub.calls, [], 'на чужой метод git не зовётся');
    } finally {
      await host.deactivate();
    }
  });

  await test('состояние: кэш update.json лежит рядом со светофором', async () => {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    assert.equal(path.dirname(CACHE_FILE), path.join(process.env.DSH_HOME, 'dsh-tweaks'), 'каталог как у traffic-light');
    assert.ok(cache.checkedAt, 'время проверки сохранено');
    assert.equal(typeof cache.restartNeeded, 'boolean');
    assert.ok(fs.existsSync(LOG_FILE), 'журнал твика создан');
    assert.equal(fs.readdirSync(STATE_DIR).filter((name) => name.endsWith('.tmp')).length, 0, 'tmp-файлов не осталось');
  });

  await test('restartNeeded: снимается, когда запущенная версия догнала апстрим', async () => {
    // Кэш прошлой проверки: обновление было, работает ещё старая версия.
    assert.equal(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).restartNeeded, true);
    const stub = createGit({ upstreamSha: UPSTREAM_SHA });
    const before = createScope();
    host.activate(before.ctx, { autoUpdate: false }, { dir: ROOT, git: stub.git, hasGit: true, installed: '4.1.0' });
    try {
      const stale = await callRoute(before.routes.get('/volna-tweaks/update/status'), 'GET');
      assert.equal(stale.json.restartNeeded, true, 'старая версия в процессе — перезапуск нужен');
      assert.equal(stale.json.installed, '4.1.0');
      assert.equal(stale.json.upstream, '4.2.0');
    } finally {
      await host.deactivate();
    }
    // Рестарт DSH: installed читается из package.json, который уже обновлён.
    const after = createScope();
    host.activate(after.ctx, { autoUpdate: false }, { dir: ROOT, git: stub.git, hasGit: true, installed: '4.2.0' });
    try {
      const fresh = await callRoute(after.routes.get('/volna-tweaks/update/status'), 'GET');
      assert.equal(fresh.json.restartNeeded, false, 'версии совпали — перезапуск не нужен');
      assert.equal(fresh.json.installed, '4.2.0');
    } finally {
      await host.deactivate();
    }
  });

  await test('расписание: таймеры ставятся только при autoUpdate', async () => {
    const stub = createGit();
    const timersBefore = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    const off = createScope();
    host.activate(off.ctx, { autoUpdate: false }, { dir: ROOT, git: stub.git, hasGit: true, installed: '4.1.0' });
    const timersOff = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    await host.deactivate();
    assert.equal(timersOff, timersBefore, 'выключенный флаг не ставит таймеров');

    const on = createScope();
    host.activate(on.ctx, { autoUpdate: true }, { dir: ROOT, git: stub.git, hasGit: true, installed: '4.1.0' });
    const status = await callRoute(on.routes.get('/volna-tweaks/update/status'), 'GET');
    assert.equal(status.json.autoUpdate, true);
    // Проверки по таймеру не ждём: тест проверяет только снятие состояния.
    await host.deactivate();
    await host.deactivate();
    assert.ok(true, 'повторная деактивация безопасна');
  });

  await test('index.js: поле autoUpdate в схеме и подключение хост-части', () => {
    const source = fs.readFileSync(INDEX_PATH, 'utf8');
    assert.ok(source.includes('autoUpdate: Schema.boolean().default(true).volatile()'), 'поле схемы есть');
    assert.ok(source.includes("const UPDATER_HOST = './tweaks/updater-host.js'"), 'модуль объявлен');
    assert.ok(source.includes('attachUpdater(ctx, config)'), 'хост-часть подключена в apply');
    assert.ok(source.includes("ctx.on('loader/volatile-update'"), 'реакция на volatile-обновление');
  });

  await test('журнал: каждая строка — одно событие', () => {
    const lines = readLog().trim().split('\n');
    assert.ok(lines.length > 0, 'журнал не пуст');
    for (const line of lines) {
      assert.match(line, /^\d{4}-\d{2}-\d{2}T/, `строка журнала начинается с ISO: ${line}`);
      assert.equal(line.includes('  '), false, `двойных пробелов нет: ${line}`);
    }
    assert.match(readLog(), /activate \| /, 'активация отмечена');
    assert.match(readLog(), /check \| state=/, 'проверка отмечена');
  });

  // Настоящий git: заглушка не видит, что fetch плодит shallow-клон. Remote —
  // локальный каталог, поэтому тест не ходит в сеть и не трогает рабочий клон.
  const gitInfo = gitAvailability();
  if (gitInfo.ok !== true) {
    console.log(`skip real-git: git недоступен в тестовом окружении (${gitInfo.reason})`);
  } else {
    await test('real git: клон 1.0.0 и апстрим 2.0.0 — обновление до 2.0.0, клон не shallow', async () => {
      const fixture = createFixture();
      try {
        const before = commitCount(fixture.work);
        const result = await host.checkNow({ dir: fixture.work });
        assert.equal(result.state, 'updated');
        assert.equal(result.reason, 'behind');
        assert.equal(result.updated, true);
        assert.equal(result.upstreamVersion, '2.0.0');
        assert.equal(readPackageVersion(fixture.work), '2.0.0', 'в рабочем каталоге версия апстрима');
        assert.equal(isShallowClone(fixture.work), 'false');
        assert.equal(commitCount(fixture.work), before + 1, 'история не усечена');
      } finally {
        removeTree(fixture.root);
      }
    });

    await test('real git: shallow-клон чинится --unshallow и обновляется', async () => {
      const fixture = createFixture({ shallow: true });
      try {
        assert.equal(isShallowClone(fixture.work), 'true', 'клон действительно shallow');
        assert.equal(readPackageVersion(fixture.work), '1.0.0');
        const result = await host.checkNow({ dir: fixture.work });
        assert.equal(result.state, 'updated', 'без --unshallow merge-base ответил бы «не предок»');
        assert.equal(result.updated, true);
        assert.equal(result.upstreamVersion, '2.0.0');
        assert.equal(readPackageVersion(fixture.work), '2.0.0');
        assert.equal(isShallowClone(fixture.work), 'false', 'история докачана');
      } finally {
        removeTree(fixture.root);
      }
    });

    await test('real git: повторная проверка актуального клона — up-to-date без merge', async () => {
      const fixture = createFixture();
      try {
        const first = await host.checkNow({ dir: fixture.work });
        assert.equal(first.state, 'updated');
        const head = gitRun(fixture.work, ['rev-parse', 'HEAD']).trim();
        const second = await host.checkNow({ dir: fixture.work });
        assert.equal(second.state, 'up-to-date');
        assert.equal(second.reason, 'same');
        assert.equal(second.updated, false);
        assert.equal(gitRun(fixture.work, ['rev-parse', 'HEAD']).trim(), head, 'вершина та же: merge не выполнялся');
        assert.equal(readPackageVersion(fixture.work), '2.0.0');
      } finally {
        removeTree(fixture.root);
      }
    });
  }

  console.log(`PASS ${passed} updater host contract tests`);
})().catch((error) => {
  console.error('FAIL', error);
  process.exitCode = 1;
});
