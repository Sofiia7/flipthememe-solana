import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OracleHealth } from '../src/oracle-health.ts';
test('new rounds wait for a current ready oracle; failed and stale checks close the gate', async () => {
  let ready = true;
  const health = new OracleHealth('https://oracle.test', (async () => Response.json({ readiness: { ready } })) as typeof fetch);
  assert.notEqual(health.refusal(Date.now()), null);
  await health.check();
  assert.equal(health.refusal(Date.now()), null);
  assert.notEqual(health.refusal(Date.now() + 46_000), null);
  ready = false; await health.check();
  assert.notEqual(health.refusal(Date.now()), null);
});
