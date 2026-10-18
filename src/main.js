import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  RebuildPageContainer,
  AppLocationAccuracy,
  OsEventTypeList,
  ImuReportPace,
} from '@evenrealities/even_hub_sdk';
import { mphFromMps, isStationary, isMoving, isLocationFresh, formatDuration, BreakReminder } from './logic.mjs';
import { HeadNodMonitor, alertPhase } from './nod.mjs';

// A purposely text-only HUD: fewer BLE updates, no clutter, no service calls.
// The SDK runs in the Even companion app WebView on the PHONE, not on the glasses.
const $ = (id) => document.getElementById(id);
const preview = $('preview');
const statusEl = $('status');
const reminder = new BreakReminder();
const head = new HeadNodMonitor();
let imuStatus = 'STARTING'; // STARTING | ACTIVE | UNAVAILABLE
let imuError = ''; 
let bridge = null;
let hasPage = false;
let view = 'hud'; // hud | setup-front | setup-down | check | sleepy | reported-alert | alert-review
let location = { mph: null, heading: null, lastAt: null };
let lastDisplay = '';
let busy = Promise.resolve();
let stopped = false;

function currentSpeed(now=Date.now()) {
  return isLocationFresh(location.lastAt, now) ? location.mph : null;
}
function parked(now=Date.now()) {
  return isStationary(location.mph, location.lastAt, now);
}
function stationaryScreen(now) {
  const speed = currentSpeed(now);
  return parked(now)
    ? `PARKED CHECK\n\nAre you feeling sleepy?\n\nSWIPE UP: Not sleepy\nSWIPE DOWN: Sleepy\n\nSelf-report only. Not a test.`
    : `PARKED CHECK UNAVAILABLE\n\n${speed === null ? 'Waiting for reliable GPS.' : 'Vehicle appears to be moving.'}\n\nDo not interact while driving.`;
}
function display(now=Date.now()) {
  const mph = currentSpeed(now);
  const moving = isMoving(location.mph, location.lastAt, now);
  const gps = mph === null ? 'GPS unavailable / stale' : `${Math.round(mph)} MPH (GPS estimate)`;
  const phase = alertPhase(head.flaggedAt,now);
  const calibratedSensor = head.calibrated && head.sensorFresh(now) && imuStatus === 'ACTIVE';
  const sensorLabel = imuStatus === 'UNAVAILABLE' ? 'HEAD SENSOR UNAVAILABLE'
    : !head.calibrated ? 'HEAD SENSOR NEEDS SETUP'
    : calibratedSensor ? 'HEAD SENSOR ACTIVE (EXPERIMENTAL)' : 'HEAD SENSOR PAUSED / STALE';
  let center;
  if (head.flaggedAt !== null && view === 'alert-review' && parked(now)) {
    center = `POSSIBLE HEAD NOD

You are stopped.
If sleepy, do not drive. Rest.

Tap again to dismiss this reminder.
This does not prove alertness.`;
  } else if (phase === 'check') {
    center = `ARE YOU AWAKE?

POSSIBLE HEAD-NOD PATTERN

Do not interact while moving.
Find a safe place to pull over.

This is NOT a sleep diagnosis.`;
  } else if (phase === 'stop') {
    center = `POSSIBLE DROWSINESS

PULL OVER SAFELY
AND REST.

Do not rely on this app to
keep you awake.

NO FLASHING ALERTS.`;
  } else if (view === 'setup-front') {
    center = `PARKED CALIBRATION 1/2

Sit normally and look straight ahead.
Hold steady, then TAP.

${head.error || 'Requires live IMU + parked GPS.'}`;
  } else if (view === 'setup-down') {
    center = `PARKED CALIBRATION 2/2

Naturally tilt your head down.
Hold steady, then TAP.

${head.error || 'Calibrates the direction of a downward dip.'}`;
  } else if (view === 'check') {
    center = stationaryScreen(now);
  } else if (view === 'sleepy') {
    center = `YOU REPORTED SLEEPINESS

DO NOT DRIVE.
Stop somewhere safe and rest.

This app cannot keep you awake.`;
  } else if (view === 'reported-alert') {
    center = `SELF-REPORT SAVED

You said you are not sleepy.
This does NOT verify alertness.

If you feel tired, do not drive.`;
  } else {
    const instruction = moving ? 'Do not interact while moving'
      : !head.calibrated ? 'TAP: calibrate head sensor while parked'
      : 'Tap: fatigue check | Swipe up: recalibrate';
    center = `${gps}

${sensorLabel}
Driving time: ${formatDuration(reminder.accumulatedMovingMs)}
${reminder.needsBreak ? 'BREAK RECOMMENDED' : `Break in: ${formatDuration(reminder.remainingMs)}`}

${instruction}`;
  }
  const header = 'ROADGUARD  |  LOCAL MODE';
  const footer = head.flaggedAt !== null
    ? parked(now) ? 'STOPPED: TAP TO REVIEW' : 'STOP SAFELY. NO RESPONSE REQUIRED.'
    : moving ? 'STOP SAFELY IF DROWSY'
    : !head.calibrated ? 'Set up while parked' : 'Parked: tap or swipe up';
  return {header, body:center, footer};
}
function makeText(id, name, y, height, content, capture=0) {
  return new TextContainerProperty({
    xPosition:0, yPosition:y, width:576, height,
    paddingLength: 8, borderWidth:1, borderColor:5,
    containerID:id, containerName:name, isEventCapture:capture,
    content,
  });
}
function makePage(parts, Kind) {
  return new Kind({
    containerTotalNum:3,
    textObject:[
      makeText(1,'head',0,48,parts.header),
      makeText(2,'main',48,186,parts.body,1),
      makeText(3,'foot',234,54,parts.footer),
    ],
  });
}
async function push(now=Date.now()) {
  const parts = display(now);
  const combined = `${parts.header}\n\n${parts.body}\n\n${parts.footer}`;
  preview.textContent = combined;
  statusEl.textContent = bridge ? 'Even Hub bridge connected.' : 'Browser preview. Real GPS requires Even Hub on your phone.';
  if (!bridge || combined === lastDisplay) return;
  const prev = lastDisplay;
  try {
    if (!hasPage) {
      const result = await bridge.createStartUpPageContainer(makePage(parts, CreateStartUpPageContainer));
      if (result !== 0) throw new Error(`Cannot create G2 page (code ${result})`);
      hasPage = true;
    } else {
      const p = prev.split('\n\n');
      // Upgrade only the parts that changed. Fallback rebuilds the same 3-slot layout.
      let ok = true;
      for (const [id,name,content,old] of [
        [1,'head',parts.header,p[0]], [2,'main',parts.body,p.slice(1,-1).join('\n\n')], [3,'foot',parts.footer,p.at(-1)],
      ]) {
        if (content !== old) {
          const sent = await bridge.textContainerUpgrade(new TextContainerUpgrade({containerID:id,containerName:name,content}));
          if (!sent) {ok=false; break;}
        }
      }
      if (!ok) await bridge.rebuildPageContainer(makePage(parts, RebuildPageContainer));
    }
    lastDisplay = combined;
  } catch (e) {
    statusEl.textContent = `G2 update error: ${String(e?.message || e)}`;
  }
}
function requestPaint() { busy = busy.then(() => push()).catch(() => {}); }
function acceptInput(action) {
  if (stopped) return;
  const now = Date.now();
  // Absolutely no acknowledgement or calibration gestures are solicited
  // while the phone GPS says the vehicle is moving or location is unknown.
  if (!parked(now)) return;
  if (head.flaggedAt !== null) {
    if (action === 'click' && view === 'alert-review') {
      head.clearAlert(); // Dismissible only after stopping; not proof of wakefulness.
      view = 'hud';
    } else if (action === 'click') view = 'alert-review';
    requestPaint(); return;
  }
  if (action === 'double' || action === 'home') { view = 'hud'; requestPaint(); return; }
  if (view === 'hud') {
    if (action === 'up' && head.calibrated) { head.startCalibration(); view = 'setup-front'; }
    else if (action === 'click') view = head.calibrated ? 'check' : 'setup-front';
  } else if (view === 'setup-front') {
    if (action === 'click' && head.captureNeutral(now)) view = 'setup-down';
  } else if (view === 'setup-down') {
    if (action === 'click' && head.captureDown(now)) view = 'hud';
  } else if (view === 'check') {
    if (action === 'down') view = 'sleepy';
    if (action === 'up') view = 'reported-alert';
  } else if ((view === 'sleepy' || view === 'reported-alert') && action === 'click') {
    view = 'hud';
  }
  requestPaint();
}
function onEvent(evt) {
  // The G2 IMU reports gravity-like XYZ vectors, not eye closure or sleep.
  const sys = evt?.sysEvent;
  if (sys?.eventType === OsEventTypeList.IMU_DATA_REPORT) {
    if (sys.imuData) {
      const now=Date.now();
      const previous=head.flaggedAt;
      head.observe(sys.imuData, now, isMoving(location.mph,location.lastAt,now));
      if (head.flaggedAt!==previous) requestPaint();
    }
    return;
  }
  // A single tap's enum 0 may be omitted from protobuf event payloads.
  const envelope = evt?.listEvent ?? evt?.textEvent ?? evt?.sysEvent;
  if (!envelope) return;
  const type = envelope.eventType ?? OsEventTypeList.CLICK_EVENT;
  const actions = {
    [OsEventTypeList.CLICK_EVENT]:'click',
    [OsEventTypeList.SCROLL_TOP_EVENT]:'up',
    [OsEventTypeList.SCROLL_BOTTOM_EVENT]:'down',
    [OsEventTypeList.DOUBLE_CLICK_EVENT]:'double',
  };
  if (Object.prototype.hasOwnProperty.call(actions,type)) acceptInput(actions[type]);
}
async function start() {
  // No fabricated GPS data in the browser, because a safety-adjacent UI must
  // not mislead testers into thinking an arbitrary speed is real.
  const hostAvailable = typeof window.flutter_inappwebview?.callHandler === 'function';
  if (hostAvailable) {
    try {
      bridge = await waitForEvenAppBridge();
      bridge.onEvenHubEvent(onEvent);
    } catch(e) {statusEl.textContent=`Even Hub unavailable: ${String(e?.message || e)}`;}
  }
  await push(); // MUST create G2 startup page before enabling IMU.
  if (bridge) {
    try {
      if (typeof bridge.imuControl !== 'function') throw new Error('IMU bridge method unavailable');
      const ok = await bridge.imuControl(true, ImuReportPace.P500);
      if (!ok) throw new Error('IMU subscription rejected');
      imuStatus='ACTIVE';
    } catch(e) {
      imuStatus='UNAVAILABLE';
      imuError=String(e?.message || e);
      statusEl.textContent=`Experimental head tracking unavailable: ${imuError}`;
    }
    requestPaint();
  }
  if (bridge) {
    try {
      bridge.onAppLocationChanged((fix) => {
        const lat = fix?.latitude, lon = fix?.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        location = {
          mph: mphFromMps(fix.speed),
          heading: Number.isFinite(fix.heading) ? fix.heading : null,
          lastAt: Date.now(),
        };
        requestPaint();
      });
      const ok = await bridge.startAppLocationUpdates({
        accuracy: AppLocationAccuracy.High, intervalMs: 3000, distanceFilter:5,
      });
      if (!ok) statusEl.textContent = 'Location updates unavailable. Check permissions.';
    } catch(e) {statusEl.textContent=`Location failed: ${String(e?.message || e)}`;}
  }
  // Timer has explicit bounded catch-up, avoids claiming monitoring while suspended.
  setInterval(() => {
    if (stopped) return;
    const now = Date.now();
    const speed = currentSpeed(now);
    reminder.update(now, isMoving(speed,location.lastAt,now), isStationary(speed,location.lastAt,now));
    if (!parked(now) && view !== 'hud' && view !== 'sleepy') view = 'hud'; // alerts override this view anyway
    requestPaint();
  }, 3000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // After resuming, hide old speed until the next verified GPS update.
    location.lastAt = null;
    reminder.lastTickAt = null;
    head.invalidateStream();
    requestPaint();
  });
}
$('check').onclick = () => acceptInput('click');
$('up').onclick = () => acceptInput('up');
$('down').onclick = () => acceptInput('down');
$('home').onclick = () => acceptInput('home');
start();
