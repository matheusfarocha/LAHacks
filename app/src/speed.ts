// Stateful glue between the location stream (even.ts) and the pure OSM
// lookup (osm.ts). Speed/heading/trip update on every location callback;
// the (comparatively expensive, shared-public-service) Overpass lookup only
// re-fires when position has moved meaningfully or a timeout elapsed — see
// the design doc for why these two rates are deliberately decoupled.
import type { Runtime, RawLocation } from './even.ts'
import { lookupDrivingInfo, haversineMeters, type LimitSource } from './osm.ts'

const MOVE_THRESHOLD_M = 120 // within the designed 100-150m range
// Empirically tested against the real overpass-api.de (real browser fetch,
// not Node — see osm.ts's UA comment): 8s produced persistent HTTP 429s and
// even a hung connection within 30s. 15s ran clean for a full 3-minute
// trial, 12/12 requests succeeded (with latency ranging ~500ms-13s, so this
// is a floor, not a comfortable margin — don't tighten further without
// re-testing the same way). This mainly affects low-speed/idling cadence;
// the move-based trigger already covers highway speeds.
const LOOKUP_TIMEOUT_MS = 15_000
const MPS_TO_MPH = 2.23694
const METERS_TO_MILES = 1 / 1609.34
// Raw GPS speed readings are noisy sample-to-sample (a known artifact,
// worse with a marginal fix) — a bad single sample otherwise shows up
// directly on the display. Two independent guards, not one:
//  - reject implausible jumps (>0.8g equivalent) as glitches, not real
//    driving, but still track them as "last raw" so a genuine sustained
//    hard acceleration doesn't get stuck rejected forever;
//  - light EMA smoothing on top, so accepted samples don't jitter either.
// "More satellites" isn't something this app controls — AppLocationAccuracy
// .High already asks Android/GNSS for its best fix; this is the computation
// side, which is what's actually ours to improve.
const MAX_PLAUSIBLE_ACCEL_MPS2 = 8
const SPEED_EMA_ALPHA = 0.4

