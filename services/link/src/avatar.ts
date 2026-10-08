import { faceFromBytes, faceGrid, gridToPaths, GRID } from '../../../apps/mobile/src/face/faceModel.ts';
/** Render the same on-chain face as the phone, without remote images or an IPFS dependency. */
export function avatar(request: Request): Response {
  const hex = new URL(request.url).searchParams.get('face');
  if (!hex || !/^[0-9a-f]{16}$/.test(hex)) return new Response('Invalid face', { status: 400 });
  const face = faceFromBytes(Uint8Array.from(hex.match(/../g)!, b => parseInt(b, 16)));
  const paths = gridToPaths(faceGrid(face)).map(p => `<path fill="${p.color}" d="${p.d}"/>`).join('');
  return new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" width="48" height="48" shape-rendering="crispEdges">${paths}</svg>`, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } });
}
