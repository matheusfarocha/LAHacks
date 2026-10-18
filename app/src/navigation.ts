export const MANEUVERS = ['straight', 'left', 'right', 'slight-left', 'slight-right', 'u-turn', 'roundabout', 'arrive'] as const

export type Maneuver = typeof MANEUVERS[number]

export interface NavigationInstruction {
  maneuver: Maneuver
  distanceMiles: number
  streetName: string
}

export const DEFAULT_NAVIGATION: NavigationInstruction = {
  maneuver: 'straight',
  distanceMiles: 999,
  streetName: 'Set destination',
}

export const MANEUVER_VISIBILITY_MILES = 1.5

export function shouldShowManeuver(distanceMiles: number): boolean {
  return Number.isFinite(distanceMiles) && distanceMiles >= 0 && distanceMiles <= MANEUVER_VISIBILITY_MILES
}

export function formatCompassHeading(headingDegrees: number | null): string {
  if (headingDegrees == null || !Number.isFinite(headingDegrees)) return '--'
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const normalized = (headingDegrees % 360 + 360) % 360
  return points[Math.round(normalized / 45) % points.length]
}

export function normalizeNavigationInstruction(value: Partial<NavigationInstruction>): NavigationInstruction {
  const maneuver = MANEUVERS.includes(value.maneuver as Maneuver) ? value.maneuver as Maneuver : 'straight'
  const distanceMiles = Number.isFinite(value.distanceMiles) && value.distanceMiles! >= 0
    ? Math.min(value.distanceMiles!, 999)
    : 0
  const streetName = value.streetName?.trim().replace(/\s+/g, ' ').slice(0, 32) || 'Continue on route'
  return { maneuver, distanceMiles, streetName }
}

export function formatNavigationDistance(distanceMiles: number): string {
  const miles = Math.max(0, distanceMiles)
  if (miles < 0.1) return `${Math.round(miles * 5280 / 50) * 50} FT`
  if (miles < 10) return `${miles.toFixed(1)} MI`
  return `${Math.round(miles)} MI`
}
