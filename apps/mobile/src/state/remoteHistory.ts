import { decodePosition, decodeRound, RoundStatus } from '@flipthememe/client';
import { getBase64Encoder } from '@solana/kit';
import { recordOf, type HistoryRecord } from './history.ts';
/** Operator index, never used to authorize a claim or a withdrawal. Live chain data wins. */
export async function fetchRemoteHistory(owner: string, signal?: AbortSignal): Promise<HistoryRecord[]> {
  const response = await fetch(`https://sol.flipthememe.com/v1/history?owner=${encodeURIComponent(owner)}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000) });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`History archive HTTP ${response.status}`);
  const data = await response.json();
  if (data.owner !== owner || !Array.isArray(data.rows) || data.rows.length > 500) throw new Error('Invalid history archive');
  const base64 = getBase64Encoder();
  const records: HistoryRecord[] = [];
  for (const row of data.rows) {
    try {
      const p = decodePosition(base64.encode(row.positionData) as Uint8Array);
      const r = decodeRound(base64.encode(row.roundData) as Uint8Array);
      if (p.authority !== owner || p.isHouse || p.round !== row.round || r.status !== RoundStatus.Final) continue;
      const record = recordOf({ address: row.position, account: p, round: { id: r.id, address: row.round, account: r } }, Date.now());
      if (record) records.push(record);
    } catch { /* an invalid row must not hide valid history */ }
  }
  return records;
}
