// Zero-dep tests for the speed/limit/camera/trip feature. Run: `node test.mts`
// (node strips the .ts import types, same convention as the other apps in
// this pattern).
import {
  parseMaxspeed, parseDrivingInfo, nearestWay, nearestCamera, haversineMeters,
  rankWaysByDistance, UK_DEFAULT_LIMITS,
} from './src/osm.ts'
import { headingToCompass, startSpeedTracking } from './src/speed.ts'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  ok  ', name) }
  else { fail++; console.log('  FAIL', name, extra) }
}

const TEST_LAT = 51.60202673636377
const TEST_LON = 0.042996564880013466

// ── real fixture, captured from the live Overpass validation in the design
// doc: 11 ways near the test coordinates, zero explicitly tagged with
// maxspeed, zero speed cameras in range. ────────────────────────────────────
const FIXTURE_NO_TAGS_NO_CAMERA = {
  elements: [
    { type: 'way', tags: { highway: 'residential', name: 'Underwood Road', surface: 'asphalt' }, geometry: [{ lat: TEST_LAT, lon: TEST_LON + 0.0001 }] },
    { type: 'way', tags: { highway: 'residential', name: 'Hookstone Way' }, geometry: [{ lat: TEST_LAT + 0.0003, lon: TEST_LON }] },
    { type: 'way', tags: { highway: 'residential', name: 'Goldhaze Close', surface: 'asphalt' }, geometry: [{ lat: TEST_LAT + 0.0005, lon: TEST_LON }] },
  ],
}

// ── synthetic fixtures (clearly not live-captured — constructed to exercise
// paths the real test location doesn't have: an explicit tag, and a camera
// in range). ─────────────────────────────────────────────────────────────
const FIXTURE_TAGGED_ROAD = {
  elements: [
    { type: 'way', tags: { highway: 'primary', name: 'A414', maxspeed: '40 mph' }, geometry: [{ lat: TEST_LAT, lon: TEST_LON + 0.0001 }] },
  ],
}
const FIXTURE_WITH_CAMERA = {
  elements: [
    { type: 'way', tags: { highway: 'residential', name: 'Test Street' }, geometry: [{ lat: TEST_LAT, lon: TEST_LON + 0.0001 }] },
    { type: 'node', tags: { highway: 'speed_camera' }, lat: TEST_LAT + 0.002, lon: TEST_LON },
  ],
}
const FIXTURE_UNKNOWN_HIGHWAY = {
  elements: [
    { type: 'way', tags: { highway: 'track', name: 'Farm Track' }, geometry: [{ lat: TEST_LAT, lon: TEST_LON + 0.0001 }] },
  ],
}
const FIXTURE_NO_ROADS = { elements: [] }

// ── osm.ts: parseMaxspeed ─────────────────────────────────────────────────
console.log('\nparseMaxspeed')
ok('parses "30 mph"', parseMaxspeed('30 mph') === 30)
ok('parses "70mph" (no space)', parseMaxspeed('70mph') === 70)
ok('parses bare number', parseMaxspeed('50') === 50)
ok('returns null for undefined', parseMaxspeed(undefined) === null)
ok('returns null for unrecognised format', parseMaxspeed('national') === null)

// ── osm.ts: parseDrivingInfo (the real fixture — no tags, no camera) ──────
console.log('\nparseDrivingInfo — real captured fixture (no tags, no camera)')
let info = parseDrivingInfo(FIXTURE_NO_TAGS_NO_CAMERA as any, TEST_LAT, TEST_LON)
ok('falls back to UK default table for residential', info.limitMph === UK_DEFAULT_LIMITS.residential)
ok('source is default-table', info.limitSource === 'default-table')
ok('picks the nearest way by distance', info.roadName === 'Underwood Road')
ok('no camera found -> null, not zero or missing', info.cameraDistanceM === null)

// ── parseDrivingInfo — synthetic: explicit tag wins over default table ────
console.log('\nparseDrivingInfo — explicit maxspeed tag')
info = parseDrivingInfo(FIXTURE_TAGGED_ROAD as any, TEST_LAT, TEST_LON)
ok('uses the explicit tag, not the default table', info.limitMph === 40)
ok('source is tagged', info.limitSource === 'tagged')

// ── parseDrivingInfo — synthetic: camera in range ─────────────────────────
console.log('\nparseDrivingInfo — camera in range')
info = parseDrivingInfo(FIXTURE_WITH_CAMERA as any, TEST_LAT, TEST_LON)
ok('camera distance populated', typeof info.cameraDistanceM === 'number' && info.cameraDistanceM! > 0)
ok('road lookup still resolves independently of camera presence', info.limitMph === UK_DEFAULT_LIMITS.residential)

