import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchRemoteHistory } from '../state/remoteHistory.ts';
test('history recovery works with the React Native AbortSignal API and propagates cancellation', async () => {
  const originalFetch = globalThis.fetch;
  const timeout = AbortSignal.timeout;
  const any = AbortSignal.any;
  const owner = '11111111111111111111111111111111';
  Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
  try {
    globalThis.fetch = async () => Response.json({ owner, rows: [] });
    assert.deepEqual(await fetchRemoteHistory(owner), []);
    const parent = new AbortController();
    globalThis.fetch = async (_url, init) => {
      parent.abort();
      assert.equal(init?.signal?.aborted, true);
      throw new DOMException('cancelled', 'AbortError');
    };
    await assert.rejects(fetchRemoteHistory(owner, parent.signal), { name: 'AbortError' });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: timeout });
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: any });
  }
});
