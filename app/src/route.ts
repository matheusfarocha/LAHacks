import { normalizeNavigationInstruction, type Maneuver, type NavigationInstruction } from './navigation.ts'

export type LngLat = [number, number]

export interface LocationFix {
  latitude: number
  longitude: number
  accuracy: number
  speedMps: number | null
  headingDegrees: number | null
  timestamp: number
}

export interface RouteStep {
  distance: number
  duration: number
  name: string
  geometry: { coordinates: LngLat[]; type: 'LineString' }
  maneuver: {
    type: string
    modifier?: string
    instruction?: string
    location: LngLat
  }
}

export interface DrivingRoute {
  distance: number
  duration: number
  geometry: LngLat[]
  steps: RouteStep[]
}

export interface RouteProgress {
  stepIndex: number
  instruction: NavigationInstruction
  distanceToManeuverMeters: number
  distanceRemainingMeters: number
  durationRemainingSeconds: number
  offRouteSeconds: number
  arrived: boolean
}

const ADVANCE_DISTANCE_METERS = 30
const ARRIVAL_DISTANCE_METERS = 30
const OFF_ROUTE_DISTANCE_METERS = 45
const REROUTE_AFTER_SECONDS = 6
const METERS_PER_MILE = 1609.344

export class RouteTracker {
  private stepIndex = 0
  private offRouteSince: number | null = null
  private route: DrivingRoute

  constructor(route: DrivingRoute) {
    if (!route.steps.length) throw new Error('The route did not contain navigation steps.')
    this.route = route
  }

  update(fix: LocationFix): RouteProgress {
    const here: LngLat = [fix.longitude, fix.latitude]

    while (fix.accuracy <= 100 && this.stepIndex < this.route.steps.length - 1) {
      const progress = progressAlongLine(here, this.route.steps[this.stepIndex].geometry.coordinates)
      if (progress.remainingMeters > ADVANCE_DISTANCE_METERS
        || progress.distanceFromLineMeters > OFF_ROUTE_DISTANCE_METERS) break
      this.stepIndex++
    }

    const current = this.route.steps[this.stepIndex]
    const upcoming = this.route.steps[this.stepIndex + 1] ?? null
    const lineProgress = progressAlongLine(here, current.geometry.coordinates)
    const distanceToManeuverMeters = upcoming
      ? lineProgress.remainingMeters
      : distanceMeters(here, current.maneuver.location)
    const arrived = !upcoming && distanceToManeuverMeters <= ARRIVAL_DISTANCE_METERS

    const nearbyGeometry = [
      ...current.geometry.coordinates,
      ...(upcoming?.geometry.coordinates ?? []),
    ]
    const offRouteDistance = progressAlongLine(here, nearbyGeometry).distanceFromLineMeters
    if (fix.accuracy <= 100 && offRouteDistance > OFF_ROUTE_DISTANCE_METERS) {
      if (this.offRouteSince == null) this.offRouteSince = fix.timestamp
    } else {
      this.offRouteSince = null
    }
    const offRouteSeconds = this.offRouteSince == null ? 0 : Math.max(0, (fix.timestamp - this.offRouteSince) / 1000)

    let distanceRemainingMeters = distanceToManeuverMeters
    let durationRemainingSeconds = current.duration * distanceToManeuverMeters / Math.max(current.distance, 1)
    for (let index = this.stepIndex + 1; index < this.route.steps.length; index++) {
      distanceRemainingMeters += this.route.steps[index].distance
      durationRemainingSeconds += this.route.steps[index].duration
    }

    const targetStep = upcoming ?? current
    const streetName = current.name || targetStep.name || (arrived ? 'Destination' : 'Continue on route')
    return {
      stepIndex: this.stepIndex,
      instruction: normalizeNavigationInstruction({
        maneuver: maneuverForStep(targetStep),
        distanceMiles: distanceToManeuverMeters / METERS_PER_MILE,
        streetName,
      }),
      distanceToManeuverMeters,
      distanceRemainingMeters,
      durationRemainingSeconds,
      offRouteSeconds,
      arrived,
    }
  }

  shouldReroute(progress: RouteProgress): boolean {
    return progress.offRouteSeconds >= REROUTE_AFTER_SECONDS
  }
}

export function maneuverForStep(step: RouteStep): Maneuver {
  const type = step.maneuver.type.toLowerCase()
  const modifier = step.maneuver.modifier?.toLowerCase() ?? ''
  if (type === 'arrive') return 'arrive'
  if (type.includes('roundabout') || type === 'rotary' || type === 'exit rotary') return 'roundabout'
  if (modifier === 'uturn') return 'u-turn'
  if (modifier.includes('slight left')) return 'slight-left'
  if (modifier.includes('slight right')) return 'slight-right'
  if (modifier.includes('left')) return 'left'
  if (modifier.includes('right')) return 'right'
  return 'straight'
}

export function distanceMeters(a: LngLat, b: LngLat): number {
  const radius = 6_371_000
  const toRadians = (degrees: number) => degrees * Math.PI / 180
  const latitudeDelta = toRadians(b[1] - a[1])
  const longitudeDelta = toRadians(b[0] - a[0])
  const latitudeA = toRadians(a[1])
  const latitudeB = toRadians(b[1])
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2
  return 2 * radius * Math.asin(Math.sqrt(value))
}

function progressAlongLine(point: LngLat, coordinates: LngLat[]) {
  if (coordinates.length < 2) {
    const distance = coordinates.length ? distanceMeters(point, coordinates[0]) : Infinity
    return { remainingMeters: distance, distanceFromLineMeters: distance }
  }

  let bestDistance = Infinity
  let bestSegment = 0
  let bestFraction = 0
  const segmentLengths = coordinates.slice(0, -1).map((coordinate, index) => distanceMeters(coordinate, coordinates[index + 1]))
  for (let index = 0; index < coordinates.length - 1; index++) {
    const fraction = projectionFraction(point, coordinates[index], coordinates[index + 1])
    const projected: LngLat = [
      coordinates[index][0] + (coordinates[index + 1][0] - coordinates[index][0]) * fraction,
      coordinates[index][1] + (coordinates[index + 1][1] - coordinates[index][1]) * fraction,
    ]
    const distance = distanceMeters(point, projected)
    if (distance < bestDistance) {
      bestDistance = distance
      bestSegment = index
      bestFraction = fraction
    }
  }

  let remainingMeters = segmentLengths[bestSegment] * (1 - bestFraction)
  for (let index = bestSegment + 1; index < segmentLengths.length; index++) remainingMeters += segmentLengths[index]
  return { remainingMeters, distanceFromLineMeters: bestDistance }
}

function projectionFraction(point: LngLat, start: LngLat, end: LngLat): number {
  const latitudeScale = Math.cos(point[1] * Math.PI / 180)
  const startX = (start[0] - point[0]) * latitudeScale
  const startY = start[1] - point[1]
  const endX = (end[0] - point[0]) * latitudeScale
  const endY = end[1] - point[1]
  const deltaX = endX - startX
  const deltaY = endY - startY
  const lengthSquared = deltaX ** 2 + deltaY ** 2
  if (!lengthSquared) return 0
  return Math.max(0, Math.min(1, -(startX * deltaX + startY * deltaY) / lengthSquared))
}
