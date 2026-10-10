import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLeaderboardStorage } from '../src/leaderboard-storage.ts';
test('legacy archive migrates on read; future updates never write KV', async () => {
  const data = new Map<string,string>(); let legacyReads=0;
  const env = withLeaderboardStorage({
    LEADERBOARD: { get: async () => {legacyReads++;return '{"rows":[1]}';}, put: async () => {throw Error('KV write forbidden');} },
    LEADERBOARD_STORE: { getByName: (key:string) => ({ getValue:async()=>data.get(key)??null,putValue:async(value:string)=>{data.set(key,value);} }) },
  });
  assert.equal(await env.LEADERBOARD.get('history:owner:0'), '{"rows":[1]}');
  await env.LEADERBOARD.put('history:owner:0','{"rows":[2]}');
  assert.equal(await env.LEADERBOARD.get('history:owner:0'), '{"rows":[2]}');
  assert.equal(legacyReads,1);
});
test('new published snapshot reads back even if legacy KV is unavailable', async () => {
  const data=new Map<string,string>();
  const env=withLeaderboardStorage({ LEADERBOARD:{get:async()=>{throw Error('Legacy outage');},put:async()=>{throw Error('KV write forbidden');}}, LEADERBOARD_STORE:{getByName:(key:string)=>({getValue:async()=>data.get(key)??null,putValue:async(value:string)=>{data.set(key,value);}})} });
  await env.LEADERBOARD.put('snapshot','{"players":[]}');
  assert.equal(await env.LEADERBOARD.get('snapshot'),'{"players":[]}');
});
