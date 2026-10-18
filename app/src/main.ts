import { Runtime } from './even'
import { createSpeedFilter } from './speed'
import { HeadNodDetector, NOD_WINDOW_MS, toMotionSample, type MotionSample, type NodAlert } from './drowsiness'

const AXIS_KEY = 'glass-car-dash:pitch-axis'

const runtime = new Runtime()
const filterSpeed = createSpeedFilter()
const detector = new HeadNodDetector()
let speedMph: number | null = null
let rendering = false
let pending = false
let stopped = false
let alert: NodAlert | null = null
let demoAlert = false
let motionEnabled = false
let lastMotionAt = 0
let lastRaw: MotionSample | null = null
let lastGpsSpeed: { mps: number; at: number } | null = null
let staleTimer: ReturnType<typeof setTimeout> | undefined
let statusTimer: ReturnType<typeof setInterval> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined

async function paint(): Promise<void> {
  pending = true
  if (rendering || stopped) return
  rendering = true
  try {
    while (pending && !stopped) {
      pending = false
      await runtime.render(speedMph, alert)
    }
  } catch (error) {
    runtime.showError(error instanceof Error ? error.message : 'Unable to update the display.')
    clearTimeout(retryTimer)
    if (!stopped) retryTimer = setTimeout(() => void paint(), 1000)
  } finally {
    rendering = false
  }
}

function describeLastEvent(current: ReturnType<HeadNodDetector['feedback']>): string {
  const event = current.lastEvent
  if (!event || Date.now() - event.at > NOD_WINDOW_MS) return ''
  const shape = event.dropMs || event.riseMs ? ', down ' + event.dropMs + 'ms / up ' + event.riseMs + 'ms' : ''
  return ' Last droop (' + Math.round(event.depthDeg) + '°' + shape + '): '
    + (event.counted ? 'counted.' : 'ignored, ' + event.reason + '.')
}

function updateMotionStatus() {
  if (stopped) return
  const current = detector.feedback()
  const fresh = lastMotionAt > 0 && Date.now() - lastMotionAt <= 5000
  const ready = current.calibrated && fresh
  runtime.setMotionFeedback(ready ? current.angle : null, ready ? current.nods : null)
  runtime.setCalibrationControls(motionEnabled && fresh, motionEnabled && ready && current.phase !== 'teaching')
  runtime.setDiagnostics(!motionEnabled ? '' : 'Sensor ' + current.sampleRateHz.toFixed(1) + ' Hz'
    + (lastRaw ? ' · raw x ' + lastRaw.x.toFixed(2) + ' y ' + lastRaw.y.toFixed(2) + ' z ' + lastRaw.z.toFixed(2) : ' · no samples yet')
    + ' · ' + current.phase)
  if (alert) {
    runtime.setMotionStatus(demoAlert ? 'Alert preview · dismiss to return to speed.'
      : alert === 'head-down' ? 'Head stayed down. Wake up. The warning stays until the glasses are tapped or Dismiss alert is pressed.'
      : 'Microsleep nods detected. Take a break. Tap the glasses or Dismiss alert to acknowledge.')
  } else if (!motionEnabled) {
    return
  } else if (!fresh) {
    runtime.setMotionStatus('Waiting for head-motion samples. Automatic alerts are paused.')
  } else if (!current.signalValid) {
    runtime.setMotionStatus('Head-motion readings are invalid. Automatic alerts are paused.')
  } else if (current.phase === 'learning') {
    runtime.setMotionStatus('Learning normal pose · hold your head naturally for ' + current.countdownSeconds + 's.')
  } else if (current.phase === 'teaching') {
    runtime.setMotionStatus('Teaching nod direction · look down (chin toward chest) and hold still for a second.')
  } else if (current.disturbed) {
    runtime.setMotionStatus('Bump or hard braking/acceleration · nods paused for a moment.' + describeLastEvent(current))
  } else if (current.headDownMs > 0) {
    runtime.setMotionStatus('Head down · ' + (current.headDownMs / 1000).toFixed(1) + 's. Lift it or the wake-up warning shows.')
  } else if (current.poseJustReset) {
    runtime.setMotionStatus('New steady posture adopted · monitoring from here.')
  } else {
    runtime.setMotionStatus('Watching for microsleep nods.' + describeLastEvent(current))
  }
}

