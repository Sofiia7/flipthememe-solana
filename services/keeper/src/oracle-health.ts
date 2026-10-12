/** Cached readiness gate: failures block creation, never settlement, claims or withdrawals. */
export class OracleHealth {
  private checkedAt = 0;
  private reason = 'Oracle readiness has not been checked yet.';
  private readonly url: string | null;
  private readonly fetcher: typeof fetch;
  constructor(url: string | null, fetcher: typeof fetch = fetch) { this.url = url; this.fetcher = fetcher; }
  refusal(now: number): string | null {
    if (!this.url) return 'Canonical oracle endpoint is not configured.';
    return now - this.checkedAt > 45_000 ? 'Oracle readiness check is stale.' : this.reason || null;
  }
  async check(): Promise<void> {
    try {
      if (!this.url) throw new Error('not configured');
      const response = await this.fetcher(`${this.url.replace(/\/+$/, '')}/v1/attestor/ready`, { signal: AbortSignal.timeout(8_000) });
      const data = await response.json() as { readiness?: { ready?: boolean } };
      this.reason = response.ok && data.readiness?.ready === true ? '' : 'Oracle cannot confirm fresh pricing. New rounds wait; existing funds remain recoverable.';
    } catch { this.reason = 'Oracle readiness is unavailable. New rounds wait; existing funds remain recoverable.'; }
    this.checkedAt = Date.now();
  }
}
