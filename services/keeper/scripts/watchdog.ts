/**
 * Operator watchdog: looks at the keeper's status.json and, when ATTESTOR_HEALTH_URL is set, at
 * the attestor's public health (GET /v1/attestor), prints what is wrong and exits non-zero when
 * something is. Meant for cron, every minute or two, next to the keeper (README, "Watchdog").
 *
 *   node services/keeper/scripts/watchdog.ts
 *
 * Env:
 *   STATE_FILE            the keeper's state file; status.json is read from the same folder (like status.ts).
 *   ATTESTOR_HEALTH_URL   optional, e.g. https://<attestor-worker>/v1/attestor
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *                         optional, both needed: the problems are posted to that chat, and only when the
 *                         set of problems changed since the last run (plus one "all clear" after them).
 *                         The token is never printed.
 *   WATCHDOG_STATE_FILE   where the last set of problems is remembered (default: watchdog-state.json
 *                         next to status.json). Used only with Telegram.
 *
 * No dependency beyond Node itself (fetch, fs): the file also runs on its own, copied anywhere with
 * Node 22.18 or newer. Exit code: 0 all fine, 1 problems found, 2 the watchdog itself failed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** status.json is rewritten every second by a running keeper. */
export const STATUS_MAX_AGE_MS = 3 * 60_000;
/** A keeper with rounds to serve does something (create, fill, strike, settle, claim, ...) far more often than this. */
export const ACTION_MAX_AGE_MS = 5 * 60_000;
export const KEEPER_MIN_LAMPORTS = 200_000_000n;
export const HOUSE_VAULT_MIN_LAMPORTS = 100_000_000n;
/** The signing rate of the attestor is judged from this many attests on. */
export const SIGNED_MIN_ATTESTS = 10;
export const SIGNED_MIN_RATIO = 0.8;
/** The keeper's devnet clock estimate normally sits within 2 s of the truth; beyond this strike and exit windows drift. */
export const CLOCK_OFFSET_MAX_MS = 3_000;

export type Problem = { code: string; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lamports as the keeper writes them (a decimal string; a plain integer is accepted too), or null. */
function lamportsOf(value: unknown): bigint | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function sol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '').padEnd(3, '0');
  return `${whole}.${frac} SOL`;
}