export type CompassLabel = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW'
const COMPASS: CompassLabel[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

export function headingToCompass(deg: number): CompassLabel {
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8
  return COMPASS[idx]
}

export interface DrivingState {
  speedMph: number | null
  heading: CompassLabel | null
  limitMph: number | null
  limitSource: LimitSource | 'pending'
  roadName: string | null
  cameraDistanceM: number | null
  tripMiles: number
  tripSeconds: number
}

const initialState: DrivingState = {
  speedMph: null, heading: null, limitMph: null, limitSource: 'pending',
  roadName: null, cameraDistanceM: null, tripMiles: 0, tripSeconds: 0,
}

// Returns a stop function. Stopping only silences further onUpdate calls —
// there's no real unsubscribe plumbed through the SDK wrapper, because this
// app starts tracking once at launch and runs it for the app's whole
// lifetime (see the design doc's Open Question); a soft stop is enough.
//
// onDebugEvent is injected rather than imported (this module stays
// decoupled from api.ts, which reads import.meta.env — a Vite-only global
// that doesn't exist when this file runs directly under plain Node in
// test.mts) — main.ts wires it to api.debugLog; tests just omit it.
export function startSpeedTracking(
  rt: Runtime,
  onUpdate: (state: DrivingState) => void,
  onDebugEvent: (event: Record<string, unknown>) => void = () => {},
): () => void {
  let stopped = false
  let state: DrivingState = { ...initialState }

  let tripMeters = 0
  let tripStartedAt: number | null = null
  let lastPos: { lat: number; lon: number } | null = null
  let lastLookupPos: { lat: number; lon: number } | null = null
  let lastLookupAt = 0
  let lookupInFlight = false

  let lastRawSpeedMps: number | null = null
  let lastRawSpeedAt: number | null = null
  let smoothedSpeedMph: number | null = null

  function processSpeed(speedMps: number | null): number | null {
    if (speedMps == null) return smoothedSpeedMph
    const now = Date.now()
    if (lastRawSpeedMps != null && lastRawSpeedAt != null && smoothedSpeedMph != null) {
      const dtS = (now - lastRawSpeedAt) / 1000
      if (dtS > 0 && Math.abs(speedMps - lastRawSpeedMps) / dtS > MAX_PLAUSIBLE_ACCEL_MPS2) {
        // Reference point deliberately NOT updated here — a lone glitch
        // shouldn't poison the comparison for the next real sample too.
        // Genuine sustained acceleration (e.g. merging onto a motorway)
        // still resolves itself: each rejection leaves the reference at the
        // same point, so dtS keeps growing across readings until enough
        // real time has passed that the implied acceleration drops back
        // under the threshold and it's accepted, catching up to reality.
        return smoothedSpeedMph
      }
    }
    lastRawSpeedMps = speedMps
    lastRawSpeedAt = now
    const mph = speedMps * MPS_TO_MPH
    smoothedSpeedMph = smoothedSpeedMph == null ? mph : smoothedSpeedMph + SPEED_EMA_ALPHA * (mph - smoothedSpeedMph)
    return smoothedSpeedMph
  }

  function emit() {
    if (!stopped) onUpdate({ ...state })
  }

  async function maybeLookup(lat: number, lon: number) {
    if (lookupInFlight) return
    const now = Date.now()
    const movedEnough = !lastLookupPos || haversineMeters(lat, lon, lastLookupPos.lat, lastLookupPos.lon) > MOVE_THRESHOLD_M
    const timedOut = now - lastLookupAt > LOOKUP_TIMEOUT_MS
    if (!movedEnough && !timedOut) return

    lookupInFlight = true
    try {
      const info = await lookupDrivingInfo(lat, lon)
      if (stopped) return
      state = { ...state, limitMph: info.limitMph, limitSource: info.limitSource, roadName: info.roadName, cameraDistanceM: info.cameraDistanceM }
      lastLookupPos = { lat, lon }
      lastLookupAt = now
      emit()
      onDebugEvent({
        type: 'lookup', lat, lon,
        chosen: { name: info.roadName, highway: info.highway, distanceM: info.distanceM },
        limitMph: info.limitMph, limitSource: info.limitSource, cameraDistanceM: info.cameraDistanceM,
        candidates: info.candidates,
      })
    } catch (e: any) {
      // A failed/slow lookup keeps the previous cached limit/camera state —
      // this is a non-critical background enhancement, never surfaced as
      // an error. Still counts as "tried" so a down service can't get
      // hammered every location update.
      lastLookupAt = now
      onDebugEvent({ type: 'lookup-failed', lat, lon, error: String(e?.message || e) })
    } finally {
      lookupInFlight = false
    }
  }

  void rt.startLocationUpdates((loc: RawLocation) => {
    if (stopped) return
    if (tripStartedAt == null) tripStartedAt = Date.now()
    if (lastPos) tripMeters += haversineMeters(lastPos.lat, lastPos.lon, loc.lat, loc.lon)
    lastPos = { lat: loc.lat, lon: loc.lon }

    state = {
      ...state,
      speedMph: processSpeed(loc.speedMps),
      heading: loc.headingDeg != null ? headingToCompass(loc.headingDeg) : state.heading,
      tripMiles: tripMeters * METERS_TO_MILES,
      tripSeconds: tripStartedAt ? Math.round((Date.now() - tripStartedAt) / 1000) : 0,
    }
    emit()
    onDebugEvent({
      type: 'fix', lat: loc.lat, lon: loc.lon,
      speedMpsRaw: loc.speedMps, speedMphSmoothed: state.speedMph, headingDeg: loc.headingDeg,
    })
    void maybeLookup(loc.lat, loc.lon)
  })

  return () => { stopped = true }
}
