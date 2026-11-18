import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Хост-половина твика «автообновление из git» (autoUpdate) бандла dsh-tweaks.
 *
 * Зачем: плагин ставится клоном репозитория, и обновление до сих пор было ручным
 * (`git pull` + перезапуск DSH). Здесь хост сам проверяет апстрим и, если
 * обновление сводится к fast-forward, делает его; перезапуск остаётся за
 * человеком (роут отдаёт `restartNeeded`).
 *
 * Что делает:
 *  1. Раз в 6 часов (первая проверка — через минуту после старта) смотрит
 *     `git status --porcelain`, `git fetch --quiet origin`, `HEAD` и `@{u}`.
 *     Fetch без `--depth`: shallow-клон усекает историю и ломает `merge-base`
 *     («не предок» → обновление не выполнялось бы никогда). Если клон уже
 *     shallow (его сделали вручную с `--depth`), сначала `git fetch --unshallow`.
 *  2. Грязное дерево — стоп: ничего не трогаем, состояние `skipped/dirty`.
 *  3. `HEAD` — предок апстрима? Только тогда `git merge --ff-only <sha>`.
 *     Мы впереди или разошлись — `skipped/ahead`: историю не переписываем.
 *  4. Ручная проверка — `POST /volna-tweaks/update/check` (троттлинг 30 с,
 *     повтор отдаёт текущий статус), статус — `GET /volna-tweaks/update/status`.
 *     Роуты живут всегда, а расписание (таймеры) включается только при
 *     `autoUpdate === true`: со снятой галочкой разовая проверка по кнопке
 *     работает, фоновых проверок нет.
 *
 * Запрещено намеренно и не вызывается никогда: `pull --rebase`, `reset`,
 * `checkout`, `clean`, `stash`. Список разрешённых подкоманд лежит в
 * `ALLOWED_COMMANDS`, запрещённые аргументы — в `FORBIDDEN_PREFIXES`; вызов вне
 * списка не запускает процесс вовсе (см. `runGitProcess`). Аргументы всегда
 * массиво постоянных строк и проверенного `sha`, аргументов из интерфейса нет.
 *
 * Состояние: `<корень>/<каталог плагина>/update.json` (кэш статуса, запись
 * атомарная: tmp + rename) и `update.log` (строка на событие, ротация 1 МБ).
 * Корень — `$DSH_HOME`, а при пустой переменной — домашний каталог DSH
 * `~/.dsh` (десктопное приложение `DSH_HOME` не выставляет). Каталог — имя
 * папки плагина: у светофора оно зашито как `dsh-tweaks`, здесь берётся из пути
 * модуля (`~/.dsh/dsh-tweaks` при установке в папку `dsh-tweaks`); имена файлов
 * свои, чужое состояние не трогается.
 *
 * Отказоустойчивость: вся работа в try/catch, исключение не поднимается в
 * загрузчик плагина; отсутствие `.git` — штатное состояние `skipped/no-git`.
 *
 * Интерфейс модуля: `activate(ctx, config, deps)`, `update(config)`,
 * `deactivate()`; для тестов — `decideUpdate`, `buildStatus`, `formatLogLine`,
 * `stateDir`, `checkNow(deps)` и третий аргумент `activate` с подставным `git`.
 *
 * @module dsh-tweaks/updater-host
 */

/** Период плановой проверки апстрима. */
export const CHECK_INTERVAL_MS = 6 * 3600 * 1000;

/** Первая проверка после старта: DSH успевает подняться, сеть — прогреться. */
export const FIRST_CHECK_DELAY_MS = 60_000;

/** Троттлинг ручной проверки: чаще раза в 30 с работу не запускаем. */
export const CHECK_THROTTLE_MS = 30_000;

/** Таймаут `git fetch`: сеть бывает медленной, но не бесконечной. */
export const FETCH_TIMEOUT_MS = 60_000;

/** Таймаут `git merge --ff-only`: локальная операция, дольше ждать незачем. */
export const MERGE_TIMEOUT_MS = 30_000;

/** Таймаут коротких запросов (`status`, `rev-parse`, `merge-base`, `show`). */
const QUERY_TIMEOUT_MS = 15_000;

/** Сколько ждём между `kill` и `SIGKILL` при таймауте дочернего процесса. */
const KILL_ESCALATION_MS = 2_000;

