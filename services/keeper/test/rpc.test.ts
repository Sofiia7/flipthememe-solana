import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LogFields } from '../src/log.ts';
import { FailoverRpc, isEndpointFailure } from '../src/rpc.ts';

class RpcDown extends Error {} // stands in for kit's SolanaError (HTTP 429, JSON-RPC errors)

test('mainnet failover: a failing endpoint backs off, data errors do not blame the endpoint', async () => {
  let now = 0;
  const logs: LogFields[] = [];
  const rpc = new FailoverRpc(['https://a.example/key-in-path', 'https://b.example/?api-key=x'], (f) => logs.push(f), { now: () => now });

  let calls = 0;
  assert.equal(await rpc.call('read', async () => (++calls === 1 ? Promise.reject(new RpcDown('HTTP 429')) : 'ok')), 'ok');
  assert.equal(rpc.lastHost, 'b.example');
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.host, 'a.example'); // host only: no path or query with API keys
  assert.equal(logs[0]?.backoffMs, 1_000);

  now = 500; // a is still backing off: b serves directly
  calls = 0;
  await rpc.call('read', async () => ++calls);
  assert.equal(calls, 1);
  assert.equal(rpc.lastHost, 'b.example');

  now = 1_500; // a is preferred again once its backoff is over
  await rpc.call('read', async () => 'ok');
  assert.equal(rpc.lastHost, 'a.example');

  // A plain Error is a data problem (wrong owner, mint mismatch): thrown straight through.
  await assert.rejects(rpc.call('read', async () => Promise.reject(new Error('mint mismatch'))), /mint mismatch/);
  assert.equal(logs.length, 1);
  await rpc.call('read', async () => 'ok');
  assert.equal(rpc.lastHost, 'a.example');

  // Both down: the last error surfaces; while both back off, calls fail fast.
  await assert.rejects(rpc.call('read', async () => Promise.reject(new RpcDown('down'))), /down/);
  assert.equal(logs.length, 3);
  await assert.rejects(rpc.call('read', async () => 'never'), /backing off/);
});

test('isEndpointFailure', () => {
  assert.equal(isEndpointFailure(new RpcDown('x')), true);
  assert.equal(isEndpointFailure(new TypeError('fetch failed')), true);
  assert.equal(isEndpointFailure(new DOMException('timeout', 'TimeoutError')), true);
  assert.equal(isEndpointFailure(new Error('PumpSwap base vault holds mint X')), false);
});
