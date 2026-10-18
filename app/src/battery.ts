// Glasses battery: just relays a value the SDK already pushes via
// onDeviceStatusChanged — no polling, no lookup, no decision logic.
import type { Runtime } from './even'

export interface BatteryState {
  levelPct: number | null
  charging: boolean
}

export function startBatteryTracking(rt: Runtime, onUpdate: (state: BatteryState) => void): void {
  rt.onBattery((levelPct, charging) => onUpdate({ levelPct, charging }))
}
