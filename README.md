# RoadGuard G2: experimental head-nod warning prototype

A **standalone Even Hub source prototype** for Even Realities G2. This iteration builds on the earlier standalone GPS driving dashboard, drawing on the MIT-licensed architectural ideas in [Glass Car Dash](https://github.com/drrobotk/glass-car-dash). The original author is Usman Kayani (2026); see `UPSTREAM-LICENSE.txt`. No Termux, ADB, SMS service, account, external API, or user-hosted backend.

**Important: this is an UNVALIDATED research prototype, not a driver alertness detector or an emergency/safety system.** It cannot reliably determine whether anyone is awake, asleep, experiencing microsleep, or safe to drive. It can produce false alarms AND miss dangerous drowsiness. Do not rely on it to extend a driving session. Do not test interaction while operating a moving vehicle.

## What changed in this build

- **Head-nod-like movement detector:** subscribes to the G2's IMU XYZ stream with `bridge.imuControl(true, ImuReportPace.P500)` and listens for `sysEvent.eventType === OsEventTypeList.IMU_DATA_REPORT`.
- **Parked-only two-pose calibration:** looks ahead, tap; tilt head naturally downward, tap. The calibration is per wear session and is lost after restart. Exact IMU axis meaning varies or is undocumented, so the detector learns the user's down direction from the reported vectors instead of assuming any axis is pitch.
- **Noise filters:** rejects implausible XYZ magnitude and single-sample spikes, smooths the IMU vector, seeks sustained downward orientation changes followed by return (or a sustained dip), and uses a refractory period. Two potential nod-like events within three minutes trigger a warning. These thresholds are heuristic and are **not validated**.
- **Two-stage static warning:** first a steady `ARE YOU AWAKE? / POSSIBLE HEAD-NOD PATTERN / PULL OVER SAFELY` display. After about 10 seconds, it changes once to a steady `POSSIBLE DROWSINESS / PULL OVER SAFELY AND REST`. **No flashing, strobe, or driver-response challenge**. The escalation is not proof that a driver failed to respond.
- **Parked-only acknowledgement:** once parked, tapping opens an explanatory review screen; tapping again dismisses the warning without implying the person is awake.
- **Existing features:** approximate GPS speed, 90-minute driving-time break reminder, optional parked-only manual sleepiness self-report, browser preview, no external requests.
- **Fail-visible handling:** if live GPS or IMU readings stop, status is marked stale or unavailable instead of asserting monitoring is active. The WebView may be suspended by the phone.

## UI workflow (do this only while parked)

1. Open RoadGuard from Even Hub. Grant location access. The IMU starts automatically if supported by the connected G2/Even phone app.
2. After stationary GPS is available, **tap** to enter calibration.
3. Look straight ahead, hold still for about 1 to 2 seconds and **tap**.
4. Look down naturally, hold still for about 1 to 2 seconds and **tap**.
5. The GPS speed display and experimental IMU monitor will be ready while the app remains running. Do **not** interact with the glasses while driving.
6. When parked, tap to use the manual sleepiness check. To recalibrate, swipe up while parked. On a potential head-nod warning, pull over safely, then review/dismiss it when parked.

## Why no flash/strobe?

A strobe close to a driver's eyes can distract or startle and may provoke seizures in photosensitive individuals. A motorist needs to control the vehicle safely, not respond to an abrupt visual challenge. An unanswered prompt is **not proof of sleep**, and an acknowledged prompt is **not proof of wakefulness**. Instead, the app shows a single prominent warning and keeps it steady until safely dismissed.

The G2 has no speaker, camera, or documented eye-tracking sensor. Any future phone-based sound alert needs explicit cross-platform testing and must not claim guaranteed delivery.

## Run and test

Requires Node 20+ and access to npm dependencies:

```sh
npm install
npm test
npm run dev
npm run simulate   # other terminal
npm run build
npm run pack       # creates roadguard-g2.ehpk from dist/
```

The pure movement logic has offline synthetic tests. A plain browser cannot provide genuine G2 IMU or phone GPS. The packaged plugin has **not** been built or validated on real G2 hardware in this environment. Before considering any publication, bench-test the actual sensor values, report timing, and false alerts in a parked car, with a passenger, or in a simulator. Do not test head-dipping or response prompts as a driver on public roads. Check Even Hub's publication guidelines and local driving laws. Even Realities does not endorse using its Navigate feature for motor-vehicle driving.

## What to evaluate before refining the detector

- Confirm that `imuControl` exists and returns success on the target G2 firmware/Even App versions, and that the event stream arrives while the Hub plugin is running.
- Record opt-in test sessions **locally** with timestamp, normalized XYZ, and annotated voluntary head motions. Compare forward nods versus normal mirror checks, road bumps, turns, and looking at instruments. Do not collect data from unwitting passengers.
- Measure candidate/event rates, time from movement to warning, and false positives against benign driving behaviors. More importantly, acknowledge that **false negatives cannot be validated** with this sensor alone.
- Test both iOS and Android lifecycle interruptions. If the app suspends or the IMU stream stalls, treat monitoring as inactive rather than assumed continuous.
- Review accessibility and distraction risk; a large static banner may still obstruct attention. Safety or regulatory review is required before marketing as a drowsiness detection product.
