import test from 'node:test';
import assert from 'node:assert/strict';
import {mphFromMps,isStationary,isMoving,isLocationFresh,BreakReminder,BREAK_AFTER_MS,BREAK_DURATION_MS} from '../src/logic.mjs';

test('speed conversion and bad GPS values',()=>{
  assert.ok(Math.abs(mphFromMps(10)-22.369)<.01);
  assert.equal(mphFromMps(-1),null);
  assert.equal(mphFromMps(null),null);
  assert.equal(mphFromMps(100),null);
});
test('stale GPS must not qualify as parked or moving',()=>{
  assert.equal(isLocationFresh(1000,12001),false);
  assert.equal(isStationary(0,1000,12001),false);
  assert.equal(isMoving(70,1000,12001),false);
  assert.equal(isStationary(0,1000,3000),true);
  assert.equal(isMoving(40,1000,3000),true);
});
test('break reminder accumulates moving time, not elapsed non-moving time',()=>{
  const b=new BreakReminder();
  b.update(1000,true,false);
  b.update(5000,true,false);
  b.update(8000,false,true);
  b.update(15000,false,true);
  assert.equal(b.accumulatedMovingMs,4000);
  assert.equal(b.needsBreak,false);
});
test('resume after suspension cannot count a huge unobserved interval',()=>{
  const b=new BreakReminder();b.update(0,true,false);b.update(BREAK_AFTER_MS+1,true,false);
  assert.equal(b.accumulatedMovingMs,8000);
});
test('ten-minute stationary interval resets break counter',()=>{
  const b=new BreakReminder();
  b.update(0,true,false);b.update(1000,true,false);
  b.update(2000,false,true);b.update(2000+BREAK_DURATION_MS,false,true);
  assert.equal(b.accumulatedMovingMs,0);
  assert.equal(b.breaks,1);
});
