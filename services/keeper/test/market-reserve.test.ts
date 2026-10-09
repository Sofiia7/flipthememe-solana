import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketQuality, reserveOrder, shadowSamplingWindow } from '../src/market-reserve.ts';
import { marketSample } from '../src/shadow.ts';
import { DEFAULT_GATE, rankCandidates, rungOf } from '../src/poolgate.ts';
import { candidate, withFlow, NOW, HOUR } from './pool-fixtures.ts';
const c={...withFlow(candidate(1,0,48*HOUR),50,50),priceChangeM5:0.1};
test('five one-sided outcomes are penalized before the ten-minute readiness threshold',()=>{
  for (const [up,down] of [[5,0],[0,5],[7,1],[1,7],[7,3],[3,7]]) {
    const quality=marketQuality(c,{up,down,priced:up+down,dominantShare:Math.max(up,down)/(up+down)});
    assert.equal(quality.tier,2);
    assert.equal(quality.biased,true);
  }
});
test('warming reserves survive better ranked newcomers until measured or their bounded lease expires',()=>{
  const previous=new Map([['active',NOW],...['a','b','c','d','e'].map(p=>[p,NOW] as const)]);
  const ranked=['new','active','a','b','c','d','e'].map(pool=>({pool,priced:3}));
  assert.deepEqual(reserveOrder(ranked,previous,NOW+60_000,'active').map(p=>p.pool),['active','a','b','c','d','e']);
  assert.equal(reserveOrder(ranked,previous,NOW+16*60_000,'active').some(p=>p.pool==='new'),true);
});
test('observed directional risk is symmetric and does not reward missing flow or missing drift',()=>{
  for(const [up,down] of [[8,2],[2,8]]) assert.equal(marketQuality(c,{up,down,priced:10,dominantShare:.8}).tier,2);
  const measured={up:5,down:5,priced:10,dominantShare:.5};
  assert.equal(marketQuality(c,measured).tier,0);
  assert.equal(marketQuality({...c,buys:undefined},measured).tier,2);
  assert.equal(marketQuality({...c,priceChangeM5:undefined},measured).tier,2);
  assert.equal(marketQuality(c,{up:0,down:0,priced:0,dominantShare:null}).tier,1);
});
test('reserve sampling covers synchronized price windows without polling every background pool all minute',()=>{
  for(const second of [28,30,39,42])assert.equal(shadowSamplingWindow(second*1000),true);
  for(const second of [0,27,43,59])assert.equal(shadowSamplingWindow(second*1000),false);
});
test('directional sample ignores ties, missing prices, other pools, future and old rows',()=>{
  const rows=[{pool:'a',opensAt:NOW/1000-60,dir:'up' as const},{pool:'a',opensAt:NOW/1000-120,dir:'down' as const},{pool:'a',opensAt:NOW/1000-180,dir:'tie' as const},{pool:'b',opensAt:NOW/1000-60,dir:'up' as const},{pool:'a',opensAt:NOW/1000+60,dir:'up' as const}];
  assert.deepEqual(marketSample(rows,'a',NOW),{priced:2,up:1,down:1,dominantShare:.5});
});
test('mature reserve pools need no pump vanity suffix; young candidates still require it',()=>{
  const gate={...DEFAULT_GATE,balanced:true,pumpOnly:true,youthWeight:0};
  assert.equal(rungOf(c,NOW,gate),3);
  assert.equal(rungOf(candidate(2,100,1*HOUR),NOW,gate),null);
  assert.equal(rankCandidates([c,{...c,pool:candidate(3,100,1*HOUR).pool,txM5:500,buys:250,sells:250}],NOW,{...gate,pumpOnly:false})[0].candidate.txM5,500);
});
