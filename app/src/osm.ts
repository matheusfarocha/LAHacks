// Pure OSM Overpass logic: build the query, parse the response, resolve a
// speed limit (explicit tag or UK default-by-road-type), find the nearest
// speed camera. No SDK/DOM dependency — only `fetch`, so this is testable
// with plain Node + fixture JSON.
//
// Verified live against overpass-api.de (see the design doc): CORS is
// permissive, a real browser UA passes its anti-abuse filter with no
// special headers, and this exact combined-query shape (ways + camera
// nodes in one request) returns valid results.
//
// Free, keyless mirrors tried in order on failure — no single Overpass
// instance is reliable enough alone: overpass-api.de is a shared public
// resource that does rate-limit under real use (confirmed live: a 429
// mid-session, then an 8s timeout on a later request in the same test).
// maps.mail.ru's mirror was checked the same way and responded in ~470ms
// with matching data while the primary was timing out; osm.ch responded
// fast too but returned 0 elements for the same point (works, but its data
// coverage is unproven, so it goes last).
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
]
const ROAD_RADIUS_M = 100
const CAMERA_RADIUS_M = 1000

// UK default speed limits by highway type, used only when a road has no
// explicit maxspeed tag — the common case for ordinary residential streets
// (confirmed live: 0/11 nearby ways were tagged at the test location).
export const UK_DEFAULT_LIMITS: Record<string, number> = {
  motorway: 70,
  motorway_link: 70,
  trunk: 60,
  trunk_link: 60,
  primary: 60,
  primary_link: 60,
  secondary: 60,
  secondary_link: 60,
  tertiary: 60,
  tertiary_link: 60,
  unclassified: 60,
  residential: 30,
  living_street: 20,
}

export type LimitSource = 'tagged' | 'default-table' | 'no-road-found' | 'unknown-highway-type'

export interface CandidateWay {
  name: string | null
  highway: string | null
  maxspeed: string | null
  distanceM: number
}

export interface DrivingInfo {
  limitMph: number | null
  limitSource: LimitSource
  roadName: string | null
  highway: string | null
  distanceM: number | null
  cameraDistanceM: number | null
  // Every candidate way in range, nearest first — not just the winner.
  // Unused by the live UI (DrivingState doesn't carry it), only by the
  // opt-in debug logger (see main.ts), so a wrong pick can be diagnosed
  // after the fact instead of guessed at.
  candidates: CandidateWay[]
}

interface OverpassGeomPoint { lat: number; lon: number }
interface OverpassElement {
  type: 'way' | 'node'
  tags?: Record<string, string>
  geometry?: OverpassGeomPoint[]
  lat?: number
  lon?: number
}
interface OverpassResponse { elements: OverpassElement[] }

export function buildOverpassQuery(lat: number, lon: number, roadRadiusM = ROAD_RADIUS_M, cameraRadiusM = CAMERA_RADIUS_M): string {
  return `[out:json][timeout:25];(way(around:${roadRadiusM},${lat},${lon})["highway"];node(around:${cameraRadiusM},${lat},${lon})["highway"="speed_camera"];);out body geom;`
}