/** Предел накапливаемого stdout/stderr: диагностика нужна, гигабайты — нет. */
const OUTPUT_LIMIT = 64 * 1024;

/** Роут статуса: его опрашивает клиент. */
export const STATUS_PATH = '/volna-tweaks/update/status';

/** Роут ручной проверки. */
export const CHECK_PATH = '/volna-tweaks/update/check';

/** Допустимые состояния статуса. */
const STATES = new Set(['idle', 'checking', 'up-to-date', 'updated', 'skipped', 'error']);

/** Допустимые причины статуса. */
const REASONS = new Set(['behind', 'same', 'dirty', 'ahead', 'no-upstream', 'no-git', 'offline', 'failed']);

/** Разрешённые подкоманды git: всё остальное не запускается. */
const ALLOWED_COMMANDS = new Set(['status', 'fetch', 'rev-parse', 'merge-base', 'merge', 'show']);

/**
 * Начала запрещённых аргументов: перезапись истории и работа с чужими правками.
 *
 * Сравнение по префиксу, а не по точному совпадению: `--force-with-lease`,
 * `-fd`, `--hard=…` при точном сравнении проходили мимо фильтра.
 */
const FORBIDDEN_PREFIXES = [
  'pull',
  'rebase',
  'reset',
  'checkout',
  'switch',
  'restore',
  'clean',
  'stash',
  '--force',
  '--hard',
  '--mirror',
];

/**
 * Запрещён ли аргумент git.
 *
 * Короткий `-f` блокируется, а `--ff-only` — нет: он начинается с `--`, а не с
 * `-f`, поэтому fast-forward merge остаётся разрешённым.
 * @param {string} arg - аргумент командной строки git.
 * @returns {boolean} true — команду запускать нельзя.
 */
export function isForbiddenArg(arg) {
  const value = String(arg).toLowerCase();
  if (value === '') return false;
  if (FORBIDDEN_PREFIXES.some((prefix) => value.startsWith(prefix))) return true;
  return value.startsWith('-f');
}

/** Полный или сокращённый sha: только такое значение уходит в `git merge`/`show`. */
const SHA = /^[0-9a-f]{7,64}$/;

/** Каталог модуля (`<плагин>/tweaks`): рядом лежат остальные хост-части. */
const MODULE_DIR =
  typeof import.meta.dirname === 'string' && import.meta.dirname !== ''
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

/** Каталог плагина — родитель `tweaks/`: там `.git` и `package.json`. */
export const PLUGIN_DIR = dirname(MODULE_DIR);

/** Одно активное состояние хост-половины. */
let runtime = null;

/**
 * Служба контекста по имени; доступ защищён — службы может не быть.
 * @param {object} ctx - контекст плагина.
 * @param {string} name - имя службы.
 * @returns {*} служба либо undefined.
 */
function serviceOf(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch (_error) {
    return undefined;
  }
}

/**
 * Корень файлов состояния: `$DSH_HOME`, а при пустой переменной — домашний
 * каталог DSH `~/.dsh`.
 * @param {object} [options] - подстановки для тестов.
 * @param {object} [options.vars] - переменные окружения (по умолчанию `process.env`).
 * @param {Function} [options.home] - получение домашнего каталога (по умолчанию `os.homedir`).
 * @returns {string | null} корень либо null, если домашний каталог недоступен.
 */
function stateRoot(options = {}) {
  const plain = options !== null && typeof options === 'object' ? options : {};
  const vars = plain.vars !== undefined ? plain.vars : typeof process === 'object' ? process?.env : undefined;
  const home = typeof vars?.DSH_HOME === 'string' ? vars.DSH_HOME : '';
  if (home !== '') return home;
  const readHome = typeof plain.home === 'function' ? plain.home : homedir;
  let dir = '';
  try {
    dir = readHome();
  } catch (_error) {
    return null;
  }
  return typeof dir === 'string' && dir !== '' ? join(dir, '.dsh') : null;
}

