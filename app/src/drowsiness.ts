export interface MotionSample { x: number; y: number; z: number }

// A microsleep nod: the head is still, then sags forward (slowly, as neck
// tone is lost), then snaps back up as the driver jolts awake. Deliberate
// nods, talking, and glances at the dash go down about as fast as they come
// back; bumps and braking show up as acceleration spikes. Two counted nods
// inside the window raise the alert.
export const NOD_MIN_DEG = 10
export const NODS_TO_ALERT = 2
export const NOD_WINDOW_MS = 60_000
// A driver who stays asleep never snaps back, so a head held well below the
// reference raises its own alert, before it could be adopted as a posture.
export const HEAD_DOWN_DEG = 15
export const HEAD_DOWN_MS = 3000
// Rotation axis of head pitch in the G2 sensor frame; positive pitch = chin
// down. "Teach nod direction" on the phone replaces it if a device differs.
export const G2_PITCH_AXIS: MotionSample = { x: 0, y: 1, z: 0 }

const ONSET_DEG = 3
const LEARN_MS = 2500
const LEARN_SPREAD_DEG = 3
const LEARN_MIN_SAMPLES = 5
const CALM_MS = 1500
const CALM_MIN_COVERAGE_MS = 800
const CALM_RANGE_DEG = 5
// Measured between 40% and 85% of the nod's depth, on the way down and back.
const MIN_DROP_MS = 150
const SNAP_RATIO = 1.3
const RETURN_FRACTION = 0.4
const MAX_DOWN_MS = 5000
const MAX_ROLL_DEG = 8
const SHALLOW_REPORT_DEG = 6
// Sensor-noise handling: median-of-3 removes single-sample spikes, then a
// short low-pass. Gravity magnitude jumps mean a bump, not head motion.
const SMOOTH_TAU_MS = 80
const JOLT_RATIO = 0.12
const JOLT_HOLD_MS = 400
const VEHICLE_ACCEL_MPS2 = 1.5
const VEHICLE_HOLD_MS = 2500
// Posture: follow slow drift, and adopt a new steady pose held this long.
const DRIFT_TAU_MS = 20_000
const DRIFT_ZONE_DEG = 4
const REANCHOR_MS = 5000
const REANCHOR_SPREAD_DEG = 3
// Delivery: tolerate bursts sharing one timestamp; long silences interrupt.
const GAP_MS = 2000
const LONG_GAP_MS = 30_000
const MAX_LAG_MS = 1000
const INVALID_STREAK = 5
const HEAD_DOWN_GRACE_MS = 400
const TEACH_MIN_DEG = 12
const TEACH_HOLD_MS = 1000
const TEACH_TIMEOUT_MS = 15_000

export type NodPhase = 'learning' | 'watching' | 'drooping' | 'settling' | 'teaching'
export type NodAlert = 'nods' | 'head-down'

export interface NodEvent {
  at: number
  counted: boolean
  reason: string
  depthDeg: number
  dropMs: number
  riseMs: number
}

interface Point { t: number; pitch: number; roll: number; v: MotionSample }
interface Droop { onset: number; calm: boolean; peak: number; trace: { t: number; p: number }[] }

function magnitude(value: MotionSample) { return Math.hypot(value.x, value.y, value.z) }
function dot(a: MotionSample, b: MotionSample) { return a.x * b.x + a.y * b.y + a.z * b.z }
function normalize(value: MotionSample): MotionSample | null {
  if (![value.x, value.y, value.z].every(Number.isFinite)) return null
  const length = magnitude(value)
  if (length < 1e-6) return null
  return { x: value.x / length, y: value.y / length, z: value.z / length }
}
function cross(a: MotionSample, b: MotionSample): MotionSample {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}
function lerp(a: MotionSample, b: MotionSample, k: number): MotionSample {
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k }
}
function sum(values: MotionSample[]): MotionSample {
  return values.reduce((total, v) => ({ x: total.x + v.x, y: total.y + v.y, z: total.z + v.z }), { x: 0, y: 0, z: 0 })
}
function angle(a: MotionSample, b: MotionSample) {
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI
}
function median3(a: number, b: number, c: number) { return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)) }
function range(values: number[]) { return Math.max(...values) - Math.min(...values) }

