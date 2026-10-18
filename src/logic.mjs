// Pure logic, deliberately independent of the glasses SDK so it is testable.
export const MPH_PER_MPS = 2.2369362921;
export const STALE_LOCATION_MS = 10_000;
export const STATIONARY_MPH = 3;
export const MOVING_MPH = 5;
export const BREAK_AFTER_MS = 90 * 60_000;
export const BREAK_DURATION_MS = 10 * 60_000;

export function mphFromMps(speedMps) {
  if (!Number.isFinite(speedMps) || speedMps < 0 || speedMps > 85) return null;
  return speedMps * MPH_PER_MPS;
}
export function isLocationFresh(lastAt, now) {
  return Number.isFinite(lastAt) && now >= lastAt && now-lastAt <= STALE_LOCATION_MS;
}
export function isStationary(speedMph, lastAt, now) {
  return isLocationFresh(lastAt, now) && Number.isFinite(speedMph) && speedMph <= STATIONARY_MPH;
}
export function isMoving(speedMph, lastAt, now) {
  return isLocationFresh(lastAt, now) && Number.isFinite(speedMph) && speedMph >= MOVING_MPH;
}
export function formatDuration(ms) {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m`;
}

// This estimates time since a meaningful parked rest. It is not a measure
// of fatigue or a recommendation that the user is safe to continue driving.
export class BreakReminder {
  constructor() {
    this.startedAt = null;
    this.lastMovementAt = null;
    this.accumulatedMovingMs = 0;
    this.lastTickAt = null;
    this.parkedSince = null;
    this.breaks = 0;
  }
  update(now, moving, stationary) {
    if (this.lastTickAt !== null && now >= this.lastTickAt && moving) {
      // Only count bounded intervals: lifecycle pauses aren't reliably monitored.
      this.accumulatedMovingMs += Math.min(now-this.lastTickAt, 8_000);
    }
    if (moving) {
      if (this.startedAt === null) this.startedAt = now;
      this.lastMovementAt = now;
      this.parkedSince = null;
    } else if (stationary) {
      if (this.parkedSince === null) this.parkedSince = now;
      if (this.lastMovementAt !== null && now-this.parkedSince >= BREAK_DURATION_MS) {
        this.accumulatedMovingMs = 0;
        this.parkedSince = null;
        this.lastMovementAt = null;
        this.breaks += 1;
      }
    } else {
      this.parkedSince = null; // unknown GPS ≠ proof of a rest
    }
    this.lastTickAt = now;
  }
  get needsBreak() { return this.accumulatedMovingMs >= BREAK_AFTER_MS; }
  get remainingMs() { return Math.max(0, BREAK_AFTER_MS - this.accumulatedMovingMs); }
}