/**
 * Каталог состояния твика в домашней папке DSH: имя — как у папки плагина
 * (у светофора то же имя зашито константой `dsh-tweaks`).
 *
 * Фолбэк на `~/.dsh` нужен потому, что десктопное приложение DSH переменную
 * `DSH_HOME` не выставляет: раньше функция молча отдавала null и в живом
 * приложении не появлялось ни `update.json`, ни `update.log`. Недоступный или
 * нечисловой домашний каталог — тихий null, исключение не поднимается.
 * @param {object} [options] - подстановки для тестов (см. `stateRoot`).
 * @returns {string | null} каталог либо null.
 */
export function stateDir(options = {}) {
  const root = stateRoot(options);
  if (root === null) return null;
  return join(root, basename(PLUGIN_DIR) || 'dsh-tweaks');
}

/**
 * Дописать строку в журнал твика; при ошибках — тихо (диск бывает недоступен).
 * @param {string} line - готовая строка без перевода строки.
 * @returns {void}
 */
function appendLogFile(line) {
  const dir = stateDir();
  if (dir === null) return;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'update.log');
    try {
      if (statSync(file).size > 1024 * 1024) renameSync(file, `${file}.1`);
    } catch (_error) {
      /* файла ещё нет — ротировать нечего */
    }
    appendFileSync(file, `${line}\n`);
  } catch (_error) {
    /* журнал не пишем, работу продолжаем */
  }
}

/**
 * Прочитать кэш статуса `update.json` (после рестарта панель сразу знает
 * прошлую проверку). Битый или отсутствующий файл — пустой кэш.
 * @returns {object} кэш либо пустой объект.
 */
function loadCache() {
  const dir = stateDir();
  if (dir === null) return {};
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'update.json'), 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

/**
 * Записать кэш статуса атомарно: tmp-файл + rename.
 * @param {object} payload - то, что переживёт рестарт.
 * @returns {void}
 */
function saveCache(payload) {
  const dir = stateDir();
  if (dir === null) return;
  const file = join(dir, 'update.json');
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, file);
  } catch (_error) {
    /* кэш не записался: состояние остаётся в памяти */
  }
}

/**
 * Версия пакета из `package.json` каталога плагина.
 * @param {string} dir - каталог плагина.
 * @returns {string | null} версия либо null.
 */
