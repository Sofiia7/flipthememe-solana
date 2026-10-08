import { existsSync, readFileSync } from 'node:fs';
import { decodePosition, decodeRound, POSITION_ACCOUNT_SIZE, PROGRAM_ID, RoundStatus, Outcome, Side, acceptedStake, positionPayout, houseContext, type PositionAccount, type RoundAccount } from '@flipthememe/client';
import { getBase64Encoder, type KeyPairSigner } from '@solana/kit';
import type { SolanaRpc } from './rpc.ts';
import { writeJsonAtomic } from './state.ts';
import type { ShadowSummary } from './shadow.ts';

export type Score = { key: string; owner: string; at: number; stake: string; payout: string; result: 'win' | 'loss' | 'refund'; face?: string };
export function scorePosition(r: RoundAccount, p: PositionAccount): Score | null {
  if (r.status !== RoundStatus.Final || p.isHouse) return null;
  const payout = p.claimed ? p.payout : positionPayout(r.rawUp, r.rawDown, r.outcome, r.feeWinBps, r.feeRefundBps, p.side, p.stake, houseContext(r, p));
  if (payout === null) return null;
  const played = (r.outcome === Outcome.Up || r.outcome === Outcome.Down) && (acceptedStake(r.rawUp, r.rawDown, p.side, p.stake) ?? 0n) > 0n;
  const won = r.outcome === Outcome.Up ? p.side === Side.Up : p.side === Side.Down;
  return { key: `${r.id}:${p.authority}`, owner: p.authority, at: Number(r.opensAt) * 1000, stake: p.stake.toString(), payout: payout.toString(), face: Buffer.from(p.face).toString('hex'), result: played ? won ? 'win' : 'loss' : 'refund' };
}
export function rank(scores: readonly Score[], now: number) {
  const faces = new Map<string, { at: number; face: string }>();
  const players = new Map<string, { owner: string; wins: number; losses: number; refunds: number; net: bigint }>();
  for (const s of scores) {
    if (s.at < now - 7 * 86400_000 || s.at > now) continue;
    if (s.face && /^[0-9a-f]{16}$/.test(s.face) && s.at >= (faces.get(s.owner)?.at ?? 0)) faces.set(s.owner, { at: s.at, face: s.face });
    const p = players.get(s.owner) ?? { owner: s.owner, wins: 0, losses: 0, refunds: 0, net: 0n };
    p[s.result === 'win' ? 'wins' : s.result === 'loss' ? 'losses' : 'refunds']++;
    p.net += BigInt(s.payout) - BigInt(s.stake);
    players.set(s.owner, p);
  }
  return [...players.values()].sort((a, b) => a.net === b.net ? b.wins - a.wins || a.owner.localeCompare(b.owner) : a.net > b.net ? -1 : 1)
    .slice(0, 200).map((p, i) => ({ ...p, ...(faces.has(p.owner) ? { face: faces.get(p.owner)!.face } : {}), rank: i + 1, net: p.net.toString(), accuracy: p.wins + p.losses ? Math.round(p.wins * 100 / (p.wins + p.losses)) : null }));
}

/** Independent read-only indexer: persists settled positions before their accounts are closed. */
export class Leaderboard {
  private scores: Score[];
  private coverageSince: string;
  private file: string;
  private rpc: SolanaRpc;
  private signer: KeyPairSigner;
  private arena: unknown = null;
  private indexedAt: string | null = null;
  private publishing = false;
  constructor(file: string, rpc: SolanaRpc, signer: KeyPairSigner) {
    this.file = file; this.rpc = rpc; this.signer = signer;
    if (existsSync(file)) {
      const stored = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(stored.scores) || typeof stored.coverageSince !== 'string') throw new Error('Invalid leaderboard ledger');
      this.scores = stored.scores;
      this.coverageSince = stored.coverageSince;
    } else { this.scores = []; this.coverageSince = new Date().toISOString(); }
  }
  async tick(directions?: ShadowSummary): Promise<void> {
    const now = Date.now();
    const base64 = getBase64Encoder();
    const accounts = await this.rpc.getProgramAccounts(PROGRAM_ID, { encoding: 'base64', commitment: 'confirmed', filters: [{ dataSize: BigInt(POSITION_ACCOUNT_SIZE) }] }).send();
    const positions = accounts.map(({ account }) => decodePosition(base64.encode(account.data[0]) as Uint8Array)).filter((p) => !p.isHouse);
    const known = new Set(this.scores.map((s) => s.key));
    const keys = [...new Set(positions.map((p) => p.round))];
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const { value } = await this.rpc.getMultipleAccounts(chunk, { encoding: 'base64', commitment: 'confirmed' }).send();
      for (let j = 0; j < chunk.length; j++) {
        const acc = value[j];
        if (!acc) continue;
        const r = decodeRound(base64.encode(acc.data[0]) as Uint8Array);
        if (r.status !== RoundStatus.Final || Number(r.opensAt) * 1000 < now - 7 * 86400_000) continue;
        for (const p of positions.filter((p) => p.round === chunk[j])) {
          const key = `${r.id}:${p.authority}`;
          if (known.has(key)) {
            const existing = this.scores.find(s => s.key === key);
            if (existing && !existing.face) existing.face = Buffer.from(p.face).toString('hex');
            continue;
          }
          const score = scorePosition(r, p);
          if (!score) continue;
          this.scores.push(score);
          known.add(key);
        }
      }
    }
    this.scores = this.scores.filter((s) => s.at >= now - 7 * 86400_000);
    writeJsonAtomic(this.file, { coverageSince: this.coverageSince, scores: this.scores });
    this.indexedAt = new Date(now).toISOString();

  }
  /** Public liveness updates need no chain reads; the ranking scan remains once every two minutes. */
  async publish(directions?: ShadowSummary, arena?: unknown): Promise<void> {
    if (arena !== undefined) this.arena = arena;
    if (this.publishing) return;
    this.publishing = true;
    try {
    const now = Date.now();
    const payload = JSON.stringify({ arena: this.arena, indexedAt: this.indexedAt, updatedAt: new Date(now).toISOString(), coverageSince: this.coverageSince, period: '7d', directions: directions ?? null, players: rank(this.scores, now) });
    const bytes = new TextEncoder().encode('FlipTheMeme leaderboard v1\n' + payload);
    const signature = Buffer.from(await crypto.subtle.sign('Ed25519', this.signer.keyPair.privateKey, bytes)).toString('base64');
    const response = await fetch('https://sol.flipthememe.com/v1/leaderboard', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-keeper-signature': signature }, body: payload, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Leaderboard publish HTTP ${response.status}`);
    } finally { this.publishing = false; }
  }
}
