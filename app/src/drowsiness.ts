export interface MotionSample { x: number; y: number; z: number }

export const NOD_ANGLE_DEG = 8
export const NOD_COOLDOWN_MS = 750
// Default G2 pitch plane. Kept explicit so device/firmware polarity can be
// checked on hardware; a device-specific mapping can override it in code.
export const G2_DOWN_AXIS: MotionSample = { x: 0, y: 1, z: 0 }
const LEARN_MS = 3000
const MIN_SAMPLES = 12

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
function project(sample: MotionSample, axis: MotionSample) {
  const component = dot(sample, axis)
  return normalize({ x: sample.x - axis.x * component, y: sample.y - axis.y * component, z: sample.z - axis.z * component })
}
function angle(a: MotionSample, b: MotionSample) {
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI
}

// Signed pitch around the configured device axis. Neutral pose learning is
// automatic; slow reference tracking is frozen during a possible head bob.
export class HeadNodDetector {
  private neutral: MotionSample | null = null
  private neutralMagnitude = 0
  private learning: { sample: MotionSample; magnitude: number; at: number }[] = []
  private learningProgress = 0
  private dippedAt: number | null = null
  private downAxis: MotionSample = { ...G2_DOWN_AXIS }
  private nods: number[] = []
  private lastAt: number | null = null
  private nodCooldownUntil = 0
  private settled = false
  private tilt: number | null = null
  private signalValid = true
  private previousSample: MotionSample | null = null
  private previousSampleAt: number | null = null
  private freezeReferenceUntil = 0

  feedback(now = Date.now()) {
    return {
      calibrated: this.neutral != null,
      progress: this.learningProgress,
      countdownSeconds: this.neutral ? 0 : Math.max(1, Math.ceil(Math.round((1 - this.learningProgress) * LEARN_MS) / 1000)),
      angle: this.tilt,
      signalValid: this.signalValid,
      settled: this.settled,
      nods: this.nods.filter((time) => now - time <= 8000).length,
      nodCooldownMs: Math.max(0, this.nodCooldownUntil - now),
    }
  }

  // Clear an interrupted sequence without learning a potentially slumped pose.
  reset() {
    this.dippedAt = null
    this.nods = []
    this.lastAt = null
    this.settled = false
    this.tilt = null
    this.learning = []
    this.learningProgress = 0
    this.previousSample = null
    this.previousSampleAt = null
  }

  relearn() {
    this.neutral = null
    this.neutralMagnitude = 0
    this.reset()
  }

  setDownAxis(axis: MotionSample): boolean {
    const normalized = normalize(axis)
    if (!normalized) return false
    this.downAxis = normalized
    this.reset()
    return true
  }

  private learn(sample: MotionSample, sampleMagnitude: number, now: number) {
    this.learning.push({ sample, magnitude: sampleMagnitude, at: now })
    this.learning = this.learning.filter((entry) => now - entry.at <= LEARN_MS + 500).slice(-100)
    const mean = normalize(this.learning.reduce((sum, entry) => ({
      x: sum.x + entry.sample.x, y: sum.y + entry.sample.y, z: sum.z + entry.sample.z,
    }), { x: 0, y: 0, z: 0 }))
    if (!mean) { this.learning = []; this.learningProgress = 0; return }
    const averageMagnitude = this.learning.reduce((sum, entry) => sum + entry.magnitude, 0) / this.learning.length
    const rmsAngle = Math.sqrt(this.learning.reduce((sum, entry) => sum + angle(entry.sample, mean) ** 2, 0) / this.learning.length)
    const steady = rmsAngle <= 4 && this.learning.every((entry) =>
      angle(entry.sample, mean) <= 10 && Math.abs(entry.magnitude / averageMagnitude - 1) <= 0.2,
    )
    if (!steady) {
      this.learning = [{ sample, magnitude: sampleMagnitude, at: now }]
      this.learningProgress = 0
      return
    }
    const elapsed = now - this.learning[0].at
    this.learningProgress = Math.min(1, elapsed / LEARN_MS, this.learning.length / MIN_SAMPLES)
    if (elapsed >= LEARN_MS && this.learning.length >= MIN_SAMPLES) {
      this.neutral = mean
      this.neutralMagnitude = averageMagnitude
      this.learning = []
      this.settled = true
      this.tilt = 0
    }
  }

