export interface MotionSample { x: number; y: number; z: number }

function valid(sample: MotionSample) {
  return [sample.x, sample.y, sample.z].every(Number.isFinite)
}

export function averageMotion(samples: MotionSample[]): MotionSample | null {
  if (samples.length < 5 || samples.some((sample) => !valid(sample))) return null
  return {
    x: samples.reduce((sum, sample) => sum + sample.x, 0) / samples.length,
    y: samples.reduce((sum, sample) => sum + sample.y, 0) / samples.length,
    z: samples.reduce((sum, sample) => sum + sample.z, 0) / samples.length,
  }
}

// The SDK does not specify axis orientation or units. Calibrate a direction
// using actual forward/down poses instead of assuming an Euler pitch axis.
export class HeadNodDetector {
  private neutral: MotionSample | null = null
  private axis = { x: 0, y: 0, z: 0 }
  private lengthSquared = 0
  private dippedAt: number | null = null
  private nods: number[] = []
  private lastAt: number | null = null
  private cooldownUntil = 0
  private settled = false

  calibrate(neutral: MotionSample, down: MotionSample): boolean {
    this.neutral = null
    this.reset()
    if (!valid(neutral) || !valid(down)) return false
    const axis = { x: down.x - neutral.x, y: down.y - neutral.y, z: down.z - neutral.z }
    const lengthSquared = axis.x ** 2 + axis.y ** 2 + axis.z ** 2
    const neutralLength = Math.hypot(neutral.x, neutral.y, neutral.z)
    if (Math.sqrt(lengthSquared) < Math.max(1e-6, neutralLength * 0.08)) return false
    this.neutral = { ...neutral }
    this.axis = axis
    this.lengthSquared = lengthSquared
    this.cooldownUntil = 0
    return true
  }

  reset() {
    this.dippedAt = null
    this.nods = []
    this.lastAt = null
    this.settled = false
  }

  update(sample: MotionSample, now: number, moving: boolean): boolean {
    if (!this.neutral || !moving || !valid(sample) || now < this.cooldownUntil) {
      this.reset()
      return false
    }
    if (this.lastAt != null && (now - this.lastAt > 1000 || now <= this.lastAt)) this.reset()
    this.lastAt = now
    const delta = {
      x: sample.x - this.neutral.x,
      y: sample.y - this.neutral.y,
      z: sample.z - this.neutral.z,
    }
    const depth = (delta.x * this.axis.x + delta.y * this.axis.y + delta.z * this.axis.z) / this.lengthSquared
    const sidewaysSquared = (delta.x - depth * this.axis.x) ** 2
      + (delta.y - depth * this.axis.y) ** 2 + (delta.z - depth * this.axis.z) ** 2
    if (sidewaysSquared > this.lengthSquared * 0.36) {
      this.reset()
      return false
    }
    // Calibration ends head-down. Wait for a forward pose before counting.
    if (!this.settled) {
      if (depth <= 0.25 && depth >= -0.25) this.settled = true
      return false
    }
    this.nods = this.nods.filter((time) => now - time <= 8000)
    if (depth >= 0.6 && this.dippedAt == null) this.dippedAt = now
    if (depth <= 0.25 && this.dippedAt != null) {
      const duration = now - this.dippedAt
      this.dippedAt = null
      // Ignore momentary bumps and prolonged intentional downward looks.
      if (duration >= 350 && duration <= 2500) this.nods.push(now)
      if (this.nods.length >= 2) {
        this.cooldownUntil = now + 30_000
        this.reset()
        return true
      }
    }
    return false
  }
}
