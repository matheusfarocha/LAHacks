import { Runtime } from './even'
import { createSpeedFilter } from './speed'
import { HeadNodDetector, averageMotion, type MotionSample } from './drowsiness'
import { DEFAULT_NAVIGATION, type NavigationInstruction } from './navigation'
import { findDestination, getDrivingRoute, type Destination } from './openmap'
import { RouteTracker, type LocationFix, type RouteProgress } from './route'

const runtime = new Runtime()
const filterSpeed = createSpeedFilter()
const detector = new HeadNodDetector()
let speedMph: number | null = null
let headingDegrees: number | null = null
let navigation: NavigationInstruction = DEFAULT_NAVIGATION
let lastFix: LocationFix | null = null
let routeTracker: RouteTracker | null = null
let activeDestination: Destination | null = null
let routeAbort: AbortController | null = null
let lastRerouteAt = 0
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
let arrivalTimer: ReturnType<typeof setTimeout> | undefined

async function paint(): Promise<void> {
  pending = true
  if (rendering || stopped) return
  rendering = true
  try {
    while (pending && !stopped) {
      pending = false
      await runtime.render(speedMph, alert, navigation, headingDegrees)
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

function onLocation(fix: LocationFix) {
  if (stopped) return
  clearTimeout(staleTimer)
  const firstFix = lastFix == null
  lastFix = fix
  runtime.updateMapLocation(fix)
  speedMph = filterSpeed(fix.speedMps, fix.timestamp)
  if (fix.headingDegrees != null) headingDegrees = fix.headingDegrees
  if (routeTracker) updateRouteProgress(routeTracker.update(fix))
  else if (firstFix) runtime.setNavigationStatus(`GPS ready (±${Math.round(fix.accuracy)} m) · enter a destination.`)
  void paint()
  staleTimer = setTimeout(() => {
    speedMph = filterSpeed(null)
    if (routeTracker) runtime.setNavigationStatus('GPS signal lost · holding the last route instruction.')
    void paint()
  }, 10_000)
}

function updateRouteProgress(progress: RouteProgress) {
  navigation = progress.instruction
  if (progress.arrived) {
    const destinationName = activeDestination?.name ?? 'destination'
    routeTracker = null
    runtime.setNavigationStatus(`Arrived at ${destinationName}.`)
    clearTimeout(arrivalTimer)
    arrivalTimer = setTimeout(() => {
      navigation = DEFAULT_NAVIGATION
      activeDestination = null
      runtime.clearMapRoute()
      runtime.setNavigationStatus('GPS ready · enter a destination to start navigation.')
      void paint()
    }, 4000)
    return
  }
  const milesRemaining = progress.distanceRemainingMeters / 1609.344
  const minutesRemaining = Math.max(1, Math.round(progress.durationRemainingSeconds / 60))
  runtime.setNavigationStatus(`${milesRemaining.toFixed(milesRemaining < 10 ? 1 : 0)} mi remaining · about ${minutesRemaining} min.`)
  if (routeTracker?.shouldReroute(progress) && Date.now() - lastRerouteAt >= 15_000) void reroute()
}

async function startNavigation(query: string) {
  const destinationQuery = query.trim()
  if (destinationQuery.length < 2) {
    runtime.setNavigationStatus('Enter an address or place name.')
    return
  }
  if (!lastFix) {
    runtime.setNavigationStatus('Requesting a fresh GPS fix…')
    try {
      onLocation(await runtime.requestCurrentLocation())
    } catch (error) {
      runtime.setNavigationStatus(error instanceof Error ? `GPS unavailable: ${error.message}` : 'Unable to get a GPS fix.')
      return
    }
  }
  if (!lastFix) return
  routeAbort?.abort()
  routeAbort = new AbortController()
  const signal = routeAbort.signal
  runtime.setNavigationStatus('Finding destination…')
  try {
    const destination = await findDestination(destinationQuery, lastFix, signal)
    runtime.setNavigationStatus(`Calculating an OpenStreetMap driving route to ${destination.name}…`)
    const route = await getDrivingRoute(lastFix, destination, signal)
    if (signal.aborted || !lastFix) return
    activeDestination = destination
    routeTracker = new RouteTracker(route)
    runtime.showMapRoute(route.geometry, destination.coordinates)
    lastRerouteAt = Date.now()
    updateRouteProgress(routeTracker.update(lastFix))
    void paint()
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      runtime.setNavigationStatus(error instanceof Error ? error.message : 'Unable to start navigation.')
    }
  }
}

function stopNavigation() {
  routeAbort?.abort()
  routeAbort = null
  routeTracker = null
  activeDestination = null
  navigation = DEFAULT_NAVIGATION
  runtime.clearMapRoute()
  clearTimeout(arrivalTimer)
  runtime.setNavigationStatus('Navigation stopped · live GPS remains active.')
  void paint()
}

async function reroute() {
  if (!lastFix || !activeDestination || !routeTracker) return
  lastRerouteAt = Date.now()
  routeAbort?.abort()
  routeAbort = new AbortController()
  const signal = routeAbort.signal
  const destination = activeDestination
  runtime.setNavigationStatus('Off route · calculating a new route…')
  try {
    const route = await getDrivingRoute(lastFix, destination, signal)
    if (signal.aborted || !lastFix || activeDestination !== destination) return
    routeTracker = new RouteTracker(route)
    runtime.showMapRoute(route.geometry, destination.coordinates)
    updateRouteProgress(routeTracker.update(lastFix))
    void paint()
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      runtime.setNavigationStatus('Reroute failed · continuing with the current route.')
    }
  }
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
  routeAbort?.abort()
  clearTimeout(staleTimer)
  clearTimeout(calibrationTimer)
  clearInterval(statusTimer)
  clearTimeout(retryTimer)
  clearTimeout(arrivalTimer)
  void runtime.exit().catch(() => {})
}

async function main() {
  runtime.onExit(cleanup)
  runtime.onTap(dismissAlert)
  runtime.onMotion(onMotion)
  runtime.onCalibrate(capturePose)
  runtime.onTestAlert(() => showAlert(true))
  runtime.onAcknowledge(dismissAlert)
  runtime.onStartNavigation((destination) => void startNavigation(destination))
  runtime.onStopNavigation(stopNavigation)
  await runtime.connect()
  await paint()
  await Promise.all([
    runtime.startLocationUpdates(onLocation).catch((error: unknown) => {
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