export function readInstalledVersion(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return typeof parsed?.version === 'string' && parsed.version !== '' ? parsed.version : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Мгновение из числа или ISO-строки; неизвестное — null.
 * @param {unknown} value - миллисекунды эпохи либо ISO.
 * @returns {string | null} ISO-строка либо null.
 */
function isoOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

/**
 * Строка версии или null: пустое значение и не строка версией не считаются.
 * @param {unknown} value - значение.
 * @returns {string | null} версия либо null.
 */
function versionOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Решение по состоянию дерева: тянуть, ничего не делать или пропустить.
 *
 * Порядок важен: грязное дерево и отсутствие апстрима отменяют любую работу
 * (ничего не трогаем), равенство вершин — «уже обновлено», и только строгое
 * «мы позади» даёт `pull`. «Впереди» и «разошлись» одинаково дают `skipped`:
 * история не переписывается никогда.
 * @param {object} input - состояние репозитория.
 * @param {string} [input.head] - sha текущей вершины.
 * @param {string} [input.upstream] - sha вершины апстрима.
 * @param {boolean} [input.dirty] - есть ли изменения в рабочем дереве.
 * @param {boolean} [input.behind] - является ли `head` предком `upstream`.
 * @param {boolean} [input.ahead] - есть ли свои коммиты поверх апстрима.
 * @returns {{action: 'pull' | 'up-to-date' | 'skip', reason: string}} решение.
 */
export function decideUpdate(input = {}) {
  const head = typeof input.head === 'string' ? input.head.trim() : '';
  const upstream = typeof input.upstream === 'string' ? input.upstream.trim() : '';
  if (input.dirty === true) return { action: 'skip', reason: 'dirty' };
  if (head === '' || upstream === '') return { action: 'skip', reason: 'no-upstream' };
  if (head === upstream) return { action: 'up-to-date', reason: 'same' };
  // Свои коммиты поверх апстрима (в том числе расхождение) — не трогаем.
  if (input.ahead === true) return { action: 'skip', reason: 'ahead' };
  if (input.behind === true) return { action: 'pull', reason: 'behind' };
  return { action: 'skip', reason: 'ahead' };
}

/**
 * Собрать payload статуса ровно по контракту клиента.
 *
 * Лишних полей не добавляем: клиент читает фиксированный набор, а `ok:false`
 * появляется только в конверте ошибки роута.
 * @param {object} [fields] - значения статуса.
 * @returns {object} payload.
 */
export function buildStatus(fields = {}) {
  return {
    ok: true,
    installed: versionOrNull(fields.installed),
    upstream: versionOrNull(fields.upstream),
    checkedAt: isoOrNull(fields.checkedAt),
    updatedAt: isoOrNull(fields.updatedAt),
    restartNeeded: fields.restartNeeded === true,
    state: STATES.has(fields.state) ? fields.state : 'idle',
    reason: REASONS.has(fields.reason) ? fields.reason : null,
    intervalHours: CHECK_INTERVAL_MS / 3600_000,
    autoUpdate: fields.autoUpdate !== false,
  };
}

/**
 * Строка журнала на событие: одна строка, поля через ` | `.
 * @param {object} [entry] - событие.
 * @returns {string} строка без перевода строки.
 */
export function formatLogLine(entry = {}) {
  const at = isoOrNull(entry.at) ?? new Date().toISOString();
  const parts = [at, String(entry.event ?? 'check')];
  const fields = ['state', 'reason', 'head', 'upstream', 'note'];
  for (const field of fields) {
    const value = versionOrNull(entry[field]);
    if (value === null) continue;
    parts.push(`${field}=${value.replace(/\s+/g, '_')}`);
  }
  return parts.join(' | ');
}

/**
 * Ответ JSON без кеширования.
 * @param {object} res - ответ Node.
 * @param {number} status - HTTP-статус.
 * @param {object} payload - тело.
 * @returns {void}
 */
function sendJson(res, status, payload) {
  if (res === null || typeof res !== 'object') return;
  res.statusCode = status;
  try {
    res.setHeader?.('content-type', 'application/json; charset=utf-8');
    res.setHeader?.('cache-control', 'no-store');
  } catch (_error) {
    /* заголовки уже отправлены — тело всё равно отдадим */
  }
  res.end(JSON.stringify(payload));
}

/**
 * Запустить git без shell и вернуть результат, не бросая исключений.
 *
 * Защита до спавна: неизвестная подкоманда и запрещённый префикс в аргументах
 * (см. `isForbiddenArg`) дают `blocked-command`, процесс не создаётся. Таймаут убивает дочерний
 * процесс (`SIGTERM`, затем `SIGKILL` через 2 с) и разрешает промис с
 * `timedOut: true` — проверка не зависает на мёртвой сети.
 * @param {string[]} args - аргументы git (первый — подкоманда).
 * @param {number} timeoutMs - предел ожидания.
 * @param {string} cwd - рабочий каталог (каталог плагина).
 * @returns {Promise<{ok: boolean, code: number | null, out: string, err: string, timedOut: boolean}>} результат.
 */
export function runGitProcess(args, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const list = Array.isArray(args) ? args.filter((arg) => typeof arg === 'string') : [];
    const blocked =
      list.length === 0 || !ALLOWED_COMMANDS.has(list[0]) || list.some(isForbiddenArg);
    if (blocked) {
      resolve({ ok: false, code: null, out: '', err: `blocked-command:${list.join(' ')}`, timedOut: false });
      return;
    }
    let child;
    try {
      child = spawn('git', list, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, code: null, out: '', err: String(error?.message ?? error), timedOut: false });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch (_error) {
        /* процесс уже умер */
      }
      const escalate = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_error) {
          /* процесс уже умер */
        }
      }, KILL_ESCALATION_MS);
      escalate.unref?.();
      finish({ ok: false, code: null, out: '', err: 'timeout', timedOut: true });
    }, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : QUERY_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => {
      if (out.length < OUTPUT_LIMIT) out += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (err.length < OUTPUT_LIMIT) err += String(chunk);
    });
    child.on('error', (error) => {
      finish({ ok: false, code: null, out: '', err: String(error?.message ?? error), timedOut });
    });
    child.on('close', (code) => {
      const clean = typeof code === 'number' ? code : null;
      finish({ ok: clean === 0 && timedOut !== true, code: clean, out, err, timedOut });
    });
  });
}