function showAlert(kind: NodAlert, preview = false) {
  if (stopped || alert) return
  alert = kind
  demoAlert = preview
  updateMotionStatus()
  void paint()
}

function dismissAlert() {
  if (!alert) return
  detector.reset()
  alert = null
  demoAlert = false
  updateMotionStatus()
  void paint()
}

function onSpeed(speedMps: number | null) {
  if (stopped) return
  const now = Date.now()
  const valid = speedMps != null && Number.isFinite(speedMps) && speedMps >= 0
  if (valid && lastGpsSpeed && now - lastGpsSpeed.at >= 300 && now - lastGpsSpeed.at <= 5000) {
    detector.noteVehicleAcceleration((speedMps - lastGpsSpeed.mps) / ((now - lastGpsSpeed.at) / 1000), now)
  }
  lastGpsSpeed = valid ? { mps: speedMps, at: now } : null
  clearTimeout(staleTimer)
  speedMph = filterSpeed(speedMps)
  void paint()
  staleTimer = setTimeout(() => {
    speedMph = filterSpeed(null)
    void paint()
  }, 10_000)
}

function onMotion(raw: unknown) {
  if (stopped) return
  lastMotionAt = Date.now()
  const sample = toMotionSample(raw)
  if (sample) lastRaw = sample
  if (alert) return
  const detected = detector.update(sample, lastMotionAt)
  if (detected) showAlert(detected)
  const axis = detector.takeLearnedAxis()
  if (axis) {
    try { localStorage.setItem(AXIS_KEY, JSON.stringify(axis)) } catch {}
    updateMotionStatus()
  }
  const feedback = detector.feedback()
  runtime.setMotionFeedback(feedback.calibrated ? feedback.angle : null, feedback.calibrated ? feedback.nods : null)
}

function relearnPose() {
  if (stopped || !motionEnabled) return
  detector.relearn()
  updateMotionStatus()
}

function teachDirection() {
  if (stopped || !motionEnabled) return
  detector.teachDownDirection()
  updateMotionStatus()
}

function restoreAxis() {
  try {
    const saved = localStorage.getItem(AXIS_KEY)
    if (saved) detector.setPitchAxis(JSON.parse(saved))
  } catch {}
}

function cleanup() {
  stopped = true
  clearTimeout(staleTimer)
  clearInterval(statusTimer)
  clearTimeout(retryTimer)
  void runtime.exit().catch(() => {})
}

async function main() {
  restoreAxis()
  runtime.onExit(cleanup)
  runtime.onTap(dismissAlert)
  runtime.onMotion(onMotion)
  runtime.onCalibrate(relearnPose)
  runtime.onTeachDirection(teachDirection)
  runtime.onTestAlert(() => showAlert('nods', true))
  runtime.onAcknowledge(dismissAlert)
  await runtime.connect()
  await paint()
  if (stopped) return
  await Promise.all([
    runtime.startSpeedUpdates(onSpeed).catch((error: unknown) => {
      runtime.showError(error instanceof Error ? error.message : 'GPS unavailable.')
    }),
    runtime.startMotionUpdates().then((enabled) => {
      motionEnabled = enabled
      if (!enabled) runtime.setMotionStatus('Automatic head-nod alerts unavailable here. You can still preview the alert.')
      else updateMotionStatus()
    }).catch(() => runtime.setMotionStatus('Unable to enable the head-motion sensor. Reopen the app to try again.')),
  ])
  if (stopped) return
  statusTimer = setInterval(() => {
    if (lastMotionAt && Date.now() - lastMotionAt > 5000) detector.reset()
    updateMotionStatus()
  }, 500)
}

window.addEventListener('pagehide', cleanup)
void main().catch((error: unknown) => {
  cleanup()
  runtime.showError(error instanceof Error ? error.message : 'Unable to start the display.')
})
