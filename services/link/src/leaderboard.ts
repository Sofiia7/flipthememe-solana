import { base58Decode } from './names.ts';
export type LeaderboardEnv = { LEADERBOARD?: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> } };
const KEEPER = '3iv5z9pWawKpjafBLN5pyKzYzKkj375bKoj5TWmmn6BC';
export async function leaderboard(request: Request, env: LeaderboardEnv): Promise<Response> {
  const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers });
  if (!env.LEADERBOARD) return reply({ error: 'unavailable' }, 503);
  if (request.method === 'GET') {
    const data = await env.LEADERBOARD.get('snapshot');
    return data ? new Response(data, { headers }) : reply({ error: 'collecting' }, 503);
  }
  if (request.method !== 'PUT') return reply({ error: 'method' }, 405);
  // Bound the streamed body before buffering it, including requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return reply({ error: 'body' }, 400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 100_000) { await reader.cancel(); return reply({ error: 'too_large' }, 413); }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.length; }
  const payload = new TextDecoder().decode(all);
  try {
    const signature = Uint8Array.from(atob(request.headers.get('x-keeper-signature') ?? ''), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', base58Decode(KEEPER)!, 'Ed25519', false, ['verify']);
    if (signature.length !== 64 || !await crypto.subtle.verify('Ed25519', key, signature, new TextEncoder().encode('FlipTheMeme leaderboard v1\n' + payload))) return reply({ error: 'unauthorized' }, 401);
    const data = JSON.parse(payload);
    if (Math.abs(Date.now() - Date.parse(data.updatedAt)) > 120_000 || !Number.isFinite(Date.parse(data.updatedAt)) || data.period !== '7d' || !Array.isArray(data.players) || data.players.length > 200) return reply({ error: 'invalid' }, 400);
    await env.LEADERBOARD.put('snapshot', payload);
    return reply({ ok: true }, 200);
  } catch { return reply({ error: 'invalid' }, 400); }
}

export function leaderboardPage(): Response {
  return new Response(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>FlipTheMeme leaderboard</title><style>body{background:#100d1f;color:#e6e0f1;font:16px system-ui;margin:24px auto;padding:0 16px;max-width:650px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px 4px;border-bottom:1px solid #41315a}h1{color:#ffe14d}small{color:#bfb5d2}.player{display:flex;align-items:center;gap:8px}.face{width:32px;height:32px;image-rendering:pixelated;background:#21172f}</style><h1>LEADERBOARD</h1><p>Last 7 days · net test SOL · players only</p><p id="status">Loading…</p><table><thead><tr><th>#</th><th>Player</th><th>Net SOL</th><th>W / L</th></tr></thead><tbody id="rows"></tbody></table><script>async function load(){try{const r=await fetch('/v1/leaderboard');if(!r.ok)throw Error('Ranking is temporarily unavailable');const d=await r.json();document.getElementById('status').textContent='Updated '+new Date(d.indexedAt||d.updatedAt).toLocaleString()+' · recorded since '+new Date(d.coverageSince).toLocaleString();const rows=document.getElementById('rows');rows.replaceChildren();for(const p of d.players){const tr=document.createElement('tr');for(const v of [p.rank,p.owner.slice(0,5)+'…'+p.owner.slice(-5),(Number(p.net)/1e9).toFixed(4),p.wins+' / '+p.losses]){const td=document.createElement('td');if(tr.children.length===1){td.className='player';if(typeof p.face==='string'&&/^[0-9a-f]{16}$/.test(p.face)){const img=document.createElement('img');img.src='/v1/avatar?face='+p.face;img.className='face';img.alt='Pixel avatar';td.append(img)}const name=document.createElement('span');name.textContent=v;td.append(name)}else td.textContent=v;tr.append(td)}rows.append(tr)}if(!d.players.length)document.getElementById('status').textContent+=' · no settled bets yet'}catch(e){document.getElementById('status').textContent=e.message}}load();setInterval(load,60000)</script></html>`, { headers: { 'content-type': 'text/html;charset=utf-8' } });
}