/**
 * Версия пакета в апстриме: `git show <sha>:package.json`.
 *
 * Отсутствие файла или битый JSON не ошибка проверки — просто `null`.
 * @param {Function} git - запуск git `(args, timeoutMs) → результат`.
 * @param {string} sha - проверенная вершина апстрима.
 * @returns {Promise<string | null>} версия либо null.
 */
async function readUpstreamVersion(git, sha) {
  const shown = await git(['show', `${sha}:package.json`], QUERY_TIMEOUT_MS);
  if (shown?.ok !== true) return null;
  try {
    const parsed = JSON.parse(String(shown.out ?? ''));
    return versionOrNull(parsed?.version);
  } catch (_error) {
    return null;
  }
}

/**
 * Одна проверка апстрима: от грязного дерева до fast-forward.
 *
 * Функция без побочных эффектов рантайма: git и каталог приходят снаружи,
 * поэтому тесты подставляют заглушку и не трогают сеть и настоящий репозиторий.
 * @param {object} [deps] - зависимости.
 * @param {string} [deps.dir] - каталог плагина.
 * @param {Function} [deps.git] - запуск git `(args, timeoutMs) → результат`.
 * @param {boolean} [deps.hasGit] - есть ли `.git` (иначе считается по диску).
 * @param {number} [deps.now] - текущее время, мс.
 * @returns {Promise<object>} результат проверки для рантайма.
 */
