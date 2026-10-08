/**
 * The keeper's own numbers for the deck, from the two files it writes next to its state file:
 *
 *   rounds.jsonl   one line per swept round: outcome, prices, banks, humans, wallets, players (src/roundlog.ts)
 *   shadow.jsonl   one line per minute: the outcome the round of that minute would have had, bets or not (src/shadow.ts)
 *
 *   node services/keeper/scripts/stats.ts [--dir <folder>] [--days <n>] [--json]
 *
 * Prints: rounds recorded and played, rounds with 1+ and with 2+ people, the unique wallets, the share of UP
 * among the played rounds and among the shadow rounds (up / (up + down); ties and unpriced rounds are counted
 * but left out of the share). The folder is --dir, else the folder of STATE_FILE, else services/keeper. With
 * --days only rounds that opened in the last n days count.
 *
 * Read-only, no dependency beyond Node itself (fs, path): the file also runs on its own, copied next to the
 * data files. Wallets that smoke tests fund from the keeper key are not told apart: the file has no sign of it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Row = Record<string, unknown>;

export type RoundStats = {
  /** Lines of rounds.jsonl in the period. */
  recorded: number;
  /** Rounds that were priced: the exit differed from the strike (up, down) or equalled it (tie). */
  played: number;
  up: number;
  down: number;
  tie: number;
  /** Rounds that ended in a refund without a price: not activated, unpriceable, expired. */
  notPlayed: number;
  withPeople: number;
  withTwoPlus: number;
  playedWithTwoPlus: number;
  /** Rounds whose positions could not be counted (read failed, or closed before the sweep). */
  unknownPeople: number;
  uniqueWallets: number;
  /** up / (up + down) of the played rounds; null with none. */
  upShare: number | null;
  first: string | null;
  last: string | null;
};

export type ShadowStats = {
  rounds: number;
  up: number;
  down: number;
  tie: number;
  unpriced: number;
  upShare: number | null;
  byRung: Record<string, { rounds: number; up: number; down: number; upShare: number | null }>;
  first: string | null;
  last: string | null;
};

const share = (up: number, down: number): number | null => (up + down === 0 ? null : Math.round((up / (up + down)) * 1000) / 1000);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (secs: number | null): string | null => (secs === null ? null : new Date(secs * 1000).toISOString());

/** The JSON objects of a JSON-lines file, oldest first; a missing file is empty, a line that is not an object is skipped. */
export function readJsonl(path: string): Row[] {
  if (!existsSync(path)) return [];
  const out: Row[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) out.push(value as Row);
    } catch {
      // half a line from a crash
    }
  }
  return out;
}

function inPeriod(row: Row, sinceSecs: number | null): boolean {
  if (sinceSecs === null) return true;
  const opensAt = num(row.opensAt);
  return opensAt !== null && opensAt >= sinceSecs;
}

export function computeRoundStats(rows: readonly Row[], sinceSecs: number | null = null): RoundStats {
  const stats: RoundStats = {
    recorded: 0, played: 0, up: 0, down: 0, tie: 0, notPlayed: 0, withPeople: 0, withTwoPlus: 0, playedWithTwoPlus: 0, unknownPeople: 0, uniqueWallets: 0, upShare: null, first: null, last: null,
  };
  const wallets = new Set<string>();
  let first: number | null = null;
  let last: number | null = null;
  for (const row of rows) {
    if (!inPeriod(row, sinceSecs)) continue;
    stats.recorded++;
    const opensAt = num(row.opensAt);
    if (opensAt !== null) {
      first = first === null ? opensAt : Math.min(first, opensAt);
      last = last === null ? opensAt : Math.max(last, opensAt);
    }
    const outcome = row.outcome;
    const tie = outcome === 'refund' && row.refundReason === 'tie';
    const played = outcome === 'up' || outcome === 'down' || tie;
    if (outcome === 'up') stats.up++;
    else if (outcome === 'down') stats.down++;
    else if (tie) stats.tie++;
    if (played) stats.played++;
    else if (outcome === 'not_activated' || outcome === 'refund') stats.notPlayed++;
    const humans = num(row.humans);
    if (humans === null) stats.unknownPeople++;
    else {
      if (humans >= 1) stats.withPeople++;
      if (humans >= 2) {
        stats.withTwoPlus++;
        if (played) stats.playedWithTwoPlus++;
      }
    }
    if (Array.isArray(row.players)) for (const p of row.players) if (typeof p === 'string') wallets.add(p);
  }
  stats.uniqueWallets = wallets.size;
  stats.upShare = share(stats.up, stats.down);
  stats.first = iso(first);
  stats.last = iso(last);
  return stats;
}

