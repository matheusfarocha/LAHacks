// Glass Car Dash — a driving dashboard + media remote for the G2.
//
// One screen: status/gesture text in the bordered left text panel, live
// driving info (speed, circular speed-limit sign, heading, camera warning)
// as a bitmap in the right dash panel. Gestures are simple and constant (no
// long-press primitive on this SDK/hardware — confirmed by checking the
// full type surface, not assumed):
//   tap = play/pause, up = next, down = previous, double-tap = exit.
import { Runtime, type Input } from './even'
import { api } from './api'
import * as F from './format'
import { startSpeedTracking, type DrivingState } from './speed'
import { startBatteryTracking, type BatteryState } from './battery'
import { renderDashPanelPng } from './panel'
import type { MediaStatus, ActionResult, NowPlaying } from './types'

const STATUS_REFRESH_MS = 20_000
const LEFT_WRAP_WIDTH = 22
const PANEL_PUSH_INTERVAL_MS = 1000 // driving info changes slowly enough that 1fps is plenty, and it's kinder to BLE bandwidth
// A single "sendFailed" is an expected occasional BLE hiccup pushing an
// image once a second over a wireless link, not a real problem — it still
// works next tick. Only surface it in the footer once it's failed this many
// times in a row, so a real stuck failure is still visible but a one-off
// blip doesn't flash a scary message for no reason.
const PANEL_FAIL_STREAK_THRESHOLD = 3

const rt = new Runtime()

const emptyDriving: DrivingState = {
  speedMph: null, heading: null, limitMph: null, limitSource: 'pending',
  roadName: null, cameraDistanceM: null, tripMiles: 0, tripSeconds: 0,
}

const state = {
  status: null as MediaStatus | null,
  lastResult: null as ActionResult | null,
  error: '',
  busy: false, // guards against a gesture firing again before the last one lands
  driving: emptyDriving,
  battery: { levelPct: null, charging: false } as BatteryState,
  phoneBattery: { levelPct: null, charging: false } as { levelPct: number | null; charging: boolean },
  panelResult: '', // last updateImageRawData result — the only diagnostic signal we get back for a bitmap push, per app-development.md's Sensorscope lesson
  panelFailStreak: 0,
}

let rendering: Promise<unknown> = Promise.resolve()
function paint() {
  rendering = rendering.then(() => render()).catch(() => {})
}

async function loadStatus(): Promise<void> {
  try {
    state.status = await api.status()
    if (state.status.connected) state.error = ''
  } catch (e: any) {
    state.error = e?.message || 'status check failed'
  }
  paint()
}

async function loadPhoneStatus(): Promise<void> {
  try {
    state.phoneBattery = await api.phoneStatus()
  } catch {
    // Termux:API not installed or permission not granted — not worth
    // surfacing as an error, the display just omits the line (see
    // leftLines) the same way a missing camera/limit silently omits theirs.
  }
  paint()
}

// Plain-letter labels, not emoji or symbols — confirmed via the official
// simulator (which mirrors the real font's glyph support) that 🕶/📱 render
// as nothing at all in a text container, and the simulator's own log
// (lv_draw_label: "glyph dsc. not found for U+26A1") confirms ⚡ doesn't
// exist in the real font either. A trailing "+" is the charging indicator.
function batteryText(): string {
  const b = state.battery
  const glasses = b.levelPct == null ? '…' : `${b.levelPct}%${b.charging ? '+' : ''}`
  const pb = state.phoneBattery
  const phone = pb.levelPct == null ? '' : `  P ${pb.levelPct}%${pb.charging ? '+' : ''}`
  return `G ${glasses}${phone}`
}

// Some apps already fold the artist into the title ("Skepta - Nasty"),
// others don't ("Test Me" with artist "JME" reported separately) —
// verified both shapes live against a real device. Only append the artist
// when it isn't already there, so it doesn't show up twice.
function nowPlayingText(np: NowPlaying): string {
  if (!np.title) return ''
  if (np.artist && !np.title.toLowerCase().includes(np.artist.toLowerCase())) {
    return `${np.title} - ${np.artist}`
  }
  return np.title
}

