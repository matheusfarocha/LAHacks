import type { DrivingRoute, LngLat, LocationFix, RouteStep } from './route'

// Kept as constants so a hosted deployment can switch away from the public
// community services without shipping a new route/search implementation.
const GEOCODER_URL = 'https://nominatim.openstreetmap.org/search'
const ROUTER_URL = 'https://router.project-osrm.org/route/v1/driving'
const geocodeCache = new Map<string, Destination>()
let lastGeocodeAt = 0

export interface Destination {
  name: string
  address: string
  coordinates: LngLat
}

export async function findDestination(query: string, near: LocationFix, signal?: AbortSignal): Promise<Destination> {
  const cacheKey = query.trim().toLocaleLowerCase()
  const cached = geocodeCache.get(cacheKey)
  if (cached) return cached
  // The public Nominatim policy permits at most one request per second.
  const delay = Math.max(0, 1000 - (Date.now() - lastGeocodeAt))
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  signal?.throwIfAborted()
  lastGeocodeAt = Date.now()
  const params = new URLSearchParams({
    q: query.trim(),
    format: 'geojson',
    addressdetails: '1',
    limit: '5',
    viewbox: `${near.longitude - 1},${near.latitude + 1},${near.longitude + 1},${near.latitude - 1}`,
    bounded: '0',
    // Nominatim asks clients to identify themselves. The browser also sends
    // the app referrer; this contact keeps packaged webviews identifiable.
    email: 'usmankayaniphd@gmail.com',
  })
  const response = await fetch(`${GEOCODER_URL}?${params}`, {
    signal,
    headers: { 'Accept-Language': 'en' },
  })
  const data = await readResponse(response, 'Destination search')
  const feature = data.features?.[0]
  const longitude = feature?.geometry?.coordinates?.[0]
  const latitude = feature?.geometry?.coordinates?.[1]
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new Error('No matching destination was found. Try a fuller street address.')
  }
  const address = String(feature.properties?.display_name ?? query.trim())
  const destination = {
    name: destinationName(feature.properties, query),
    address,
    coordinates: [longitude, latitude] as LngLat,
  }
  geocodeCache.set(cacheKey, destination)
  return destination
}

export async function getDrivingRoute(
  from: LocationFix,
  destination: Destination,
  signal?: AbortSignal,
): Promise<DrivingRoute> {
  const coordinates = `${from.longitude},${from.latitude};${destination.coordinates[0]},${destination.coordinates[1]}`
  const params = new URLSearchParams({
    steps: 'true',
    geometries: 'geojson',
    overview: 'full',
    annotations: 'false',
  })
  const response = await fetch(`${ROUTER_URL}/${coordinates}?${params}`, { signal })
  const data = await readResponse(response, 'Route request')
  const route = data.routes?.[0]
  const steps = route?.legs?.flatMap((leg: any) => leg.steps ?? []).map(normalizeStep) ?? []
  const geometry = normalizeCoordinates(route?.geometry?.coordinates)
  if (data.code !== 'Ok' || !route || !steps.length || geometry.length < 2) {
    throw new Error('No drivable route was found for that destination.')
  }
  return {
    distance: Number(route.distance) || 0,
    duration: Number(route.duration) || 0,
    geometry,
    steps,
  }
}

function destinationName(properties: any, query: string): string {
  const address = properties?.address ?? {}
  const numberAndRoad = [address.house_number, address.road].filter(Boolean).join(' ')
  return String(properties?.name || numberAndRoad || address.amenity || address.building || query.trim())
}

function normalizeStep(step: any): RouteStep {
  const coordinates = normalizeCoordinates(step.geometry?.coordinates)
  const maneuverLocation = normalizeCoordinate(step.maneuver?.location)
    ?? coordinates[0] ?? [0, 0]
  if (!coordinates.length) coordinates.push(maneuverLocation)
  return {
    distance: Number(step.distance) || 0,
    duration: Number(step.duration) || 0,
    name: String(step.name ?? step.ref ?? ''),
    geometry: { type: 'LineString', coordinates },
    maneuver: {
      type: String(step.maneuver?.type ?? 'continue'),
      modifier: step.maneuver?.modifier ? String(step.maneuver.modifier) : undefined,
      instruction: step.maneuver?.instruction ? String(step.maneuver.instruction) : undefined,
      location: maneuverLocation,
    },
  }
}

function normalizeCoordinates(value: unknown): LngLat[] {
  if (!Array.isArray(value)) return []
  return value.map(normalizeCoordinate).filter((coordinate): coordinate is LngLat => coordinate != null)
}

function normalizeCoordinate(value: unknown): LngLat | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const longitude = Number(value[0])
  const latitude = Number(value[1])
  return Number.isFinite(longitude) && Number.isFinite(latitude) ? [longitude, latitude] : null
}

async function readResponse(response: Response, label: string): Promise<any> {
  let data: any
  try { data = await response.json() } catch { throw new Error(`${label} returned an unreadable response.`) }
  if (!response.ok) throw new Error(data.message || `${label} failed (${response.status}).`)
  return data
}