// The host forwards protobuf JSON, which omits fields equal to zero; a
// missing axis is 0, not an invalid reading.
export function toMotionSample(raw: unknown): MotionSample | null {
  if (!raw || typeof raw !== 'object') return null
  const fields = raw as Record<string, unknown>
  const read = (value: unknown) => value == null || value === '' ? 0 : Number(value)
  const sample = { x: read(fields.x), y: read(fields.y), z: read(fields.z) }
  return normalize(sample) ? sample : null
}

export class HeadNodDetector {
  private axis: MotionSample = { ...G2_PITCH_AXIS }
  private learnedAxis: MotionSample | null = null
  private neutral: MotionSample | null = null
  private refMagnitude = 0
  private learnBuffer: { t: number; v: MotionSample; m: number }[] = []
  private recent: MotionSample[] = []
  private smooth: MotionSample | null = null
  private lastT: number | null = null
  private lastArrival: number | null = null
  private arrivals: number[] = []
  private history: Point[] = []
  private phase: Exclude<NodPhase, 'learning' | 'teaching'> = 'watching'
  private droop: Droop | null = null
  private nods: number[] = []
  private downSince: number | null = null
  private lastDownAt = 0
  private joltUntil = -Infinity
  private vehicleUntil = -Infinity
  private pitch: number | null = null
  private roll: number | null = null
  private invalidStreak = 0
  private lastEvent: NodEvent | null = null
  private reanchoredAt: number | null = null
  private teach: { startedAt: number | null; buffer: { t: number; v: MotionSample }[] } | null = null
  private sampleRate = 0

  feedback(now = this.lastT ?? 0) {
    const covered = this.learnBuffer.length ? this.learnBuffer[this.learnBuffer.length - 1].t - this.learnBuffer[0].t : 0
    const progress = this.neutral ? 1 : Math.min(1, covered / LEARN_MS)
    return {
      calibrated: this.neutral != null,
      progress,
      countdownSeconds: this.neutral ? 0 : Math.max(1, Math.ceil((1 - progress) * LEARN_MS / 1000)),
      angle: this.pitch,
      roll: this.roll,
      signalValid: this.invalidStreak < INVALID_STREAK,
      phase: (this.teach ? 'teaching' : this.neutral ? this.phase : 'learning') as NodPhase,
      nods: this.nods.filter((time) => now - time <= NOD_WINDOW_MS).length,
      lastEvent: this.lastEvent,
      disturbed: now < this.joltUntil || now < this.vehicleUntil,
      headDownMs: this.downSince == null ? 0 : now - this.downSince,
      poseJustReset: this.reanchoredAt != null && now - this.reanchoredAt < 3000,
      sampleRateHz: this.sampleRate,
    }
  }

  // Drop any half-seen nod and counted nods (alert dismissed, sensor lost);
  // the learned pose is kept.
  reset() {
    this.interrupt(true)
  }

  relearn() {
    this.neutral = null
    this.refMagnitude = 0
    this.learnBuffer = []
    this.teach = null
    this.lastEvent = null
    this.interrupt(true)
  }

  setPitchAxis(axis: MotionSample): boolean {
    const normalized = normalize(axis)
    if (!normalized) return false
    this.axis = normalized
    this.interrupt(true)
    return true
  }

  // Next steady look-down (held ~1s) defines which way is "chin down".
  teachDownDirection(): boolean {
    if (!this.neutral) return false
    this.teach = { startedAt: null, buffer: [] }
    this.interrupt(false)
    return true
  }

  // Returns the axis learned by teachDownDirection once, for persistence.
  takeLearnedAxis(): MotionSample | null {
    const axis = this.learnedAxis
    this.learnedAxis = null
    return axis
  }

  // Phone GPS acceleration/braking tilts the gravity reading like a nod does.
  noteVehicleAcceleration(mps2: number, now: number) {
    if (Number.isFinite(mps2) && Math.abs(mps2) >= VEHICLE_ACCEL_MPS2) this.vehicleUntil = now + VEHICLE_HOLD_MS
  }

