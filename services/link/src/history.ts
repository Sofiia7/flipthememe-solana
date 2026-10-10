import { base58Decode } from './names.ts';
import type { LeaderboardEnv } from './leaderboard.ts';
const KEEPER = '3iv5z9pWawKpjafBLN5pyKzYzKkj375bKoj5TWmmn6BC';
const address = (v: unknown): v is string => typeof v === 'string' && base58Decode(v)?.length === 32;
export async function history(request: Request, env: LeaderboardEnv): Promise<Response> {
  const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
  if (!env.LEADERBOARD) return reply({ error: 'unavailable' }, 503);
  if (request.method === 'GET') {
    const owner = new URL(request.url).searchParams.get('owner');
    const page = new URL(request.url).searchParams.get('page') ?? '0';
    if (!/^\d{1,6}$/.test(page)) return reply({ error: 'page' }, 400);
    if (!address(owner)) return reply({ error: 'owner' }, 400);
    const raw = await env.LEADERBOARD.get(`history:${owner}:${page}`);
    return raw ? reply(JSON.parse(raw)) : reply({ error: 'not_indexed' }, 404);
  }
  if (request.method !== 'PUT') return reply({ error: 'method' }, 405);
  const reader = request.body?.getReader();
  if (!reader) return reply({ error: 'body' }, 400);
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 1_000_000) { await reader.cancel(); return reply({ error: 'too_large' }, 413); } chunks.push(part.value); }
  const bytes = new Uint8Array(length); let at = 0; for (const c of chunks) { bytes.set(c, at); at += c.length; }
  const payload = new TextDecoder().decode(bytes);
  try {
    const signature = Uint8Array.from(atob(request.headers.get('x-keeper-signature') ?? ''), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', base58Decode(KEEPER)!, 'Ed25519', false, ['verify']);
    if (signature.length !== 64 || !await crypto.subtle.verify('Ed25519', key, signature, new TextEncoder().encode('FlipTheMeme history v1\n' + payload))) return reply({ error: 'unauthorized' }, 401);
    const data = JSON.parse(payload);
    if (!Number.isInteger(data.page) || data.page < 0 || data.page > 999999 || !Number.isInteger(data.pages) || data.pages <= data.page || data.pages > 1000000) return reply({ error: 'page' }, 400);
    if (!address(data.owner) || !Number.isFinite(Date.parse(data.updatedAt)) || Math.abs(Date.now() - Date.parse(data.updatedAt)) > 120_000 || !Array.isArray(data.rows) || data.rows.length > 500 || data.rows.some((r: any) => !address(r.position) || !address(r.round) || typeof r.positionData !== 'string' || r.positionData.length > 512 || typeof r.roundData !== 'string' || r.roundData.length > 2048)) return reply({ error: 'invalid' }, 400);
    const old = await env.LEADERBOARD.get(`history:${data.owner}:${data.page}`);
    if (old && Date.parse(JSON.parse(old).updatedAt) > Date.parse(data.updatedAt)) return reply({ error: 'older_snapshot' }, 409);
    await env.LEADERBOARD.put(`history:${data.owner}:${data.page}`, payload);
    return reply({ ok: true });
  } catch { return reply({ error: 'invalid' }, 400); }
}
