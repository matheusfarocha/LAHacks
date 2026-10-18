# Glass Car Dash

A live MPH speed display for Even Realities G2, retaining the segmented curves from the Silverline Normal Drive design.

The speed number, MPH label, and surrounding arcs normally appear on the glasses. The Even app supplies GPS speed from the phone; the app converts it to MPH and smooths noisy readings. A dash appears until a valid reading arrives, when the phone reports invalid speed, or after ten seconds without a GPS update. Double-tap the glasses to exit and stop location tracking.

In a regular browser, the preview uses clearly labeled simulated speed. Open the app through the Even app's Prototype Mode QR scanner for real GPS readings. Allow the Even app to use precise location and keep it open during local testing. GPS updates are requested once per second; actual cadence depends on the phone and GPS reception.

## Head-nod alert

Open the app using the Even app's Prototype Mode QR scanner and keep the phone app open. The reference head pose is learned automatically over about three seconds with small natural movements allowed (4° RMS, 10° excursion limit). Countdown, Pose set, nod count, and cooldown are shown on the phone only. The glasses show the speed gauge or the break alert. There is no down-direction confirmation button or per-session pose test.

Only positive downward pitch counts. Two downward dips and returns within eight seconds trigger **TAKE A BREAK**. Each dip must exceed 8° and return within 3°, lasting 180–3000 ms. A 750 ms cooldown after each counted nod prevents repeated counts from one bob; a fresh neutral pose and new dip are required after cooldown. Looking up or making a dominant sideways tilt cancels a pending dip. Holding a tilt alone does not trigger an alert. There is no 30-second alert cooldown.

The reference adjusts gradually for slow changes: a ten-second time constant capped at 0.35° per second, within 6° of the current reference. Reference tracking pauses during fast motion, a pending/countable nod sequence, or nod cooldown. If a changed posture remains fairly steady for eight seconds, the app adopts it as the new reference and clears the old nod sequence, rather than requiring a return to the original pose. The phone shows a reset countdown and a confirmation. Natural variation up to 3° RMS is allowed during this reset; rapid bobs, fresh nod sequences, and sensor interruptions cannot complete it. A long held head drop can therefore also become the reference after this delay; this prototype cannot identify the reason for a sustained posture change. This can follow gradual road pitch, but cannot reliably distinguish every slow head slump from a vehicle incline using glasses motion alone.

The signed device axis is configured in `G2_DOWN_AXIS` in `app/src/drowsiness.ts`, rather than inferred from a neutral pose or a user test. Its default direction still needs validation on the actual device/firmware; looking down should make the phone's signed pitch positive. Unit tests exercise the mapping mathematically, not physical sensor polarity.

Tap the glasses or press **Dismiss alert** to return to current speed. **Preview alert** works in the browser too, where speed and the steady pose-learning signal are clearly labeled simulations. **Relearn driving pose** is optional if the glasses shift. Sensor gaps and invalid data clear the nod sequence without changing the reference.

Motion comes from the glasses, not the phone. The detector assumes a gravity-bearing IMU vector and normalizes it to avoid relying on g versus m/s². This is a head-motion break-reminder prototype, not a validated drowsiness detector. Intentional downward nods can trigger it, and drowsiness without head motion will not.

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
