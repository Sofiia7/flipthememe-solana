import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoundStatus, Side } from '@flipthememe/client';
import { roundProgress } from '../chain/roundProgress.ts';

const round = { status: RoundStatus.Open, cutoffAt: 60n, strikeStart: 90n, strikeEnd: 100n, exitStart: 150n, exitEnd: 160n, strikePrice: 0n };

test('a saved bet stays distinct from the wait and the actual reference measurement', () => {
  assert.equal(roundProgress(round, Side.Up, 59).title, 'BET ACCEPTED');
  const waiting = roundProgress(round, Side.Up, 65);
  assert.equal(waiting.title, 'WAITING TO START');
  assert.match(waiting.detail, /0:25/);
  assert.equal(roundProgress(round, Side.Up, 90).title, 'MEASURING REFERENCE');
  assert.equal(roundProgress(round, Side.Up, 100).title, 'CONFIRMING REFERENCE');
});

test('a live round distinguishes the indicative chart from the final average and confirmation', () => {
  const live = { ...round, status: RoundStatus.Live, strikePrice: 100n };
  assert.equal(roundProgress(live, Side.Down, 120).title, 'YOUR ROUND IS LIVE');
  const final = roundProgress(live, Side.Down, 150);
  assert.equal(final.title, 'MEASURING FINAL PRICE');
  assert.match(final.detail, /not the last chart dot/);
  assert.match(final.rule, /below/);
  assert.match(roundProgress(live, Side.Up, 150).rule, /above/);
  assert.equal(roundProgress(live, Side.Down, 160).title, 'CONFIRMING RESULT');
  assert.equal(roundProgress({ ...live, status: RoundStatus.Final }, Side.Down, 160).title, 'ROUND FINISHED');
});

test('delayed reference posting never suggests that prices after the exit window can change the result', () => {
  assert.equal(roundProgress(round, Side.Up, 161).title, 'CONFIRMING RESULT');
});
