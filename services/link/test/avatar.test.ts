import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avatar } from '../src/avatar.ts';
import { faceFromBytes, faceGrid, gridToPaths } from '../../../apps/mobile/src/face/faceModel.ts';
test('public avatar uses the exact phone pixel face and rejects arbitrary SVG input', async () => {
  const response = avatar(new Request('https://sol.flipthememe.com/v1/avatar?face=0305020100000000'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  const svg = await response.text();
  for (const p of gridToPaths(faceGrid(faceFromBytes([3,5,2,1,0,0,0,0])))) assert.ok(svg.includes(`<path fill="${p.color}" d="${p.d}"/>`));
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
  for (const face of ['', 'script', '0000', 'zz05020100000000']) assert.equal(avatar(new Request('https://sol.flipthememe.com/v1/avatar?face='+face)).status, 400);
});