// ── parseDrivingInfo — edge cases ─────────────────────────────────────────
console.log('\nparseDrivingInfo — edge cases')
info = parseDrivingInfo(FIXTURE_UNKNOWN_HIGHWAY as any, TEST_LAT, TEST_LON)
ok('highway type not in default table -> unknown-highway-type, not a crash', info.limitSource === 'unknown-highway-type' && info.limitMph === null)
info = parseDrivingInfo(FIXTURE_NO_ROADS as any, TEST_LAT, TEST_LON)
ok('no roads at all -> no-road-found', info.limitSource === 'no-road-found' && info.limitMph === null)
ok('no-road-found also has no camera', info.cameraDistanceM === null)

// ── nearestWay / nearestCamera / haversineMeters ──────────────────────────
console.log('\ngeometry helpers')
ok('haversine of identical points is 0', haversineMeters(TEST_LAT, TEST_LON, TEST_LAT, TEST_LON) === 0)
ok('haversine is positive for distinct points', haversineMeters(TEST_LAT, TEST_LON, TEST_LAT + 0.01, TEST_LON) > 0)
const nw = nearestWay(FIXTURE_NO_TAGS_NO_CAMERA.elements as any, TEST_LAT, TEST_LON)
ok('nearestWay finds the closest of several candidates', nw?.way.tags?.name === 'Underwood Road')
const nc = nearestCamera(FIXTURE_WITH_CAMERA.elements.filter((e) => e.type === 'node') as any, TEST_LAT, TEST_LON)
ok('nearestCamera finds the camera node', nc !== null)

// ── rankWaysByDistance: segment (not just vertex) distance ───────────────
// A long straight way whose only two geometry points sit ~130-140m either
// side of the test coordinate — but the road itself (the line between
// them) passes right through it. Vertex-only distance would report this
// way as ~130m+ away (missing entirely); point-to-segment correctly finds
// the near-zero distance to the midpoint of the line.
console.log('\nrankWaysByDistance — point-to-segment vs point-to-vertex')
const FIXTURE_LONG_STRAIGHT_ROAD = [
  { type: 'way', tags: { highway: 'residential', name: 'Long Straight Road' }, geometry: [
    { lat: TEST_LAT, lon: TEST_LON - 0.002 },
    { lat: TEST_LAT, lon: TEST_LON + 0.002 },
  ] },
]
const ranked = rankWaysByDistance(FIXTURE_LONG_STRAIGHT_ROAD as any, TEST_LAT, TEST_LON)
ok('finds the road via segment interpolation, not just its endpoints', ranked[0]?.distanceM < 10, `distanceM=${ranked[0]?.distanceM}`)

// ── speed.ts: headingToCompass ────────────────────────────────────────────
console.log('\nheadingToCompass')
ok('0 degrees is N', headingToCompass(0) === 'N')
ok('90 degrees is E', headingToCompass(90) === 'E')
ok('180 degrees is S', headingToCompass(180) === 'S')
ok('270 degrees is W', headingToCompass(270) === 'W')
ok('45 degrees is NE', headingToCompass(45) === 'NE')
ok('359 degrees wraps back to N, not undefined', headingToCompass(359) === 'N')
ok('negative input handled (e.g. -10 -> 350ish -> NW/N boundary)', typeof headingToCompass(-10) === 'string')

// ── speed.ts: startSpeedTracking decision logic (moved-enough-or-timed-out) ─
console.log('\nstartSpeedTracking — lookup gating')
{
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  ;(globalThis as any).fetch = async () => {
    fetchCalls++
    return { ok: true, json: async () => FIXTURE_NO_TAGS_NO_CAMERA }
  }

  let locationCallback: (loc: any) => void = () => {}
  const fakeRt = {
    startLocationUpdates: async (cb: (loc: any) => void) => { locationCallback = cb },
  } as any

  const states: any[] = []
  startSpeedTracking(fakeRt, (s) => states.push(s))
  await new Promise((r) => setTimeout(r, 0)) // let the async startLocationUpdates resolve

  // First fix: no previous lookup position, so this should always trigger one.
  locationCallback({ lat: TEST_LAT, lon: TEST_LON, speedMps: 10, headingDeg: 90 })
  await new Promise((r) => setTimeout(r, 20))
  ok('first fix triggers a lookup', fetchCalls === 1, `fetchCalls=${fetchCalls}`)

  // Second fix, tiny movement (well under the 120m threshold): should NOT
  // trigger a second lookup (timeout hasn't elapsed either).
  locationCallback({ lat: TEST_LAT + 0.00001, lon: TEST_LON, speedMps: 12, headingDeg: 91 })
  await new Promise((r) => setTimeout(r, 20))
  ok('tiny movement does not re-trigger a lookup', fetchCalls === 1, `fetchCalls=${fetchCalls}`)
  ok('speed still updates even without a new lookup', states.at(-1)?.speedMph > 20, `speedMph=${states.at(-1)?.speedMph}`)

  // Third fix, far away (>120m): should trigger a new lookup.
  locationCallback({ lat: TEST_LAT + 0.01, lon: TEST_LON, speedMps: 15, headingDeg: 180 })
  await new Promise((r) => setTimeout(r, 20))
  ok('large movement re-triggers a lookup', fetchCalls === 2, `fetchCalls=${fetchCalls}`)

  ok('trip distance accumulated across fixes', states.at(-1)?.tripMiles > 0, `tripMiles=${states.at(-1)?.tripMiles}`)
  ok('heading updates to compass label', states.at(-1)?.heading === 'S')

  globalThis.fetch = originalFetch
}

