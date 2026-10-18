import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadNodMonitor, normalizeImu, alertPhase } from '../src/nod.mjs';
const forward={x:0,y:0,z:1};
const down={x:0,y:.45,z:.893};
function fill(m,pose,start,count=14,delta=100,moving=false) {
  for(let i=0;i<count;i++) m.observe(pose,start+i*delta,moving);
  return start+(count-1)*delta;
}
function calibrated(){
  const m=new HeadNodMonitor();
  fill(m,forward,0); assert.equal(m.captureNeutral(1300),true);
  fill(m,down,1600); assert.equal(m.captureDown(2900),true);
  return m;
}
function nod(m,start){
  fill(m,forward,start,8,80,true);
  fill(m,down,start+650,10,80,true);
  fill(m,forward,start+1600,13,80,true);
}
test('rejects invalid or shock-sized IMU samples',()=>{
  assert.equal(normalizeImu({x:0,y:0,z:10}),null);
  assert.equal(normalizeImu({x:0,y:0,z:1})?.[2],1);
});
test('calibration requires two distinguishable head positions',()=>{
  const m=new HeadNodMonitor();
  fill(m,forward,0); assert.equal(m.captureNeutral(1300),true);
  fill(m,forward,1600); assert.equal(m.captureDown(2900),false);
});
test('single nod does not escalate',()=>{
  const m=calibrated();nod(m,4000);
  assert.equal(m.totalCandidates,1);
  assert.equal(m.flaggedAt,null);
});
test('two qualifying nods trigger a static safety prompt',()=>{
  const m=calibrated();nod(m,4000);nod(m,12500);
  assert.equal(m.totalCandidates,2);
  assert.ok(m.flaggedAt!==null);
  assert.equal(alertPhase(m.flaggedAt,m.flaggedAt+2000),'check');
  assert.equal(alertPhase(m.flaggedAt,m.flaggedAt+10000),'stop');
});
test('movement while parked never triggers an alert',()=>{
  const m=calibrated(); fill(m,down,4000,10,80,false);fill(m,forward,5000,10,80,false);
  assert.equal(m.totalCandidates,0);assert.equal(m.flaggedAt,null);
});
test('isolated IMU spike does not count as nod',()=>{
  const m=calibrated();fill(m,forward,4000,10,80,true);
  m.observe(down,4800,true);fill(m,forward,4900,10,80,true);
  assert.equal(m.totalCandidates,0);
});
test('sensor feed expiration is surfaced',()=>{
  const m=calibrated();assert.equal(m.sensorFresh(3000),true);assert.equal(m.sensorFresh(7000),false);
});