export function computeShadowStats(rows: readonly Row[], sinceSecs: number | null = null): ShadowStats {
  const stats: ShadowStats = { rounds: 0, up: 0, down: 0, tie: 0, unpriced: 0, upShare: null, byRung: {}, first: null, last: null };
  let first: number | null = null;
  let last: number | null = null;
  for (const row of rows) {
    if (row.observedOnly === true) continue;
    const dir = row.dir;
    if (dir !== 'up' && dir !== 'down' && dir !== 'tie' && dir !== 'unpriced') continue;
    if (!inPeriod(row, sinceSecs)) continue;
    stats.rounds++;
    stats[dir]++;
    const opensAt = num(row.opensAt);
    if (opensAt !== null) {
      first = first === null ? opensAt : Math.min(first, opensAt);
      last = last === null ? opensAt : Math.max(last, opensAt);
    }
    const rung = typeof row.rung === 'string' && row.rung !== '' ? row.rung : 'unknown';
    const bucket = (stats.byRung[rung] ??= { rounds: 0, up: 0, down: 0, upShare: null });
    bucket.rounds++;
    if (dir === 'up') bucket.up++;
    else if (dir === 'down') bucket.down++;
  }
  stats.upShare = share(stats.up, stats.down);
  for (const bucket of Object.values(stats.byRung)) bucket.upShare = share(bucket.up, bucket.down);
  stats.first = iso(first);
  stats.last = iso(last);
  return stats;
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

export function formatStats(rounds: RoundStats, shadow: ShadowStats, folder: string): string {
  const lines: string[] = [];
  lines.push(`Keeper statistics (${folder})`);
  lines.push('');
  lines.push(`rounds.jsonl: ${rounds.recorded} swept rounds${rounds.first ? `, opened ${rounds.first} to ${rounds.last}` : ''}`);
  lines.push(`  played (priced, up/down/tie):      ${rounds.played}  (up ${rounds.up}, down ${rounds.down}, tie ${rounds.tie})`);
  lines.push(`  refunded without a price:          ${rounds.notPlayed}`);
  lines.push(`  with 1+ people:                    ${rounds.withPeople}`);
  lines.push(`  with 2+ people:                    ${rounds.withTwoPlus}  (of them played: ${rounds.playedWithTwoPlus})`);
  lines.push(`  unique wallets:                    ${rounds.uniqueWallets}`);
  if (rounds.unknownPeople > 0) lines.push(`  rounds with people not counted:    ${rounds.unknownPeople}  (positions closed before the sweep, or unreadable)`);
  lines.push(`  share of UP among played:          ${pct(rounds.upShare)}  (up / (up + down))`);
  lines.push('');
  lines.push(`shadow.jsonl: ${shadow.rounds} rounds, one per minute, bets or not${shadow.first ? `, opened ${shadow.first} to ${shadow.last}` : ''}`);
  lines.push(`  up ${shadow.up}, down ${shadow.down}, tie ${shadow.tie}, unpriced ${shadow.unpriced}`);
  lines.push(`  share of UP:                       ${pct(shadow.upShare)}  (up / (up + down))`);
  for (const [rung, b] of Object.entries(shadow.byRung).sort((a, z) => z[1].rounds - a[1].rounds)) {
    lines.push(`    ${rung.padEnd(12)} ${String(b.rounds).padStart(6)} rounds, share of UP ${pct(b.upShare)}`);
  }
  if (rounds.recorded === 0 && shadow.rounds === 0) lines.push('', 'No data yet: the keeper writes rounds.jsonl at its first sweep and shadow.jsonl once a minute.');
  return lines.join('\n');
}

function parseArgs(argv: string[]): { dir: string | null; days: number | null; json: boolean } {
  let dir: string | null = null;
  let days: number | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--dir') dir = argv[++i] ?? null;
    else if (arg === '--days') {
      days = Number(argv[++i]);
      if (!Number.isFinite(days) || days <= 0) throw new Error('--days needs a positive number');
    } else throw new Error(`unknown argument ${String(arg)} (use --dir <folder>, --days <n>, --json)`);
  }
  return { dir, days, json };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const packageDir = fileURLToPath(new URL('..', import.meta.url));
  const stateFile = resolve(process.env.STATE_FILE?.trim() || join(packageDir, 'keeper-state.json'));
  const folder = resolve(args.dir ?? dirname(stateFile));
  const since = args.days === null ? null : Math.floor(Date.now() / 1000) - Math.round(args.days * 86_400);
  const rounds = computeRoundStats(readJsonl(join(folder, 'rounds.jsonl')), since);
  const shadow = computeShadowStats(readJsonl(join(folder, 'shadow.jsonl')), since);
  console.log(args.json ? JSON.stringify({ folder, days: args.days, rounds, shadow }, null, 2) : formatStats(rounds, shadow, folder));
  return 0;
}

// Run only as a script, not when a test imports the functions.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`stats failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
