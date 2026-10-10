type Check = { ready: boolean; until: number };
let cached: Check | null = null;
let checking: Promise<boolean> | null = null;
/** Defense for older keepers that publish ready while the oracle is unavailable. */
export async function gateArena(arena: Record<string, unknown>, fetcher: typeof fetch = fetch) {
  if (arena.phase !== 'ready') return arena;
  const read = async () => {
    try {
      const response = await fetcher('https://ftm-attestor.sofiaseremeteva.workers.dev/v1/attestor', { signal: AbortSignal.timeout(5_000) });
      const data = await response.json() as { readiness?: { ready?: boolean; checkedAt?: string } };
      const at = Date.parse(data.readiness?.checkedAt ?? '');
      return response.ok && data.readiness?.ready === true && Number.isFinite(at) && Date.now() - at <= 45_000 && at <= Date.now() + 5_000;
    } catch { return false; }
  };
  let ready: boolean;
  if (fetcher !== fetch) ready = await read();
  else if (cached && cached.until > Date.now()) ready = cached.ready;
  else {
    checking ??= read().then(value => { cached = { ready: value, until: Date.now() + 20_000 }; return value; }).finally(() => { checking = null; });
    ready = await checking;
  }
  return ready ? arena : { ...arena, phase: 'paused', reason: 'Fresh oracle prices cannot be confirmed. New bets wait; existing bets can still settle or refund.', keeperUpdatedAt: arena.updatedAt, updatedAt: new Date().toISOString() };
}
