# Glass Car Dash

A live MPH speed display for Even Realities G2, retaining the segmented curves from the Silverline Normal Drive design.

The speed number, MPH label, and surrounding arcs normally appear on the glasses. The Even app supplies GPS speed from the phone; the app converts it to MPH and smooths noisy readings. A dash appears until a valid reading arrives, when the phone reports invalid speed, or after ten seconds without a GPS update. Double-tap the glasses to exit and stop location tracking.

In a regular browser, the preview uses clearly labeled simulated speed. Open the app through the Even app's Prototype Mode QR scanner for real GPS readings. Allow the Even app to use precise location and keep it open during local testing. GPS updates are requested once per second; actual cadence depends on the phone and GPS reception.

## Head-nod alert

Reopen the app using the Even app's Prototype Mode QR scanner. Keep the phone app open. The phone controls show sensor availability and calibration instructions.

1. While stationary and wearing the glasses, look forward and press **Capture forward pose**. Hold still for two seconds.
2. Lower your chin and press **Capture head-down pose**. Hold still for two seconds, then return to looking forward.
3. Monitoring starts after calibration. Two downward dips lasting 350–2500 ms each, completed within eight seconds, trigger the **TAKE A BREAK / Head nod detected** screen. There is no GPS speed gate, so you can test while stationary.
4. Tap the glasses or press **Dismiss alert** to return to the current speed. Automatic alerts have a 30-second cooldown. **Preview alert** displays the warning without triggering the detector and works in a browser too.

Motion comes from the glasses' IMU, not the phone. The SDK documents only raw x/y/z samples, with no axis or unit guarantees; two-pose calibration avoids assuming a particular pitch axis. Missing or rejected sensor data must not be treated as working monitoring. Sensor interruptions clear calibration and require another capture. Exit stops location and IMU reporting.

This is a head-motion prototype, not a validated drowsiness detector. Deliberate nods can trigger it, and drowsiness without nodding will not. Thresholds and sensor behavior still need validation on the actual glasses. The alert's triangle matches the Head-nod Alert mockup; it uses transparent surroundings and stays visible until acknowledged.

## Run locally

Requires Node.js 22 or newer.

```sh
npm --prefix app ci
npm --prefix app run dev -- --host 0.0.0.0
```

Open http://127.0.0.1:5173. No backend, ADB, API keys, or map services are needed.

## Validate and build

```sh
npm test
npm run build
```

## Install on glasses

```sh
cd app
npm run build
npm run pack
```

Upload the generated `.ehpk` to the Even Hub developer portal and open it through the Even app. Allow location access on the phone for real speed readings.