  update(raw: MotionSample, now: number, enabled = true): boolean {
    const sample = normalize(raw)
    if (!enabled || !sample) {
      this.reset()
      this.signalValid = sample != null
      return false
    }
    this.signalValid = true
    if (this.lastAt != null && (now - this.lastAt > 3000 || now <= this.lastAt)) this.reset()
    this.lastAt = now
    if (!this.neutral) {
      this.learn(sample, magnitude(raw), now)
      return false
    }
    if (Math.abs(magnitude(raw) / this.neutralMagnitude - 1) > 0.25) {
      this.reset()
      this.signalValid = false
      return false
    }
    const elapsedMs = this.previousSampleAt == null ? 0 : now - this.previousSampleAt
    if (this.previousSample && elapsedMs > 0 && elapsedMs <= 500
      && angle(this.previousSample, sample) / (elapsedMs / 1000) > 15) {
      this.freezeReferenceUntil = now + 1500
    }
    this.previousSample = sample
    this.previousSampleAt = now
    const neutralPitch = project(this.neutral, this.downAxis)
    const currentPitch = project(sample, this.downAxis)
    if (!neutralPitch || !currentPitch) {
      this.reset()
      this.signalValid = false
      return false
    }
    this.tilt = Math.atan2(dot(this.downAxis, cross(neutralPitch, currentPitch)), dot(neutralPitch, currentPitch)) * 180 / Math.PI
    const lateral = (Math.asin(Math.max(-1, Math.min(1, dot(sample, this.downAxis))))
      - Math.asin(Math.max(-1, Math.min(1, dot(this.neutral, this.downAxis))))) * 180 / Math.PI
    // Follow a gradual incline at <=0.35°/s with a ten-second time constant.
    // Never track a large departure, fast bob, pending nod, or nod cooldown.
    if (elapsedMs > 0 && elapsedMs <= 500 && now >= this.freezeReferenceUntil
      && now >= this.nodCooldownUntil && this.dippedAt == null
      && !this.nods.some((time) => now - time <= 8000)
      && Math.abs(this.tilt) <= 6 && Math.abs(lateral) <= 6) {
      const seconds = elapsedMs / 1000
      const adjustment = Math.max(-0.35 * seconds, Math.min(0.35 * seconds, this.tilt * (1 - Math.exp(-seconds / 10))))
      const radians = adjustment * Math.PI / 180
      const orthogonal = cross(this.downAxis, this.neutral)
      const parallel = dot(this.downAxis, this.neutral) * (1 - Math.cos(radians))
      this.neutral = normalize({
        x: this.neutral.x * Math.cos(radians) + orthogonal.x * Math.sin(radians) + this.downAxis.x * parallel,
        y: this.neutral.y * Math.cos(radians) + orthogonal.y * Math.sin(radians) + this.downAxis.y * parallel,
        z: this.neutral.z * Math.cos(radians) + orthogonal.z * Math.sin(radians) + this.downAxis.z * parallel,
      })!
      this.tilt -= adjustment
    }
    if (now < this.nodCooldownUntil) {
      this.dippedAt = null
      this.settled = false
      return false
    }
    // Upward or sideways motion cancels a pending dip and cannot count.
    if (this.tilt < -3 || this.tilt > 45 || Math.abs(lateral) > Math.max(6, this.tilt * 0.6)) {
      this.dippedAt = null
      this.settled = false
      return false
    }
    if (!this.settled) {
      if (Math.abs(this.tilt) <= 3 && Math.abs(lateral) <= 6) this.settled = true
      return false
    }
    this.nods = this.nods.filter((time) => now - time <= 8000)
    if (this.tilt >= NOD_ANGLE_DEG && this.dippedAt == null) {
      this.dippedAt = now
    }
    if (Math.abs(this.tilt) <= 3 && this.dippedAt != null) {
      const duration = now - this.dippedAt
      this.dippedAt = null
      if (duration >= 180 && duration <= 3000) {
        this.nods.push(now)
        this.nodCooldownUntil = now + NOD_COOLDOWN_MS
        this.settled = false
      }
      if (this.nods.length >= 2) {
        this.reset()
        return true
      }
    }
    return false
  }
}