export async function checkNow(deps = {}) {
  const dir = typeof deps.dir === 'string' && deps.dir !== '' ? deps.dir : PLUGIN_DIR;
  const git =
    typeof deps.git === 'function'
      ? deps.git
      : (args, timeoutMs) => runGitProcess(args, typeof timeoutMs === 'number' ? timeoutMs : QUERY_TIMEOUT_MS, dir);
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const hasGit = typeof deps.hasGit === 'boolean' ? deps.hasGit : existsSync(join(dir, '.git'));
  /** Собрать результат проверки с общими пустыми полями. */
  const result = (state, reason, action, extra = {}) => ({
    state,
    reason,
    action,
    head: '',
    upstreamSha: '',
    upstreamVersion: null,
    updated: false,
    note: null,
    ...extra,
  });

  try {
    if (hasGit !== true) return result('skipped', 'no-git', 'skip');

    const workTree = await git(['status', '--porcelain'], QUERY_TIMEOUT_MS);
    if (workTree?.ok !== true) return result('error', 'failed', 'skip', { note: workTree?.timedOut === true ? 'status-timeout' : 'status' });
    // Грязное дерево: чужие правки не трогаем и апстрим не тянем.
    if (String(workTree.out ?? '').trim() !== '') return result('skipped', 'dirty', 'skip');

    // Shallow-клон (его мог сделать ручной `clone --depth`) ломает merge-base:
    // на усечённой истории он отвечает «не предок». Историю докачиваем, таймаут
    // тот же, что у fetch; без `git` ≥2.15 команда просто не сработает — это не
    // ошибка, дальше идёт обычный путь.
    const shallowRun = await git(['rev-parse', '--is-shallow-repository'], QUERY_TIMEOUT_MS);
    const isShallow = String(shallowRun?.out ?? '').trim() === 'true';
    if (isShallow) {
      const unshallowed = await git(['fetch', '--quiet', '--unshallow', 'origin'], FETCH_TIMEOUT_MS);
      if (unshallowed?.ok !== true) {
        return result('error', 'offline', 'skip', { note: unshallowed?.timedOut === true ? 'fetch-timeout' : 'fetch' });
      }
    }

    // Обычный fetch без `--depth`: он не делает клон shallow и не усекает историю.
    const fetched = await git(['fetch', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
    if (fetched?.ok !== true) return result('error', 'offline', 'skip', { note: fetched?.timedOut === true ? 'fetch-timeout' : 'fetch' });

    const headRun = await git(['rev-parse', 'HEAD'], QUERY_TIMEOUT_MS);
    const head = headRun?.ok === true ? String(headRun.out ?? '').trim() : '';
    if (!SHA.test(head)) return result('error', 'failed', 'skip', { note: 'head' });

    // Сначала `@{u}`, затем `origin/main`: у клона мог не остаться upstream-конфига.
    let upstreamSha = '';
    const tracking = await git(['rev-parse', '--verify', '@{u}'], QUERY_TIMEOUT_MS);
    if (tracking?.ok === true) upstreamSha = String(tracking.out ?? '').trim();
    if (!SHA.test(upstreamSha)) {
      const fallback = await git(['rev-parse', '--verify', 'origin/main'], QUERY_TIMEOUT_MS);
      if (fallback?.ok === true) upstreamSha = String(fallback.out ?? '').trim();
    }
    if (!SHA.test(upstreamSha)) return result('skipped', 'no-upstream', 'skip', { head });

    const ancestor = await git(['merge-base', '--is-ancestor', head, upstreamSha], QUERY_TIMEOUT_MS);
    // Код 1 — «не предок», это штатный ответ; null означает сбой запуска.
    if (ancestor?.code !== 0 && ancestor?.code !== 1) {
      return result('error', 'failed', 'skip', { head, upstreamSha, note: 'merge-base' });
    }
    const behind = ancestor.code === 0 && head !== upstreamSha;
    const ahead = head !== upstreamSha && behind !== true;
    const upstreamVersion = await readUpstreamVersion(git, upstreamSha);
    const decision = decideUpdate({ head, upstream: upstreamSha, dirty: false, behind, ahead });
    const base = { head, upstreamSha, upstreamVersion };

    if (decision.action === 'pull') {
      const merged = await git(['merge', '--ff-only', upstreamSha], MERGE_TIMEOUT_MS);
      if (merged?.ok !== true) {
        return result('error', 'failed', 'skip', { ...base, note: merged?.timedOut === true ? 'merge-timeout' : 'merge' });
      }
      return result('updated', 'behind', 'pull', { ...base, updated: true, at: now });
    }
    if (decision.action === 'up-to-date') return result('up-to-date', 'same', 'up-to-date', base);
    return result('skipped', decision.reason, 'skip', base);
  } catch (error) {
    return result('error', 'failed', 'skip', { note: String(error?.message ?? error) });
  }
}

/**
 * Снять `restartNeeded`, когда запущенная версия догнала апстрим.
 *
 * Версия из диска после merge уже новая, поэтому `installed` снимается один раз
 * при активации: это версия кода, который реально работает в процессе.
 * @param {object} state - состояние хост-половины.
 * @returns {void}
 */
function syncRestartNeeded(state) {
  if (state.restartNeeded !== true) return;
  if (state.installed === null || state.upstreamVersion === null) return;
  if (state.installed === state.upstreamVersion) state.restartNeeded = false;
}

/**
 * Payload статуса по текущему состоянию.
 * @param {object | null} state - состояние хост-половины.
 * @returns {object} payload.
 */
function statusOf(state) {
  if (state === null) return buildStatus({ state: 'error', reason: 'failed', autoUpdate: false });
  syncRestartNeeded(state);
  return buildStatus({
    installed: state.installed,
    upstream: state.upstreamVersion,
    checkedAt: state.checkedAt,
    updatedAt: state.updatedAt,
    restartNeeded: state.restartNeeded,
    state: state.state,
    reason: state.reason,
    autoUpdate: state.autoUpdate,
  });
}

/**
 * Записать событие в журнал твика.
 * @param {object} state - состояние хост-половины.
 * @param {object} entry - поля события.
 * @returns {void}
 */
function logEvent(state, entry) {
  appendLogFile(formatLogLine({ ...entry, at: Date.now() }));
}

/**
 * Сохранить кэш статуса, чтобы панель сразу знала прошлую проверку.
 * @param {object} state - состояние хост-половины.
 * @returns {void}
 */
function storeCache(state) {
  saveCache({
    checkedAt: isoOrNull(state.checkedAt),
    updatedAt: isoOrNull(state.updatedAt),
    upstreamVersion: state.upstreamVersion,
    restartNeeded: state.restartNeeded === true,
    state: STATES.has(state.state) ? state.state : 'idle',
    reason: REASONS.has(state.reason) ? state.reason : null,
  });
}

/**
 * Перенести результат проверки в состояние и записать его на диск.
 * @param {object} state - состояние хост-половины.
 * @param {object} result - результат `checkNow`.
 * @returns {void}
 */
function applyResult(state, result) {
  state.state = STATES.has(result?.state) ? result.state : 'error';
  state.reason = REASONS.has(result?.reason) ? result.reason : 'failed';
  state.head = typeof result?.head === 'string' ? result.head : '';
  state.upstreamVersion = versionOrNull(result?.upstreamVersion);
  state.checkedAt = Date.now();
  if (result?.updated === true) {
    state.updatedAt = Date.now();
    state.restartNeeded = true;
  }
  syncRestartNeeded(state);
  storeCache(state);
  logEvent(state, {
    event: 'check',
    state: state.state,
    reason: state.reason,
    head: state.head,
    upstream: state.upstreamVersion,
    note: typeof result?.note === 'string' ? result.note : null,
  });
}

/**
 * Запустить проверку: одна за раз, с необязательным троттлингом ручного вызова.
 * @param {object} state - состояние хост-половины.
 * @param {object} [options] - поведение.
 * @param {boolean} [options.throttle] - не запускать чаще `CHECK_THROTTLE_MS`.
 * @returns {Promise<object>} payload статуса после проверки.
 */
function runCheck(state, options = {}) {
  if (state.running !== null) return state.running;
  if (
    options.throttle === true &&
    state.lastCheckAt !== 0 &&
    Date.now() - state.lastCheckAt < CHECK_THROTTLE_MS
  ) {
    logEvent(state, { event: 'check', state: state.state, reason: state.reason, note: 'throttled' });
    return Promise.resolve(statusOf(state));
  }
  state.lastCheckAt = Date.now();
  state.state = 'checking';
  const task = (async () => {
    let result;
    try {
      result = await checkNow({ dir: state.dir, git: state.git ?? undefined, hasGit: state.hasGit, now: Date.now() });
    } catch (error) {
      result = { state: 'error', reason: 'failed', note: String(error?.message ?? error) };
    }
    applyResult(state, result);
    return statusOf(state);
  })();
  state.running = task;
  const clear = () => {
    if (state.running === task) state.running = null;
  };
  task.then(clear, clear);
  return task;
}

/**
 * Поставить плановые проверки: первая через минуту, дальше раз в 6 часов.
 * Таймеры `unref`-нутые: плагин не держит процесс DSH живым.
 * @param {object} state - состояние хост-половины.
 * @returns {void}
 */
function scheduleTimers(state) {
  if (state.autoUpdate !== true) return;
  if (state.firstTimer !== null || state.interval !== null) return;
  state.firstTimer = setTimeout(() => {
    state.firstTimer = null;
    void runCheck(state);
  }, FIRST_CHECK_DELAY_MS);
  state.firstTimer.unref?.();
  state.interval = setInterval(() => void runCheck(state), CHECK_INTERVAL_MS);
  state.interval.unref?.();
}

/**
 * Снять плановые проверки.
 * @param {object} state - состояние хост-половины.
 * @returns {void}
 */
function stopTimers(state) {
  if (state.firstTimer !== null) clearTimeout(state.firstTimer);
  if (state.interval !== null) clearInterval(state.interval);
  state.firstTimer = null;
  state.interval = null;
}

/**
 * Обработчик роута: проверка метода, отказ штатного фильтра, JSON-конверт.
 * @param {object} scope - контекст с webServer/connection.
 * @param {'GET' | 'POST'} method - разрешённый метод.
 * @returns {Function} обработчик `(req, res)`.
 */
function makeHandler(scope, method) {
  return async function handler(req, res) {
    try {
      const rejection = typeof scope?.connection?.requestRejection === 'function' ? scope.connection.requestRejection(req) : undefined;
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end();
        return;
      }
    } catch (_error) {
      /* фильтр необязателен: роут и без него закрыт connection-слоем */
    }
    if (String(req?.method ?? '').toUpperCase() !== method) {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: `${method} required` });
      return;
    }
    try {
      const status = method === 'POST' && runtime !== null ? await runCheck(runtime, { throttle: true }) : statusOf(runtime);
      sendJson(res, 200, status);
    } catch (error) {
      // Тот же конверт с `ok: false`: клиент читает одно тело, а не коды.
      sendJson(res, 200, { ...statusOf(runtime), ok: false, message: String(error?.message ?? error) });
    }
  };
}

