import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoundStatus, type RoundAccount } from '@flipthememe/client';
import { latestCall, selectChartRound, selectPanel, selectTimer } from '../chain/phase.ts';
import { notificationFace } from '../lib/notificationFace.ts';
const DEFAULT_FACE = { skin: 0, hairStyle: 0, hairColor: 0, eyes: 0, accessory: 0, mouth: 0 };
test('accepting a second bet makes chart, panel and timer follow that same new round before entry closes',()=>{
  const old={id:1n,account:{status:RoundStatus.Live,cutoffAt:50n,exitEnd:200n,pool:'old'} as RoundAccount};
  const next={id:2n,account:{status:RoundStatus.Open,cutoffAt:150n,exitEnd:250n,pool:'new'} as RoundAccount};
  const focus=latestCall([old,next],100)!;
  assert.equal(focus.id,2n);
  const timer=selectTimer({nowSec:100,open:next,upcoming:null,myUnresolved:[focus]});
  assert.ok('roundId' in timer);
  assert.equal(timer.roundId,2n);
  assert.equal(selectPanel({nowSec:100,open:next,upcoming:null,myUnresolved:[focus]}).kind,'open');
  assert.equal(selectChartRound({pool:'new',focus,inFlight:[old]})?.id,2n);
});
test('notification face preserves a full transparent pixel grid in serializable alarm data',()=>{
  const pixels=notificationFace(DEFAULT_FACE).split(',');
  assert.equal(pixels.length,256);
  assert.ok(pixels.every(p=>/^[0-9a-f]{8}$/.test(p)));
  assert.ok(pixels.includes('00000000'));
  assert.notEqual(notificationFace({...DEFAULT_FACE,hairColor:3}),pixels.join(','));
});