  private interrupt(forgetNods: boolean) {
    this.droop = null
    this.phase = 'settling'
    this.history = []
    this.downSince = null
    if (forgetNods) this.nods = []
  }

  private clock(arrival: number): number {
    const gap = this.lastArrival == null ? Infinity : arrival - this.lastArrival
    if (gap > GAP_MS) {
      this.interrupt(gap > LONG_GAP_MS)
      this.arrivals = []
      this.recent = []
      this.smooth = null
      this.learnBuffer = []
      this.lastT = null
    }
    this.lastArrival = this.lastArrival == null ? arrival : Math.max(arrival, this.lastArrival)
    this.arrivals.push(arrival)
    this.arrivals = this.arrivals.filter((time) => this.lastArrival! - time <= 3000)
    // Samples per elapsed time, not counting the first arrival's burst.
    const first = this.arrivals[0]
    const span = this.arrivals[this.arrivals.length - 1] - first
    const later = this.arrivals.filter((time) => time > first).length
    const interval = later >= 2 && span > 0 ? Math.min(500, Math.max(5, span / later)) : 100
    this.sampleRate = later >= 2 && span > 0 ? 1000 / interval : 0
    // Samples delivered in a burst get spaced by the measured interval,
    // never later than their arrival and never more than a second behind.
    const t = this.lastT == null ? arrival
      : Math.max(this.lastT + 1, Math.min(arrival, Math.max(this.lastT + interval, arrival - MAX_LAG_MS)))
    return t
  }

  update(raw: MotionSample | null, arrival: number, enabled = true): NodAlert | null {
    if (!enabled) {
      this.interrupt(true)
      return null
    }
    const unit = raw && normalize(raw)
    if (!raw || !unit) {
      if (++this.invalidStreak >= INVALID_STREAK) this.interrupt(true)
      return null
    }
    this.invalidStreak = 0
    const t = this.clock(arrival)
    const dt = this.lastT == null ? 0 : t - this.lastT
    const previous = this.history.length ? this.history[this.history.length - 1] : null
    this.lastT = t

    this.recent.push(unit)
    if (this.recent.length > 3) this.recent.shift()
    const [a, b, c] = this.recent.length === 3 ? this.recent : [unit, unit, unit]
    const filtered = normalize({ x: median3(a.x, b.x, c.x), y: median3(a.y, b.y, c.y), z: median3(a.z, b.z, c.z) }) ?? unit
    const k = this.smooth == null ? 1 : 1 - Math.exp(-dt / SMOOTH_TAU_MS)
    this.smooth = normalize(lerp(this.smooth ?? filtered, filtered, k)) ?? filtered
    const v = this.smooth
    const rawMagnitude = magnitude(raw)

    if (!this.neutral) {
      this.learn(t, v, rawMagnitude)
      return null
    }

    const ratio = rawMagnitude / this.refMagnitude
    if (Math.abs(ratio - 1) > JOLT_RATIO) this.joltUntil = t + JOLT_HOLD_MS
    else if (Math.abs(ratio - 1) < 0.05) this.refMagnitude += (rawMagnitude - this.refMagnitude) * (1 - Math.exp(-dt / 10_000))

    const { pitch, roll } = this.measure(v)
    this.pitch = pitch
    this.roll = roll
    this.history.push({ t, pitch, roll, v })
    this.history = this.history.filter((point) => t - point.t <= REANCHOR_MS + 500)

    if (this.teach) {
      this.teachStep(t, v)
      return null
    }

    // Bumps may lift the head briefly; only a real return clears the timer.
    if (pitch >= HEAD_DOWN_DEG) {
      this.downSince ??= t
      this.lastDownAt = t
    } else if (this.downSince != null && t - this.lastDownAt > HEAD_DOWN_GRACE_MS) {
      this.downSince = null
    }
    if (this.downSince != null && t - this.downSince >= HEAD_DOWN_MS) {
      this.lastEvent = { at: t, counted: true, reason: 'head stayed down', depthDeg: pitch, dropMs: 0, riseMs: 0 }
      this.interrupt(true)
      return 'head-down'
    }

    const disturbed = t < this.joltUntil || t < this.vehicleUntil
    let alert: NodAlert | null = null
    if (this.phase === 'watching') {
      if (pitch > ONSET_DEG) {
        this.phase = 'drooping'
        this.droop = {
          onset: t,
          calm: !disturbed && this.calmBefore(t),
          peak: pitch,
          trace: previous ? [{ t: previous.t, p: previous.pitch }, { t, p: pitch }] : [{ t, p: pitch }],
        }
      } else if (!disturbed && Math.abs(pitch) <= DRIFT_ZONE_DEG && Math.abs(roll) <= DRIFT_ZONE_DEG) {
        this.neutral = normalize(lerp(this.neutral, v, 1 - Math.exp(-dt / DRIFT_TAU_MS))) ?? this.neutral
      }
    } else if (this.phase === 'drooping' && this.droop) {
      const droop = this.droop
      droop.trace.push({ t, p: pitch })
      droop.peak = Math.max(droop.peak, pitch)
      if (pitch <= Math.max(ONSET_DEG, RETURN_FRACTION * droop.peak)) {
        if (this.finishDroop(t, droop)) alert = 'nods'
      } else if (disturbed) {
        this.reject(t, droop, 'bump, braking or acceleration')
      } else if (Math.abs(roll) > Math.max(MAX_ROLL_DEG, 0.6 * droop.peak)) {
        this.reject(t, droop, 'head tipped sideways')
      } else if (t - droop.onset > MAX_DOWN_MS) {
        this.reject(t, droop, 'head stayed down (looking down or a new posture)')
      }
    } else if (this.phase === 'settling' && Math.abs(pitch) <= ONSET_DEG) {
      this.phase = 'watching'
    }

    if (this.phase !== 'drooping') this.reanchor(t)
    return alert
  }

