const MPS_TO_MPH = 2.23694
const MAX_ACCEL_MPS2 = 8
const SMOOTHING = 0.4

// Filter isolated GPS spikes and smooth accepted readings.
export function createSpeedFilter() {
  let lastMps: number | null = null
  let lastAt: number | null = null
  let smoothedMph: number | null = null

  return (speedMps: number | null, now = Date.now()): number | null => {
    if (speedMps == null || !Number.isFinite(speedMps) || speedMps < 0) {
      lastMps = null
      lastAt = null
      smoothedMph = null
      return null
    }
    if (lastMps != null && lastAt != null && smoothedMph != null) {
      const seconds = (now - lastAt) / 1000
      if (seconds > 0 && Math.abs(speedMps - lastMps) / seconds > MAX_ACCEL_MPS2) {
        return smoothedMph
      }
    }
    lastMps = speedMps
    lastAt = now
    const mph = speedMps * MPS_TO_MPH
    smoothedMph = smoothedMph == null ? mph : smoothedMph + SMOOTHING * (mph - smoothedMph)
    return smoothedMph
  }
}