/**
 * Зарегистрировать оба роута: `ctx.inject` привязывает их к жизни плагина.
 * @param {object} ctx - хост-контекст плагина.
 * @returns {void}
 */
function registerRoutes(ctx) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['webServer', 'connection'], (scope) => {
    const effect = typeof scope?.effect === 'function' ? scope.effect.bind(scope) : null;
    const register = (path, method, note) => {
      const route = { kind: 'exact', path, handler: makeHandler(scope, method) };
      if (effect !== null) effect(() => scope.webServer.register(route), note);
      else scope.webServer.register(route);
    };
    register(STATUS_PATH, 'GET', 'volna-tweaks: update status route');
    register(CHECK_PATH, 'POST', 'volna-tweaks: update check route');
  });
}

/**
 * Включить хост-половину.
 *
 * Модуль подключается всегда (роуты ручной проверки живут независимо от
 * галочки), а `autoUpdate` управляет только расписанием: `scheduleTimers`
 * смотрит на флаг, `update` включает и снимает таймеры на ходу.
 *
 * Без `.git` (пакет распакован из архива) твик остаётся работоспособным:
 * состояние `skipped/no-git` и никаких исключений.
 * @param {object} ctx - контекст плагина.
 * @param {object} config - плоская конфигурация твика.
 * @param {object} [deps] - подстановки для тестов (`git`, `dir`, `hasGit`, `installed`).
 * @returns {void}
 */
