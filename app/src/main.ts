import { Runtime } from './even'
import { createSpeedFilter } from './speed'
import { HeadNodDetector, NOD_COOLDOWN_MS, type MotionSample } from './drowsiness'

const runtime = new Runtime()
const filterSpeed = createSpeedFilter()
const detector = new HeadNodDetector()
let speedMph: number | null = null
let rendering = false
let pending = false
let stopped = false
let alert = false
let demoAlert = false
let motionEnabled = false
let lastMotionAt = 0
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

function updateMotionStatus() {
  if (stopped) return
  const current = detector.feedback()
  const fresh = lastMotionAt > 0 && Date.now() - lastMotionAt <= 5000
  const ready = current.calibrated && fresh
  runtime.setMotionFeedback(ready ? current.angle : null, ready ? current.nods : null)
  runtime.setCalibrationControls(motionEnabled && fresh)
  if (alert) {
    runtime.setMotionStatus(demoAlert ? 'Alert preview · dismiss to return to speed.' : 'Repeated head movement detected. Take a break. Tap the glasses or Dismiss alert to acknowledge.')
  } else if (!motionEnabled) {
    return

  } else if (!fresh) {
    runtime.setMotionStatus('Waiting for head-motion samples. Automatic alerts are paused.')
  } else if (!current.signalValid) {
    runtime.setMotionStatus('Waiting for a stable, nonzero motion signal. Automatic alerts are paused.')
  } else if (!current.calibrated) {
    runtime.setMotionStatus('Learning normal pose · ' + current.countdownSeconds + 's. Small movements are OK; large movements restart learning.')

  } else if (current.nodCooldownMs > 0) {
    runtime.setMotionStatus('Nod counted · waiting ' + (current.nodCooldownMs / 1000).toFixed(1) + 's before another nod can count.')
  } else if (current.poseJustReset) {
    runtime.setMotionStatus('Pose reset automatically · monitoring from your new posture.')
  } else if (current.postureCountdownSeconds != null) {
    runtime.setMotionStatus('New steady posture · resetting reference in ' + current.postureCountdownSeconds + 's. Small movements are OK.')
  } else if (!current.settled) {
    runtime.setMotionStatus('Learning your changed posture automatically. Keep a comfortable, fairly steady position.')
  } else {
    runtime.setMotionStatus('Pose set · downward nods only · ' + NOD_COOLDOWN_MS + 'ms pause per nod · gradual pose adjustment active.')
  }
}

function showAlert(preview = false) {
  if (stopped || alert) return
  alert = true
  demoAlert = preview
  updateMotionStatus()
  void paint()
}

function dismissAlert() {
  if (!alert) return
  detector.reset()
  alert = false
  demoAlert = false
  updateMotionStatus()
  void paint()
}

function onSpeed(speedMps: number | null) {
  if (stopped) return
  clearTimeout(staleTimer)
  speedMph = filterSpeed(speedMps)
  void paint()
  staleTimer = setTimeout(() => {
    speedMph = filterSpeed(null)
    void paint()
  }, 10_000)
}

function onMotion(sample: MotionSample) {
  if (stopped) return
  lastMotionAt = Date.now()
  if (alert) return
  if (detector.update(sample, lastMotionAt)) showAlert()
  const feedback = detector.feedback()
  runtime.setMotionFeedback(feedback.calibrated ? feedback.angle : null, feedback.calibrated ? feedback.nods : null)
}

function relearnPose() {
  if (stopped || !motionEnabled) return
  detector.relearn()
  updateMotionStatus()
}

function cleanup() {
  stopped = true
  clearTimeout(staleTimer)
  clearInterval(statusTimer)
  clearTimeout(retryTimer)
  void runtime.exit().catch(() => {})
}

async function main() {
  runtime.onExit(cleanup)
  runtime.onTap(dismissAlert)
  runtime.onMotion(onMotion)
  runtime.onCalibrate(relearnPose)
  runtime.onTestAlert(() => showAlert(true))
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
