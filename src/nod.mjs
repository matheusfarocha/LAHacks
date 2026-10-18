// Experimental head-movement pattern recognition for the Even G2 IMU.
// The SDK provides gravity-like x/y/z samples but DOES NOT provide validated
// drowsiness, eye closure, sleep or driver-alertness measurements.
// This module deliberately does not label a driver "awake" or "asleep".
// All tuning constants are research heuristics, not clinically validated.

const vec = (x) => [x.x, x.y, x.z];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const subtract = (a,b) => a.map((x,i) => x-b[i]);
const magnitude = (a) => Math.sqrt(dot(a,a));
const divide = (a,n) => a.map(x => x/n);

export function normalizeImu(input) {
  if (!input || ![input.x,input.y,input.z].every(Number.isFinite)) return null;
  const v = vec(input), m = magnitude(v);
  // The G2 gravity vector is ~1g at rest in some firmware implementations.
  // Reject unlikely magnitudes, including strong bumps and sensor glitches.
  if (m < 0.65 || m > 1.5) return null;
  return divide(v,m);
}

export function alertPhase(flaggedAt, now) {
  if (!Number.isFinite(flaggedAt)) return 'none';
  // Static escalation only. Do NOT flash or strobe a driving display.
  return now - flaggedAt < 10_000 ? 'check' : 'stop';
}

export class HeadNodMonitor {
  constructor() {
    this.samples = [];
    this.neutral = null;
    this.downUnit = null;
    this.downAmplitude = 0;
    this.lastSampleAt = null;
    this.smoothed = null;
    this.dipStartedAt = null;
    this.dipLastAt = null;
    this.dipQualified = false;
    this.dipCounted = false;
    this.lastCandidateAt = null;
    this.recentCandidates = [];
    this.totalCandidates = 0;
    this.flaggedAt = null;
    this.error = '';
  }
  get calibrated() { return !!this.neutral && !!this.downUnit; }
  get sensorAvailable() { return this.lastSampleAt != null; }
  sensorFresh(now) { return this.lastSampleAt !== null && now - this.lastSampleAt <= 2500 && now >= this.lastSampleAt; }
  // Capture only while parked, with the driver deliberately holding still.
  captureVector(now) {
    const recent = this.samples.filter(s => now >= s.at && now-s.at <= 1600).slice(-20);
    if (recent.length < 5) { this.error='Not enough IMU readings. Try again.'; return null; }
    const avg = [0,1,2].map(i => recent.reduce((sum,s)=>sum+s.v[i],0)/recent.length);
    const norm = magnitude(avg);
    if (norm < 0.2) { this.error='Unstable IMU reading. Hold still.'; return null; }
    this.error='';
    return divide(avg,norm);
  }
  captureNeutral(now) {
    const value=this.captureVector(now);
    if (!value) return false;
    this.neutral=value;
    this.downUnit=null;
    this.error='';
    return true;
  }
  captureDown(now) {
    if (!this.neutral) {this.error='Capture forward position first.'; return false;}
    const down=this.captureVector(now);
    if (!down) return false;
    const delta=subtract(down,this.neutral);
    const amp=magnitude(delta);
    if (amp < 0.18 || amp > 1.25) {
      this.error='Movement too small or too large. Look down naturally.';
      return false;
    }
    this.downUnit=divide(delta,amp);
    this.downAmplitude=amp;
    this.dipStartedAt=null;
    this.dipCounted=false;
    this.dipQualified=false;
    this.recentCandidates=[];
    this.flaggedAt=null;
    this.error='';
    return true;
  }
  startCalibration() {
    this.neutral=null; this.downUnit=null; this.downAmplitude=0;
    this.error=''; this.dipStartedAt=null; this.dipQualified=false;
    this.recentCandidates=[]; this.flaggedAt=null;
  }
  clearAlert() {
    this.flaggedAt=null;
    this.recentCandidates=[];
    this.lastCandidateAt=null;
    this.dipStartedAt=null;
    this.dipCounted=false;
    this.dipQualified=false;
  }
  invalidateStream() {
    this.lastSampleAt=null;
    this.samples=[];
    this.smoothed=null;
    this.dipStartedAt=null;
    this.dipQualified=false;
    this.dipCounted=false;
  }
  observe(sample, now, moving) {
    const v=normalizeImu(sample);
    if (!v || !Number.isFinite(now)) return { candidate:false, flagged:false };
    // When the stream stalls, clear transient motion and smoothing.
    if (this.lastSampleAt !== null && (now-this.lastSampleAt > 1200 || now<this.lastSampleAt)) {
      this.smoothed=null;
      this.dipStartedAt=null;
      this.dipCounted=false;
    }
    this.lastSampleAt=now;
    this.samples.push({v,at:now});
    if (this.samples.length>60) this.samples.shift();
    // Filtering dampens brief car bumps and high-frequency motion.
    this.smoothed = this.smoothed == null ? v : divide(
      this.smoothed.map((x,i)=>x*0.72+v[i]*0.28),
      magnitude(this.smoothed.map((x,i)=>x*0.72+v[i]*0.28))
    );
    if (!this.calibrated || !moving || this.flaggedAt !== null) {
      this.dipStartedAt=null;
      this.dipCounted=false;
      this.dipQualified=false;
      return { candidate:false, flagged:false };
    }
    const delta=subtract(this.smoothed,this.neutral);
    const amp=magnitude(delta);
    const forward=dot(delta,this.downUnit);
    const alignment=amp > 0.0001 ? forward/amp : 0;
    // Pattern is calibrated, multi-sample motion specifically toward 'down'.
    const dipped = forward >= Math.max(0.10,this.downAmplitude*0.48)
        && alignment >= 0.73;
    const returned = amp < this.downAmplitude * 0.24;
    let candidate=false;
    if (dipped) {
      if (this.dipStartedAt===null) this.dipStartedAt=now;
      this.dipLastAt=now;
      const duration=now-this.dipStartedAt;
      if (duration >= 180) this.dipQualified=true;
      // A sustained downward position is also suspicious, but not proof.
      if (duration>=1900 && !this.dipCounted) {
        candidate=this.countCandidate(now);
        this.dipCounted=true;
      }
    } else if (this.dipStartedAt!==null) {
      const duration=now-this.dipStartedAt;
      if (returned && this.dipQualified && duration<=2700 && !this.dipCounted) {
        candidate=this.countCandidate(now);
        this.dipStartedAt=null;
        this.dipQualified=false;
        this.dipCounted=false;
      } else if (duration > 2800 || (returned && !this.dipQualified)) {
        this.dipStartedAt=null;
        this.dipQualified=false;
        this.dipCounted=false;
      }
    }
    return {candidate, flagged:this.flaggedAt===now};
  }
  countCandidate(now) {
    // Refractory gap avoids counting a single nod as many independent events.
    if (this.lastCandidateAt!==null && now-this.lastCandidateAt < 4500) return false;
    this.lastCandidateAt=now;
    this.totalCandidates++;
    this.recentCandidates=this.recentCandidates.filter(t=> now-t <= 180_000);
    this.recentCandidates.push(now);
    if (this.recentCandidates.length>=2 && this.flaggedAt===null) this.flaggedAt=now;
    return true;
  }
}