export function parseMaxspeed(tag: string | undefined): number | null {
  if (!tag) return null
  const mph = tag.match(/(\d+)\s*mph/i)
  if (mph) return parseInt(mph[1], 10)
  const bare = tag.match(/^(\d+)$/)
  if (bare) return parseInt(bare[1], 10)
  return null
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Flat-earth (equirectangular) point-to-segment distance, valid at the
// ~100m scale this app queries at. Distance-to-nearest-VERTEX (the previous
// approach) systematically misjudges a way's true distance whenever the
// closest point on the road actually falls between two sparse vertices —
// long, simply-mapped roads (motorways/trunk roads often have fewer
// vertices per km than fiddly residential streets) would report a falsely
// large distance, letting a genuinely farther but more densely-vertexed
// road win "nearest way" incorrectly. Point-to-segment removes this bias
// regardless of which direction it happened to point in a given case.
function segmentDistanceMeters(lat: number, lon: number, aLat: number, aLon: number, bLat: number, bLon: number): number {
  const cosLat = Math.cos((lat * Math.PI) / 180)
  const mPerDegLat = 110_540
  const mPerDegLon = 111_320 * cosLat
  const ax = (aLon - lon) * mPerDegLon, ay = (aLat - lat) * mPerDegLat
  const bx = (bLon - lon) * mPerDegLon, by = (bLat - lat) * mPerDegLat
  const abx = bx - ax, aby = by - ay
  const abLenSq = abx * abx + aby * aby
  let t = abLenSq === 0 ? 0 : (-ax * abx - ay * aby) / abLenSq
  t = Math.max(0, Math.min(1, t))
  const px = ax + t * abx, py = ay + t * aby
  return Math.sqrt(px * px + py * py)
}

// Ranked so the debug logger (see main.ts) can record every candidate the
// algorithm considered, not just the winner — the only way to tell, after
// the fact, whether a wrong pick was close-but-plausible or a clear bug.
export function rankWaysByDistance(ways: OverpassElement[], lat: number, lon: number): { way: OverpassElement; distanceM: number }[] {
  const results: { way: OverpassElement; distanceM: number }[] = []
  for (const w of ways) {
    const pts = w.geometry || []
    if (pts.length === 0) continue
    let best = Infinity
    if (pts.length === 1) {
      best = haversineMeters(lat, lon, pts[0].lat, pts[0].lon)
    } else {
      for (let i = 0; i < pts.length - 1; i++) {
        const d = segmentDistanceMeters(lat, lon, pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon)
        if (d < best) best = d
      }
    }
    results.push({ way: w, distanceM: Math.round(best) })
  }
  results.sort((a, b) => a.distanceM - b.distanceM)
  return results
}

export function nearestWay(ways: OverpassElement[], lat: number, lon: number): { way: OverpassElement; distanceM: number } | null {
  const ranked = rankWaysByDistance(ways, lat, lon)
  return ranked.length ? ranked[0] : null
}

export function nearestCamera(nodes: OverpassElement[], lat: number, lon: number): { distanceM: number } | null {
  let bestDist = Infinity
  for (const n of nodes) {
    if (typeof n.lat !== 'number' || typeof n.lon !== 'number') continue
    const d = haversineMeters(lat, lon, n.lat, n.lon)
    if (d < bestDist) bestDist = d
  }
  return bestDist < Infinity ? { distanceM: Math.round(bestDist) } : null
}

const MAX_LOGGED_CANDIDATES = 5

// Pure parsing step, split out from lookupDrivingInfo so it's testable
// against captured fixture JSON with zero network involved.
export function parseDrivingInfo(json: OverpassResponse, lat: number, lon: number): DrivingInfo {
  const ways = json.elements.filter((e) => e.type === 'way' && e.tags?.highway)
  const cameraNodes = json.elements.filter((e) => e.type === 'node' && e.tags?.highway === 'speed_camera')

  const camera = nearestCamera(cameraNodes, lat, lon)
  const ranked = rankWaysByDistance(ways, lat, lon)
  const nearest = ranked[0]
  const candidates: CandidateWay[] = ranked.slice(0, MAX_LOGGED_CANDIDATES).map((r) => ({
    name: r.way.tags?.name ?? null,
    highway: r.way.tags?.highway ?? null,
    maxspeed: r.way.tags?.maxspeed ?? null,
    distanceM: r.distanceM,
  }))

  if (!nearest) {
    return { limitMph: null, limitSource: 'no-road-found', roadName: null, highway: null, distanceM: null, cameraDistanceM: camera?.distanceM ?? null, candidates }
  }

  const { way, distanceM } = nearest
  const explicit = parseMaxspeed(way.tags?.maxspeed)
  if (explicit != null) {
    return { limitMph: explicit, limitSource: 'tagged', roadName: way.tags?.name ?? null, highway: way.tags?.highway ?? null, distanceM, cameraDistanceM: camera?.distanceM ?? null, candidates }
  }
  const fallback = way.tags?.highway ? UK_DEFAULT_LIMITS[way.tags.highway] ?? null : null
  return {
    limitMph: fallback,
    limitSource: fallback != null ? 'default-table' : 'unknown-highway-type',
    roadName: way.tags?.name ?? null,
    highway: way.tags?.highway ?? null,
    distanceM,
    cameraDistanceM: camera?.distanceM ?? null,
    candidates,
  }
}

// Per-mirror, not overall — up to 3 mirrors get tried in sequence (see
// OVERPASS_URLS), so this stays short enough that a full run through all of
// them in the worst case (~24s) doesn't compound into an unreasonable wait.
const FETCH_TIMEOUT_MS = 8_000

async function fetchFromOverpass(url: string, lat: number, lon: number): Promise<OverpassResponse> {
  // A hung connection (observed against the real API under heavy polling —
  // Overpass can hold a request open with no response at all, not just
  // reject fast) would otherwise never resolve this promise, permanently
  // wedging startSpeedTracking's lookupInFlight guard and freezing the
  // limit forever instead of just going stale for one cycle.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(buildOverpassQuery(lat, lon)),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`)
    return (await res.json()) as OverpassResponse
  } finally {
    clearTimeout(timer)
  }
}

export async function lookupDrivingInfo(lat: number, lon: number): Promise<DrivingInfo> {
  let lastError: unknown
  for (const url of OVERPASS_URLS) {
    try {
      const json = await fetchFromOverpass(url, lat, lon)
      return parseDrivingInfo(json, lat, lon)
    } catch (e) {
      lastError = e // try the next mirror
    }
  }
  throw lastError instanceof Error ? lastError : new Error('all Overpass mirrors failed')
}
