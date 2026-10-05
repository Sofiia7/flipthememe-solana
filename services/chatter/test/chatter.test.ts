import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { cleanText, moodOf, toItems } from '../src/index.ts';

test('mood: scam words win, moon words and emoji, neutral otherwise', () => {
  assert.equal(moodOf('this is going to the moon lfg'), 'moon');
  assert.equal(moodOf('dev rugged, total scam'), 'scam');
  assert.equal(moodOf('pump then dump'), 'scam');
  assert.equal(moodOf('🚀🚀🚀'), 'moon');
  assert.equal(moodOf('💀 chart'), 'scam');
  assert.equal(moodOf('paper hands along the way'), 'neutral');
  assert.equal(moodOf('who is the dev'), 'neutral');
});

test('clean text drops links, masks slurs, trims', () => {
  assert.equal(cleanText('  look   https://t.co/abc  here\n now '), 'look here now');
  assert.equal(cleanText('x'.repeat(300)).length, 160);
});

test('tweets map to items and skip incomplete rows', () => {
  const items = toItems([
    { id_str: '1', full_text: 'moon soon $AIKOL', tweet_created_at: '2026-10-05T13:00:00Z', user: { screen_name: 'a', name: 'A', followers_count: 10 } },
    { id_str: '2', full_text: '', user: { screen_name: 'b' } },
    { full_text: 'no id', user: { screen_name: 'c' } },
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    id: '1',
    author: 'a',
    name: 'A',
    followers: 10,
    text: 'moon soon $AIKOL',
    createdAt: '2026-10-05T13:00:00Z',
    url: 'https://x.com/a/status/1',
    mood: 'moon',
  });
});

test('worker validates input and refuses without a key', async () => {
  const call = (path: string) => worker.fetch(new Request(`https://w.dev${path}`), { SOCIALDATA_API_KEY: '' });
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/v1/chatter?symbol=bad-symbol!')).status, 400);
  assert.equal((await call('/v1/chatter?symbol=AIKOL&mint=0OIl')).status, 400);
  assert.equal((await call('/v1/chatter?symbol=AIKOL')).status, 503);
  assert.equal((await call('/elsewhere')).status, 404);
});