  private measure(v: MotionSample) {
    const neutral = this.neutral!
    const along = (u: MotionSample) => {
      const c = dot(u, this.axis)
      return normalize({ x: u.x - this.axis.x * c, y: u.y - this.axis.y * c, z: u.z - this.axis.z * c })
    }
    const n = along(neutral)
    const u = along(v)
    const pitch = n && u ? Math.atan2(dot(this.axis, cross(n, u)), dot(n, u)) * 180 / Math.PI : 0
    const asinDeg = (value: number) => Math.asin(Math.max(-1, Math.min(1, value))) * 180 / Math.PI
    const roll = asinDeg(dot(v, this.axis)) - asinDeg(dot(neutral, this.axis))
    return { pitch, roll }
  }

  private learn(t: number, v: MotionSample, m: number) {
    this.learnBuffer.push({ t, v, m })
    // Keep the longest recent stretch that stays within the allowed spread.
    for (;;) {
      const mean = normalize(sum(this.learnBuffer.map((entry) => entry.v)))
      if (mean && this.learnBuffer.every((entry) => angle(entry.v, mean) <= LEARN_SPREAD_DEG)) break
      this.learnBuffer.shift()
    }
    const first = this.learnBuffer[0]
    if (t - first.t >= LEARN_MS && this.learnBuffer.length >= LEARN_MIN_SAMPLES) {
      this.neutral = normalize(sum(this.learnBuffer.map((entry) => entry.v)))
      const sorted = this.learnBuffer.map((entry) => entry.m).sort((x, y) => x - y)
      this.refMagnitude = sorted[Math.floor(sorted.length / 2)]
      this.learnBuffer = []
      this.history = []
      this.phase = 'watching'
      this.pitch = 0
      this.roll = 0
    }
  }

  private calmBefore(t: number): boolean {
    const window = this.history.filter((point) => point.t < t && t - point.t <= CALM_MS)
    if (window.length < 3 || t - window[0].t < CALM_MIN_COVERAGE_MS) return false
    return range(window.map((point) => point.pitch)) <= CALM_RANGE_DEG
      && range(window.map((point) => point.roll)) <= CALM_RANGE_DEG
  }