function age(ms: number): string {
  const secs = Math.floor(ms / 1000);
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/**
 * What is wrong, given the parsed status.json (null when it could not be read), the parsed
 * attestor health (null when not asked for) and the time. The order of the list is fixed.
 * A status.json that is missing or stale is reported alone: its other numbers are not current.
 */
export function evaluate(status: unknown, attestorHealth: unknown, now: number): Problem[] {
  const problems: Problem[] = [];
  const keeper = isRecord(status) ? status : null;
  if (!keeper) {
    problems.push({ code: 'status_missing', message: 'status.json is missing or not readable: the keeper is not running here, or STATE_FILE points elsewhere' });
  } else {
    const updatedAt = typeof keeper.updatedAt === 'string' ? Date.parse(keeper.updatedAt) : Number.NaN;
    if (!Number.isFinite(updatedAt)) {
      problems.push({ code: 'status_stale', message: 'status.json has no valid updatedAt' });
    } else if (now - updatedAt >= STATUS_MAX_AGE_MS) {
      problems.push({ code: 'status_stale', message: `status.json is ${age(now - updatedAt)} old: the keeper is stopped or stuck` });
    } else {
      problems.push(...statusProblems(keeper, now));
    }
  }
  problems.push(...attestorProblems(attestorHealth));
  return problems;
}

function statusProblems(status: Record<string, unknown>, now: number): Problem[] {
  const problems: Problem[] = [];

  // Rounds exist and the keeper has done nothing for a while (a paused arena creates nothing, so it is left out).
  const next = lamportsOf(status.nextRoundId);
  const roundsExist = (next !== null && next > 0n) || (status.lastRoundId !== null && status.lastRoundId !== undefined);
  if (roundsExist && status.paused !== true) {
    const last = typeof status.lastSuccessfulActionAt === 'string' ? Date.parse(status.lastSuccessfulActionAt) : Number.NaN;
    const started = typeof status.startedAt === 'string' ? Date.parse(status.startedAt) : Number.NaN;
    if (Number.isFinite(last)) {
      if (now - last >= ACTION_MAX_AGE_MS) problems.push({ code: 'no_recent_action', message: `last successful action ${age(now - last)} ago` });
    } else if (!Number.isFinite(started) || now - started >= ACTION_MAX_AGE_MS) {
      problems.push({ code: 'no_recent_action', message: 'no successful action since the keeper started' });
    }
  }

  const keeperLamports = lamportsOf(status.keeperLamports);
  if (keeperLamports !== null && keeperLamports < KEEPER_MIN_LAMPORTS) {
    problems.push({ code: 'keeper_low_balance', message: `keeper wallet holds ${sol(keeperLamports)} (alarm below ${sol(KEEPER_MIN_LAMPORTS)}): no round can be served without it` });
  }
  const vault = lamportsOf(status.houseVaultAvailable);
  if (vault !== null && vault < HOUSE_VAULT_MIN_LAMPORTS) {
    problems.push({ code: 'house_vault_low', message: `house vault has ${sol(vault)} available (alarm below ${sol(HOUSE_VAULT_MIN_LAMPORTS)}): the house cannot top up lone bets` });
  }
  const offset = status.chainClockOffsetMs;
  if (typeof offset === 'number' && Number.isFinite(offset) && Math.abs(offset) > CLOCK_OFFSET_MAX_MS) {
    problems.push({ code: 'clock_offset', message: `devnet clock offset is ${offset} ms (alarm beyond ${CLOCK_OFFSET_MAX_MS} ms): check NTP on this host` });
  }
  return problems;
}

function attestorProblems(health: unknown): Problem[] {
  const problems: Problem[] = [];
  if (!isRecord(health)) return problems;
  const oracle = health.oracle;
  if (isRecord(oracle) && oracle.matchesKey === false) {
    problems.push({ code: 'attestor_key_mismatch', message: "the attestor Worker's key is not the attestor in OracleConfig: every attest is refused" });
  }
  const attests = health.attests;
  if (isRecord(attests) && typeof attests.attests === 'number' && typeof attests.signed === 'number' && attests.attests >= SIGNED_MIN_ATTESTS) {
    if (attests.signed / attests.attests < SIGNED_MIN_RATIO) {
      problems.push({
        code: 'attestor_signing_low',
        message: `the attestor signed ${attests.signed} of ${attests.attests} attests (alarm below ${SIGNED_MIN_RATIO * 100}%): look at attest_refused in the keeper log`,
      });
    }
  }
  return problems;
}

// ---- Telegram: tell once per change ----------------------------------------------------------

export type Notice = { notify: boolean; kind: 'problems' | 'recovered' | null; key: string };

/** The set of problems as a stable text: codes only, so a growing age in a message is not a change. */
const keyOf = (problems: readonly Problem[]): string => [...new Set(problems.map((p) => p.code))].sort().join(',');

/**
 * Whether to post: when the set of problems differs from the one remembered from the last run.
 * Nothing is posted for a first run without problems, and a set that has gone back to empty gets
 * one "all clear". `previous` is the remembered key (null: no earlier run).
 */
export function decideNotice(problems: readonly Problem[], previous: string | null): Notice {
  const key = keyOf(problems);
  if (key === (previous ?? '')) return { notify: false, kind: null, key };
  return { notify: true, kind: problems.length > 0 ? 'problems' : 'recovered', key };
}

export function formatNotice(problems: readonly Problem[], kind: 'problems' | 'recovered'): string {
  if (kind === 'recovered') return 'FlipTheMeme keeper watchdog: all clear again.';
  const head = `FlipTheMeme keeper watchdog: ${problems.length} problem${problems.length === 1 ? '' : 's'}`;
  return [head, ...problems.map((p) => `- ${p.code}: ${p.message}`)].join('\n');
}

// ---- the script ------------------------------------------------------------------------------

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value)}\n`;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body);
  try {
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, body);
  }
}

/**
 * Posts the problems through `post` when their set changed since the last run, remembered in
 * `memoryFile`. The new set is remembered only once `post` returned true, so a failed post is
 * tried again on the next run.
 */
export async function notify(opts: {
  problems: readonly Problem[];
  memoryFile: string;
  post: (text: string) => Promise<boolean>;
}): Promise<'sent' | 'silent' | 'failed'> {
  const last = readJson(opts.memoryFile);
  const previous = isRecord(last) && typeof last.problems === 'string' ? last.problems : null;
  const notice = decideNotice(opts.problems, previous);
  if (!notice.notify || !notice.kind) return 'silent';
  if (!(await opts.post(formatNotice(opts.problems, notice.kind)))) return 'failed';
  writeJson(opts.memoryFile, { problems: notice.key, at: new Date().toISOString() });
  return 'sent';
}

/** The attestor's health body, or a problem when it cannot be had. */
async function fetchHealth(url: string): Promise<{ health: unknown; problem: Problem | null }> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) return { health: body, problem: { code: 'attestor_unreachable', message: `GET ${hostOf(url)} answered HTTP ${res.status}` } };
    if (!isRecord(body)) return { health: null, problem: { code: 'attestor_unreachable', message: `GET ${hostOf(url)} did not answer with JSON` } };
    return { health: body, problem: null };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'error';
    return { health: null, problem: { code: 'attestor_unreachable', message: `GET ${hostOf(url)} failed (${name})` } };
  }
}

/** Only the host goes into messages: a URL may carry a path or key. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'ATTESTOR_HEALTH_URL';
  }
}

/** Posts to the chat. Never throws a message that could hold the token; returns whether Telegram accepted it. */
async function postToTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`telegram: HTTP ${res.status}`);
    return res.ok;
  } catch (error) {
    console.error(`telegram: request failed (${error instanceof Error ? error.name : 'error'})`);
    return false;
  }
}

async function main(): Promise<number> {
  const packageDir = fileURLToPath(new URL('..', import.meta.url));
  const stateFile = resolve(process.env.STATE_FILE?.trim() || join(packageDir, 'keeper-state.json'));
  const statusFile = join(dirname(stateFile), 'status.json');
  const healthUrl = process.env.ATTESTOR_HEALTH_URL?.trim() || null;

  const status = readJson(statusFile);
  const found = healthUrl ? await fetchHealth(healthUrl) : { health: null, problem: null };
  const problems = [...evaluate(status, found.health, Date.now()), ...(found.problem ? [found.problem] : [])];

  if (problems.length === 0) console.log(`ok: ${statusFile} is current${healthUrl ? ', attestor healthy' : ''}`);
  for (const p of problems) console.log(`PROBLEM ${p.code}: ${p.message}`);

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (token && chatId) {
    const memoryFile = process.env.WATCHDOG_STATE_FILE?.trim() || join(dirname(statusFile), 'watchdog-state.json');
    await notify({ problems, memoryFile, post: (text) => postToTelegram(token, chatId, text) });
  }
  return problems.length > 0 ? 1 : 0;
}

// Run only as a script, not when a test imports evaluate().
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`watchdog failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    },
  );
}