export function activate(ctx, config, deps = {}) {
  if (runtime !== null) return;
  const plain = config !== null && typeof config === 'object' ? config : {};
  const dir = typeof deps.dir === 'string' && deps.dir !== '' ? deps.dir : PLUGIN_DIR;
  const state = {
    ctx,
    dir,
    git: typeof deps.git === 'function' ? deps.git : null,
    hasGit: typeof deps.hasGit === 'boolean' ? deps.hasGit : undefined,
    installed:
      typeof deps.installed === 'string' || deps.installed === null ? deps.installed : readInstalledVersion(dir),
    autoUpdate: plain.autoUpdate !== false,
    upstreamVersion: null,
    head: '',
    state: 'idle',
    reason: null,
    checkedAt: null,
    updatedAt: null,
    restartNeeded: false,
    lastCheckAt: 0,
    running: null,
    firstTimer: null,
    interval: null,
  };
  runtime = state;

  const cache = loadCache();
  state.checkedAt = isoOrNull(cache.checkedAt);
  state.updatedAt = isoOrNull(cache.updatedAt);
  state.upstreamVersion = versionOrNull(cache.upstreamVersion);
  state.restartNeeded = cache.restartNeeded === true;
  // `checking` после падения процесса не восстанавливаем: проверки не идёт.
  if (STATES.has(cache.state) && cache.state !== 'checking') state.state = cache.state;
  if (REASONS.has(cache.reason)) state.reason = cache.reason;
  syncRestartNeeded(state);

  try {
    registerRoutes(ctx);
  } catch (error) {
    logEvent(state, { event: 'routes', note: String(error?.message ?? error) });
  }
  storeCache(state);
  logEvent(state, { event: 'activate', state: state.state, upstream: state.upstreamVersion, note: `auto=${state.autoUpdate === true ? 'on' : 'off'}` });
  scheduleTimers(state);
}

/**
 * Применить новую конфигурацию без перезапуска: включение и выключение
 * расписания. Уже идущая проверка не прерывается.
 * @param {object} config - плоская конфигурация твика.
 * @returns {void}
 */
export function update(config) {
  if (runtime === null) return;
  const plain = config !== null && typeof config === 'object' ? config : {};
  const next = plain.autoUpdate !== false;
  if (next === runtime.autoUpdate) return;
  runtime.autoUpdate = next;
  if (next) scheduleTimers(runtime);
  else stopTimers(runtime);
  storeCache(runtime);
  logEvent(runtime, { event: 'schedule', state: runtime.state, note: next ? 'on' : 'off' });
}

/**
 * Выключить хост-половину: снять таймеры и дождаться текущей проверки
 * (merge мог идти — бросать его на середине нельзя).
 * @returns {Promise<void>}
 */
export async function deactivate() {
  const state = runtime;
  if (state === null) return;
  runtime = null;
  stopTimers(state);
  logEvent(state, { event: 'stop', state: state.state });
  try {
    await state.running;
  } catch (_error) {
    /* проверка уже сообщила о своей ошибке в журнал */
  }
}
