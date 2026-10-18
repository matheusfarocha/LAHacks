import { Runtime } from './even'
import { createSpeedFilter } from './speed'
import { HeadNodDetector, averageMotion, type MotionSample } from './drowsiness'

const runtime = new Runtime()
const filterSpeed = createSpeedFilter()
const detector = new HeadNodDetector()
let speedMph: number | null = null
let rendering = false
let pending = false
let stopped = false
let alert = false
let demoAlert = false
let calibrated = false
let motionEnabled = false
let lastMotionAt = 0
let neutral: MotionSample | null = null
let neutralSamples: MotionSample[] = []
let capture: 'neutral' | 'down' | null = null
let captureSamples: MotionSample[] = []
let staleTimer: ReturnType<typeof setTimeout> | undefined
let calibrationTimer: ReturnType<typeof setTimeout> | undefined
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
  if (stopped || capture) return
  if (alert) {
    runtime.setMotionStatus(demoAlert ? 'Alert preview · dismiss to return to speed.' : 'Repeated head nods detected. Take a break. Tap the glasses or Dismiss alert to acknowledge.')
    return
  }
  if (!motionEnabled) return
  const fresh = lastMotionAt > 0 && Date.now() - lastMotionAt <= 2000
  runtime.setCalibrationControls(fresh, neutral != null)
  if (!fresh) {
    runtime.setMotionStatus('Waiting for head-motion samples. Automatic alerts are paused.')
  } else if (calibrated) {
    runtime.setMotionStatus('Head-nod monitoring active · two nods within eight seconds trigger an alert.')
  } else if (neutral) {
    runtime.setMotionStatus('Now lower your chin and capture the head-down pose. Hold still during capture.')
  } else {
    runtime.setMotionStatus('Look straight ahead, then capture your forward pose. Hold still during capture.')
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
  alert = false
  demoAlert = false
  detector.reset()
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
  if (stopped || ![sample.x, sample.y, sample.z].every(Number.isFinite)) return
  const resumed = !lastMotionAt || Date.now() - lastMotionAt > 2000
  lastMotionAt = Date.now()
  if (resumed && motionEnabled) updateMotionStatus()
  if (capture) {
    captureSamples.push({ ...sample })
    return
  }
  if (calibrated && !alert && detector.update(sample, lastMotionAt, true)) showAlert()
}

function capturePose(pose: 'neutral' | 'down') {
  if (stopped || capture || !motionEnabled || Date.now() - lastMotionAt > 2000) return
  if (pose === 'down' && !neutral) return
  if (pose === 'neutral') {
    calibrated = false
    neutral = null
    neutralSamples = []
    detector.reset()
  }
  capture = pose
  captureSamples = []
  runtime.setCalibrationControls(false, false)
  runtime.setMotionStatus(pose === 'neutral' ? 'Hold your head forward and still for two seconds…' : 'Hold your chin down and still for two seconds…')
  calibrationTimer = setTimeout(() => {
    capture = null
    const mean = averageMotion(captureSamples)
    if (!mean) {
      runtime.setMotionStatus('Not enough motion samples. Keep the glasses connected and try capturing again.')
    } else if (pose === 'neutral') {
      neutral = mean
      neutralSamples = [...captureSamples]
      updateMotionStatus()
    } else if (neutral) {
      const distance = Math.hypot(mean.x - neutral.x, mean.y - neutral.y, mean.z - neutral.z)
      const spread = (samples: MotionSample[], center: MotionSample) => Math.sqrt(
        samples.reduce((sum, sample) => sum + (sample.x - center.x) ** 2 + (sample.y - center.y) ** 2 + (sample.z - center.z) ** 2, 0) / samples.length,
      )
      if (spread(neutralSamples, neutral) > distance * 0.2 || spread(captureSamples, mean) > distance * 0.2 || !detector.calibrate(neutral, mean)) {
        runtime.setMotionStatus('Poses were too similar or moved during capture. Capture forward and head-down poses again.')
      } else {
        calibrated = true
        updateMotionStatus()
      }
    }
    runtime.setCalibrationControls(true, neutral != null)
    // Keep capture feedback visible until the user tries again or a sensor gap.
  }, 2000)
}

function cleanup() {
  stopped = true
  clearTimeout(staleTimer)
  clearTimeout(calibrationTimer)
  clearInterval(statusTimer)
  clearTimeout(retryTimer)
  void runtime.exit().catch(() => {})
}

async function main() {
  runtime.onExit(cleanup)
  runtime.onTap(dismissAlert)
  runtime.onMotion(onMotion)
  runtime.onCalibrate(capturePose)
  runtime.onTestAlert(() => showAlert(true))
  runtime.onAcknowledge(dismissAlert)
  await runtime.connect()
  await paint()
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
    if (lastMotionAt && Date.now() - lastMotionAt > 2000) {
      clearTimeout(calibrationTimer)
      capture = null
      captureSamples = []
      calibrated = false
      neutral = null
      detector.reset()
      runtime.setCalibrationControls(false, false)
      if (!alert) runtime.setMotionStatus('Head-motion updates paused. Recalibrate after the sensor reconnects.')
    } else if (calibrated || motionEnabled && !lastMotionAt) updateMotionStatus()
    else if (!capture) runtime.setCalibrationControls(Date.now() - lastMotionAt <= 2000, neutral != null)
  }, 1000)
}

window.addEventListener('pagehide', cleanup)
void main().catch((error: unknown) => {
  cleanup()
  runtime.showError(error instanceof Error ? error.message : 'Unable to start the display.')
})