function leftLines(): string[] {
  if (state.busy) return ['Sending…']
  const connected = state.status?.connected
  if (connected === false) {
    return ['Not connected.', ...wrap(state.status?.reason || state.error || 'no device', LEFT_WRAP_WIDTH).split('\n')]
  }
  if (state.error) {
    return ['Error:', ...wrap(state.error, LEFT_WRAP_WIDTH).split('\n')]
  }

  const lines: string[] = []
  if (state.lastResult) lines.push(`Sent: ${state.lastResult.label}`, F.timeAgo(state.lastResult.sentAt))
  else lines.push('Ready.')

  // Best-effort now-playing title (see media.js's dumpsys media_session
  // parser) — falls back to the plain gesture legend when nothing's
  // playing or the parse comes up empty.
  const np = state.status?.nowPlaying
  if (np?.title) lines.push(...wrap(`${np.playing ? '▶' : 'II'} ${nowPlayingText(np)}`, LEFT_WRAP_WIDTH).split('\n'))
  else lines.push('▶ tap · » up · « down')

  if (state.driving.roadName) lines.push(wrap(state.driving.roadName, LEFT_WRAP_WIDTH).split('\n')[0])

  return lines
}

async function render(): Promise<void> {
  const connected = state.status?.connected
  const dot = connected === undefined ? '…' : connected ? '●' : '○'
  const header = F.padHeader('Glass Car Dash', `${dot}  ${batteryText()}`)
  const body = '\n  ' + leftLines().join('\n  ')
  // Quiet unless something's persistently wrong, same as the camera-warning
  // line — a failed bitmap push is otherwise invisible (there's no glasses
  // in front of the person writing the code, only this string comes back).
  // A single failure isn't shown: pushing an image once a second over BLE
  // means an occasional "sendFailed" blip is expected, not a real problem.
  const footer = state.panelFailStreak >= PANEL_FAIL_STREAK_THRESHOLD
    ? `panel: ${state.panelResult}`
    : '▶ tap · » up · « down · 2x exit'
  await rt.render(header, body, footer)
}

let panelPushing = false
async function pushPanel(): Promise<void> {
  if (panelPushing) return // never let pushes queue up — skip a beat instead
  panelPushing = true
  try {
    const png = await renderDashPanelPng(state.driving)
    state.panelResult = await rt.pushPanel(png)
  } catch (e: any) {
    state.panelResult = e?.message || 'push threw'
  } finally {
    state.panelFailStreak = state.panelResult === 'success' ? 0 : state.panelFailStreak + 1
    panelPushing = false
    paint()
  }
}

function wrap(s: string, width: number): string {
  const words = s.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { lines.push(line); line = w }
    else line = line ? line + ' ' + w : w
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

// Skip/pause change the actual media session, but the periodic status poll
// (STATUS_REFRESH_MS, 20s) could take up to that long to notice — annoying
// right after tapping next/previous, since that's exactly when you want the
// new track/artist to show up. Schedule an extra check shortly after a
// successful action instead of waiting for the regular interval. Delayed
// (not immediate) because the target app needs a beat to actually switch
// tracks and publish new session metadata — an instant re-check would just
// re-read the outgoing track.
const NOWPLAYING_REFRESH_DELAY_MS = 1000
const TRACK_CHANGE_ACTIONS = new Set(['play_pause', 'next', 'previous'])

async function fire(id: string): Promise<void> {
  if (state.busy) return
  state.busy = true
  state.error = ''
  paint()
  try {
    state.lastResult = await api.send(id)
    if (TRACK_CHANGE_ACTIONS.has(id)) setTimeout(() => void loadStatus(), NOWPLAYING_REFRESH_DELAY_MS)
  } catch (e: any) {
    state.error = e?.message || 'send failed'
    void loadStatus() // the send failure might mean the device disconnected — recheck
  } finally {
    state.busy = false
    paint()
  }
}

function onInput(i: Input) {
  if (i === 'foreground') { void loadStatus(); return }
  if (i === 'double') { void rt.exit(); return }
  if (i === 'click') { void fire('play_pause'); return }
  if (i === 'up') { void fire('next'); return }
  if (i === 'down') { void fire('previous'); return }
}

async function main() {
  await rt.connect()
  rt.onInput(onInput)
  // Awaited directly (not via paint()'s fire-and-forget queue) — this is the
  // call that creates the page container the dash panel's image slot lives
  // in. Pushing a bitmap before this resolves races real BLE latency against
  // a same-origin fetch in loadStatus() below; on real hardware the fetch
  // sometimes wins, so the very first pushPanel() call landed on a container
  // that didn't exist yet and silently went nowhere.
  await render()
  startBatteryTracking(rt, (b) => { state.battery = b; paint() })
  startSpeedTracking(rt, (d) => { state.driving = d }, (event) => api.debugLog(event))
  await loadStatus()
  setInterval(() => void loadStatus(), STATUS_REFRESH_MS)
  void loadPhoneStatus()
  setInterval(() => void loadPhoneStatus(), STATUS_REFRESH_MS)
  void pushPanel()
  setInterval(() => void pushPanel(), PANEL_PUSH_INTERVAL_MS)
}

void main()