  private finishDroop(t: number, droop: Droop): boolean {
    this.droop = null
    this.phase = 'settling'
    if (droop.peak < NOD_MIN_DEG) {
      if (droop.peak >= SHALLOW_REPORT_DEG) this.record(t, droop, false, `too shallow (needs ${NOD_MIN_DEG}°)`, 0, 0)
      return false
    }
    const trace = droop.trace
    const lo = RETURN_FRACTION * droop.peak
    const hi = 0.85 * droop.peak
    const at = (i: number, j: number, level: number) => {
      const a = trace[i], b = trace[j]
      return a.p === b.p ? b.t : a.t + (level - a.p) / (b.p - a.p) * (b.t - a.t)
    }
    const up = (level: number) => {
      const i = trace.findIndex((point) => point.p >= level)
      return i <= 0 ? trace[Math.max(0, i)].t : at(i - 1, i, level)
    }
    const down = (level: number) => {
      let i = trace.length - 1
      while (i > 0 && trace[i].p < level) i--
      return i >= trace.length - 1 ? trace[i].t : at(i, i + 1, level)
    }
    const dropMs = up(hi) - up(lo)
    const riseMs = down(lo) - down(hi)
    if (!droop.calm) return this.record(t, droop, false, 'head was already moving (talking or looking around)', dropMs, riseMs)
    if (dropMs < MIN_DROP_MS) return this.record(t, droop, false, 'dropped too fast (bump or deliberate nod)', dropMs, riseMs)
    if (riseMs * SNAP_RATIO > dropMs) return this.record(t, droop, false, 'no snap back up (came up as slowly as it went down)', dropMs, riseMs)
    this.record(t, droop, true, 'microsleep nod', dropMs, riseMs)
    this.nods = this.nods.filter((time) => t - time <= NOD_WINDOW_MS)
    this.nods.push(t)
    if (this.nods.length < NODS_TO_ALERT) return false
    this.nods = []
    return true
  }

  private reject(t: number, droop: Droop, reason: string) {
    this.droop = null
    this.phase = 'settling'
    if (droop.peak >= NOD_MIN_DEG) this.record(t, droop, false, reason, 0, 0)
  }

  private record(t: number, droop: Droop, counted: boolean, reason: string, dropMs: number, riseMs: number): false {
    this.lastEvent = { at: t, counted, reason, depthDeg: droop.peak, dropMs: Math.round(dropMs), riseMs: Math.round(riseMs) }
    return false
  }

  private reanchor(t: number) {
    const window = this.history.filter((point) => t - point.t <= REANCHOR_MS)
    if (window.length < 5 || t - window[0].t < REANCHOR_MS * 0.9) return
    const pitches = window.map((point) => point.pitch)
    const rolls = window.map((point) => point.roll)
    if (range(pitches) > REANCHOR_SPREAD_DEG || range(rolls) > REANCHOR_SPREAD_DEG) return
    const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length
    if (Math.abs(mean(pitches)) <= ONSET_DEG && Math.abs(mean(rolls)) <= ONSET_DEG) return
    this.neutral = normalize(sum(window.map((point) => point.v))) ?? this.neutral
    this.history = []
    this.droop = null
    this.phase = 'watching'
    this.pitch = 0
    this.roll = 0
    this.reanchoredAt = t
  }

  private teachStep(t: number, v: MotionSample) {
    const teach = this.teach!
    teach.startedAt ??= t
    if (t - teach.startedAt > TEACH_TIMEOUT_MS) {
      this.teach = null
      return
    }
    if (angle(v, this.neutral!) < TEACH_MIN_DEG) {
      teach.buffer = []
      return
    }
    teach.buffer.push({ t, v })
    const mean = normalize(sum(teach.buffer.map((entry) => entry.v)))
    if (!mean || teach.buffer.some((entry) => angle(entry.v, mean) > REANCHOR_SPREAD_DEG)) {
      teach.buffer = [{ t, v }]
      return
    }
    if (t - teach.buffer[0].t < TEACH_HOLD_MS) return
    const axis = normalize(cross(this.neutral!, mean))
    this.teach = null
    if (!axis) return
    this.axis = axis
    this.learnedAxis = axis
    this.interrupt(true)
  }
}
