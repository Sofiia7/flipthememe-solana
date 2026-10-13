// Proxy mode: a deployment of this Worker that only forwards to another deployment of the attestor.
//
// Why: two attestors with the same key must never both serve one round window, each would sign its own
// sample set. After the main Cloudflare account used up its Durable Objects quota (12 October 2026) the
// keeper moved to a backup deployment on a second account. The main deployment keeps its public address
// (sol.flipthememe.com/v1/attest*, named in the README) by forwarding to the backup, and its own
// Durable Object goes quiet. Set ATTEST_PROXY to the base URL of the deployment that does the work;
// leave it unset on that deployment.

/** The routes of the attestor, nothing else is forwarded. */
const FORWARDED = new Set(['/live', '/ready', '/v1/attest', '/v1/attestor', '/v1/attestor/live', '/v1/attestor/ready', '/v1/attestation']);

/** Headers that belong to one connection, not to the request, or that the platform sets itself. */
const DROP_REQUEST = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-visitor', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']);

/** The body shape of the rest of the API: a readable error and a short machine reason. */
const reply = (status: number, reason: string, error: string): Response =>
  new Response(JSON.stringify({ error, reason }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** The upstream URL for a request, or null when the path is not an attestor route or the base is not usable. */
export function upstreamUrl(request: Request, base: string | undefined): URL | null {
  if (!base) return null;
  let target: URL;
  try {
    target = new URL(base);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:') return null;
  const incoming = new URL(request.url);
  if (!FORWARDED.has(incoming.pathname)) return null;
  // Forwarding to itself would loop until the platform cuts it off.
  if (target.host === incoming.host) return null;
  return new URL(`${incoming.pathname}${incoming.search}`, `${target.origin}/`);
}

export async function forward(request: Request, base: string | undefined, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = upstreamUrl(request, base);
  if (!url) {
    // Not an attestor route: nothing here. An attestor route with no usable base (unset, not https, or this very host): a misconfiguration.
    return FORWARDED.has(new URL(request.url).pathname) ? reply(500, 'proxy_misconfigured', 'ATTEST_PROXY is not a usable https address of another deployment') : reply(404, 'not_found', 'not found');
  }
  const headers = new Headers();
  for (const [name, value] of request.headers) if (!DROP_REQUEST.has(name.toLowerCase())) headers.set(name, value);
  headers.set('x-forwarded-by', 'ftm-attestor-proxy');
  try {
    const upstream = await fetcher(url, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
      signal: AbortSignal.timeout(25_000),
    });
    const out = new Headers(upstream.headers);
    out.set('x-proxied', '1');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return reply(503, 'unavailable', 'the attestor is unavailable, try again');
  }
}