console.log('\nstartSpeedTracking — failed lookup keeps previous state, no crash')
{
  const originalFetch = globalThis.fetch
  ;(globalThis as any).fetch = async () => { throw new Error('network down') }

  let locationCallback: (loc: any) => void = () => {}
  const fakeRt = { startLocationUpdates: async (cb: (loc: any) => void) => { locationCallback = cb } } as any

  const states: any[] = []
  startSpeedTracking(fakeRt, (s) => states.push(s))
  await new Promise((r) => setTimeout(r, 0))
  locationCallback({ lat: TEST_LAT, lon: TEST_LON, speedMps: 5, headingDeg: 0 })
  await new Promise((r) => setTimeout(r, 20))

  ok('speed still reported despite lookup failure', states.at(-1)?.speedMph > 0)
  ok('limit stays pending rather than crashing or showing garbage', states.at(-1)?.limitSource === 'pending')

  globalThis.fetch = originalFetch
}

// ── speed.ts: processSpeed (glitch rejection + smoothing) ─────────────────
// Real delays (not 0ms) are load-bearing here — the algorithm judges
// plausibility by implied acceleration (delta-speed / delta-time), so the
// test needs real elapsed time to mean anything.
console.log('\nstartSpeedTracking — speed glitch rejection + smoothing')
{
  const originalFetch = globalThis.fetch
  ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => FIXTURE_NO_ROADS })

  let locationCallback: (loc: any) => void = () => {}
  const fakeRt = { startLocationUpdates: async (cb: (loc: any) => void) => { locationCallback = cb } } as any

  const states: any[] = []
  startSpeedTracking(fakeRt, (s) => states.push(s))
  await new Promise((r) => setTimeout(r, 0))

  // First fix bootstraps the smoothed value directly (no prior reference).
  locationCallback({ lat: TEST_LAT, lon: TEST_LON, speedMps: 10, headingDeg: 0 }) // ~22.4 mph
  await new Promise((r) => setTimeout(r, 150))
  const afterFirst = states.at(-1)?.speedMph
  ok('first sample sets speed directly, no smoothing lag', Math.abs(afterFirst - 22.37) < 0.5, `speedMph=${afterFirst}`)

  // Implausible jump (90 m/s over ~150ms => ~600 m/s^2, far past any real
  // car): should be rejected outright, display stays at the last good value.
  locationCallback({ lat: TEST_LAT, lon: TEST_LON, speedMps: 100, headingDeg: 0 })
  await new Promise((r) => setTimeout(r, 150))
  const afterGlitch = states.at(-1)?.speedMph
  ok('implausible speed jump is rejected, not displayed', Math.abs(afterGlitch - afterFirst) < 0.5, `speedMph=${afterGlitch}`)

  // Plausible change (1 m/s over ~150ms => ~6.7 m/s^2, under the 8 m/s^2
  // ceiling): accepted, but EMA-smoothed rather than jumping straight there.
  locationCallback({ lat: TEST_LAT, lon: TEST_LON, speedMps: 11, headingDeg: 0 }) // ~24.6 mph raw
  await new Promise((r) => setTimeout(r, 150))
  const afterPlausible = states.at(-1)?.speedMph
  ok('plausible change is accepted', afterPlausible > afterGlitch, `speedMph=${afterPlausible}`)
  ok('plausible change is smoothed, not applied raw', afterPlausible < 24.6, `speedMph=${afterPlausible}`)

  globalThis.fetch = originalFetch
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
