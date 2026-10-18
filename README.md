# Glass Car Dash

A live MPH speed display for Even Realities G2, retaining the segmented curves from the Silverline Normal Drive design.

The speed number, MPH label, and surrounding arcs normally appear on the glasses. The Even app supplies GPS speed from the phone; the app converts it to MPH and smooths noisy readings. A dash appears until a valid reading arrives, when the phone reports invalid speed, or after ten seconds without a GPS update. Double-tap the glasses to exit and stop location tracking.

In a regular browser, the preview uses clearly labeled simulated speed. Open the app through the Even app's Prototype Mode QR scanner for real GPS readings. Allow the Even app to use precise location and keep it open during local testing. GPS updates are requested once per second; actual cadence depends on the phone and GPS reception.

## Head-nod alert

Open the app using the Even app's Prototype Mode QR scanner and keep the phone app open. The reference head pose is learned automatically once the head is held naturally still for about 2.5 seconds. Pose learning, the live pitch angle, nod count, and why the last droop did or did not count are shown on the phone only. The glasses show the speed gauge or the break alert.

A counted nod has the shape of a microsleep: the head is still for 1.5 seconds, sags forward at least 10°, then snaps back up noticeably faster than it went down (the wake-up jerk). Two counted nods within 60 seconds trigger **TAKE A BREAK**. The rest is rejected:

- **Talking or looking around**: the droop must start from a still head.
- **Deliberate nods and glances at the dash**: these go down and come back at about the same speed, or drop too fast.
- **Looking up or tipping the head sideways**: only downward pitch counts.
- **Road bumps**: single-sample spikes are filtered out, and a jump in measured gravity voids any droop in progress.
- **Hard braking or acceleration**: these tilt the gravity reading like a nod, so phone GPS acceleration above 1.5 m/s² pauses counting for 2.5 seconds.
- **Changing posture**: a new pose within 15° of the reference held steady for 5 seconds becomes the reference, and the reference follows slow drift.

A driver who stays asleep never snaps back, so this is a separate trigger. If the head stays 15° or more below the reference for 3 seconds, the glasses show **WAKE UP** immediately, even if no nod was counted. A bump that briefly lifts a hanging head doesn't restart the timer. The warning stays until the glasses are tapped, which a sleeper can't do. If the head is still down after dismissal, it alerts again 3 seconds later. Glances down that last a couple of seconds don't trigger it, but anything longer will, asleep or not.

Readings are low-pass filtered, samples a phone delivers in bursts with one timestamp are spaced out, axes the phone omits because they are exactly zero are read as 0, and one unreadable sample does not erase counted nods.

The signed device axis defaults to `G2_PITCH_AXIS` in `app/src/drowsiness.ts`. If looking down shows a negative pitch on the phone, press **Teach nod direction**, look down and hold for a second; the corrected axis is saved on the phone. The phone also shows the sensor rate and raw readings for checking the signal on new hardware.

Tap the glasses or press **Dismiss alert** to return to current speed. **Preview alert** works in the browser too, where speed and the steady pose-learning signal are clearly labeled simulations. **Relearn driving pose** is optional if the glasses shift.

Motion comes from the glasses, not the phone. The detector assumes a gravity-bearing IMU vector and normalizes it to avoid relying on g versus m/s². This is a head-motion break-reminder prototype, not a validated drowsiness detector. A convincing fake nod can trigger it, and drowsiness without head motion will not.

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
