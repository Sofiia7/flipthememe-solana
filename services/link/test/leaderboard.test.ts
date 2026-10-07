import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaderboard } from '../src/leaderboard.ts';

test('public reads return the saved board; missing data is unavailable rather than an empty fabricated ranking', async () => {
  const get = new Request('https://sol.flipthememe.com/v1/leaderboard');
  assert.equal((await leaderboard(get, {})).status, 503);
  const value = JSON.stringify({ players: [{ owner: 'player' }] });
  const response = await leaderboard(get, { LEADERBOARD: { get: async () => value, put: async () => {} } });
  assert.deepEqual(await response.json(), JSON.parse(value));
});
test('unsigned and oversized updates cannot overwrite the ranking', async () => {
  let writes = 0;
  const env = { LEADERBOARD: { get: async () => null, put: async () => { writes++; } } };
  assert.equal((await leaderboard(new Request('https://sol.flipthememe.com/v1/leaderboard', { method: 'PUT', body: '{}' }), env)).status, 401);
  assert.equal((await leaderboard(new Request('https://sol.flipthememe.com/v1/leaderboard', { method: 'PUT', body: 'x'.repeat(100_001) }), env)).status, 413);
  assert.equal(writes, 0);
});
