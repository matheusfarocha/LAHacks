import assert from 'node:assert/strict'
import { createSpeedFilter } from './src/speed.ts'
import { HeadNodDetector } from './src/drowsiness.ts'

const filter = createSpeedFilter()
assert.equal(filter(null, 0), null)
assert.equal(filter(0, 0), 0)
assert.equal(filter(10, 3000), 8.94776)
const beforeSpike = filter(10, 6000)!
assert.equal(filter(100, 6100), beforeSpike)
assert.equal(filter(Number.NaN, 7000), null)
assert.equal(filter(-1, 8000), null)
assert.ok(Math.abs(filter(10, 9000)! - 22.3694) < 1e-9)
assert.equal(filter(null, 10000), null)
assert.equal(filter(0, 11000), 0)
assert.equal(filter(Infinity, 12000), null)
const steady = createSpeedFilter()
assert.ok(Math.abs(steady(26.8224, 0)! - 60) < 0.001)
assert.ok(Math.abs(steady(26.8224, 1000)! - 60) < 0.001)
assert.equal(steady(null, 11000), null)
assert.equal(steady(0, 12000), 0)
const accelerating = createSpeedFilter()
assert.equal(accelerating(0, 0), 0)
assert.equal(accelerating(20, 1000), 0)
assert.ok(accelerating(20, 3000)! > 0)
console.log('Speed conversion, smoothing, spike rejection, and invalid readings passed.')

function motionFixture(learn = true, baseAngle = 0) {
  const detector = new HeadNodDetector()
  let now = 0
  let alerts = 0
  const fixture = {
    detector,
    feed(degrees: number, duration: number, axis = 'x', scale = 1, enabled = true) {
      const radians = (degrees + baseAngle) * Math.PI / 180
      const sample = axis === 'x'
        ? { x: Math.sin(radians) * 9.81 * scale, y: 0, z: Math.cos(radians) * 9.81 * scale }
        : { x: 0, y: Math.sin(radians) * 9.81 * scale, z: Math.cos(radians) * 9.81 * scale }
      for (let elapsed = 0; elapsed < duration; elapsed += 100) {
        now += 100
        if (detector.update(sample, now, enabled)) alerts++
      }
    },
    nod() { this.feed(12, 300); this.feed(0, 1100) },
    gap() { now += 4000 },
    get alerts() { return alerts },
    get feedback() { return detector.feedback(now) },
    get now() { return now },
  }
  if (learn) {
    fixture.feed(0, 3200)
    assert.equal(fixture.feedback.calibrated, true, 'steady pose is learned automatically')
  }
  return fixture
}

const learning = motionFixture(false)
assert.equal(learning.feedback.countdownSeconds, 3)
learning.feed(0, 1100)
assert.equal(learning.feedback.countdownSeconds, 2)
learning.feed(0, 1000)
assert.equal(learning.feedback.countdownSeconds, 1)
learning.detector.relearn()
assert.equal(learning.feedback.countdownSeconds, 3)
learning.feed(0, 1500)
assert.equal(learning.feedback.calibrated, false)
assert.ok(learning.feedback.progress > 0)
for (let i = 0; i < 20; i++) { learning.feed(12, 100); learning.feed(0, 100) }
assert.equal(learning.feedback.calibrated, false, 'movement prevents learning an unstable pose')
assert.equal(learning.feedback.countdownSeconds, 3, 'movement resets the pose countdown')
assert.equal(learning.alerts, 0)
learning.feed(0, 3200)
assert.equal(learning.feedback.calibrated, true)
assert.equal(learning.feedback.countdownSeconds, 0, 'pose establishment completes the countdown')
learning.nod(); learning.nod()
assert.equal(learning.alerts, 1, 'no manual capture is required')

const repeated = motionFixture()
repeated.nod()
assert.equal(repeated.alerts, 0)
assert.equal(repeated.feedback.nods, 1)
repeated.nod()
assert.equal(repeated.alerts, 1)
repeated.detector.reset() // Dismiss the warning; only the per-nod cooldown remains.
repeated.feed(0, 100)
repeated.nod(); repeated.nod()
assert.equal(repeated.alerts, 2, 'a new pair can alert without a 30-second lockout')

const rapid = motionFixture()
rapid.feed(12, 300); rapid.feed(0, 100)
assert.equal(rapid.feedback.nods, 1)
assert.equal(rapid.feedback.nodCooldownMs, 750)
rapid.feed(12, 300); rapid.feed(0, 100)
assert.equal(rapid.feedback.nods, 1, 'rapid duplicate bobs are ignored during the nod cooldown')
assert.equal(rapid.alerts, 0)
rapid.feed(12, 1500)
assert.equal(rapid.feedback.nods, 1, 'a bob begun during cooldown cannot count when the timer expires')
rapid.feed(0, 100)
rapid.feed(12, 300); rapid.feed(0, 100)
assert.equal(rapid.alerts, 1, 'a new complete nod after cooldown triggers the second count')

const jitter = motionFixture()
for (let i = 0; i < 10; i++) { jitter.feed(12, 100); jitter.feed(0, 100) }
assert.equal(jitter.alerts, 0, 'brief bumps are rejected')
jitter.feed(12, 600, 'x', 2); jitter.feed(0, 300)
assert.equal(jitter.alerts, 0, 'large acceleration is rejected')
const mixed = motionFixture()
mixed.nod(); mixed.feed(12, 200, 'y'); mixed.feed(0, 300)
assert.equal(mixed.alerts, 0, 'sideways movement never supplies the second nod')

const interrupted = motionFixture()
interrupted.nod(); interrupted.gap()
interrupted.feed(0, 200); interrupted.nod()
assert.equal(interrupted.alerts, 0, 'sensor gaps clear the prior nod')
assert.equal(interrupted.feedback.calibrated, true, 'short sensor gaps preserve the learned pose')
interrupted.feed(0, 100, 'x', 1, false)
interrupted.feed(0, 200); interrupted.nod()
assert.equal(interrupted.alerts, 0, 'disabled monitoring clears the prior nod')
interrupted.feed(NaN, 100)
interrupted.feed(0, 200); interrupted.nod()
assert.equal(interrupted.alerts, 0, 'invalid samples clear the prior nod')

const expired = motionFixture()
expired.nod(); expired.feed(0, 9000); expired.nod()
assert.equal(expired.alerts, 0, 'isolated nods outside the window do not alert')
expired.detector.relearn()
assert.equal(expired.feedback.calibrated, false)
expired.nod(); expired.nod()
assert.equal(expired.alerts, 0, 'relearning pauses detection until a new steady pose exists')

const slumped = motionFixture()
slumped.feed(16, 15000)
assert.equal(slumped.alerts, 0, 'holding beyond the tilt threshold no longer triggers an instant alert')
assert.ok(Math.abs(slumped.feedback.angle!) < 0.1, 'a posture held for eight seconds becomes the new reference')
slumped.feed(28, 300); slumped.feed(16, 1100)
slumped.feed(28, 300); slumped.feed(16, 1100)
assert.equal(slumped.alerts, 1)

const changedPosture = motionFixture()
changedPosture.feed(-15, 4000)
assert.equal(changedPosture.feedback.settled, false)
assert.ok(changedPosture.feedback.postureCountdownSeconds! > 0)
assert.ok(changedPosture.feedback.angle! < -10, 'reference does not reset prematurely')
changedPosture.feed(-15, 4200)
assert.equal(changedPosture.feedback.poseJustReset, true)
assert.equal(changedPosture.feedback.settled, true)
assert.ok(Math.abs(changedPosture.feedback.angle!) < 0.1)
assert.equal(changedPosture.alerts, 0, 'resetting posture never counts as a nod')
changedPosture.feed(-3, 300); changedPosture.feed(-15, 1100)
changedPosture.feed(-3, 300); changedPosture.feed(-15, 1100)
assert.equal(changedPosture.alerts, 1, 'downward nods work from the newly learned posture')

const changingPose = motionFixture()
for (let i = 0; i < 30; i++) changingPose.feed(i % 2 ? -15 : -30, 300)
assert.equal(changingPose.feedback.poseJustReset, false, 'continually changing positions cannot establish a reference')
changingPose.feed(-15, 4000); changingPose.gap(); changingPose.feed(-15, 4100)
assert.equal(changingPose.feedback.poseJustReset, false, 'sensor gaps cannot finish a posture reset')
changingPose.feed(-15, 4200)
assert.equal(changingPose.feedback.poseJustReset, true)

const mounted = motionFixture(true, 20)
mounted.nod(); mounted.nod()
assert.equal(mounted.alerts, 1, 'initial mounting angle is removed by the automatic baseline')

const zero = motionFixture(false)
zero.feed(0, 10000, 'x', 0)
assert.equal(zero.feedback.calibrated, false)
assert.equal(zero.feedback.signalValid, false, 'zero vectors cannot arm monitoring')
const scaled = motionFixture(false)
scaled.feed(0, 3200, 'x', 1 / 9.81)
assert.equal(scaled.feedback.calibrated, true, 'gravity units need not be m/s²')
scaled.feed(12, 200, 'x', 1 / 9.81); scaled.feed(0, 1100, 'x', 1 / 9.81)
scaled.feed(12, 200, 'x', 1 / 9.81); scaled.feed(0, 1100, 'x', 1 / 9.81)
assert.equal(scaled.alerts, 1)
const upward = motionFixture()
for (let i = 0; i < 4; i++) { upward.feed(-16, 400); upward.feed(0, 1100) }
assert.equal(upward.alerts, 0, 'looking upward repeatedly never triggers')
assert.equal(upward.feedback.nods, 0, 'upward looks do not count as nods')
for (const side of [-1, 1]) {
  const sideways = motionFixture()
  for (let i = 0; i < 4; i++) { sideways.feed(side * 16, 400, 'y'); sideways.feed(0, 1100) }
  assert.equal(sideways.alerts, 0, 'left/right tilt never triggers')
  assert.equal(sideways.feedback.nods, 0)
  sideways.feed(0, 10000) // A pure yaw turn leaves gravity unchanged.
  assert.equal(sideways.alerts, 0)
}
const interruptedDip = motionFixture()
interruptedDip.feed(12, 300); interruptedDip.feed(-12, 300); interruptedDip.feed(0, 1200)
assert.equal(interruptedDip.feedback.nods, 0, 'an upward excursion cannot complete a pending down-nod')

const relaxed = motionFixture(false)
for (let i = 0; i < 32; i++) relaxed.feed(i % 2 ? 3 : -3, 100)
assert.equal(relaxed.feedback.calibrated, true, 'natural three-degree movements do not restart pose learning')
assert.equal(relaxed.feedback.countdownSeconds, 0)
const littleBump = motionFixture(false)
littleBump.feed(0, 2000); littleBump.feed(6, 200); littleBump.feed(0, 1000)
assert.equal(littleBump.feedback.calibrated, true, 'a small brief adjustment does not restart the countdown')

const downhill = motionFixture()
for (let i = 1; i <= 800; i++) downhill.feed(i * 0.02, 100) // 0.2°/s gradual change.
assert.equal(downhill.alerts, 0, 'gradual downhill motion does not count as nodding')
assert.ok(Math.abs(downhill.feedback.angle!) < 3, 'the reference follows gradual downhill pitch')
const beforeBob = downhill.feedback.angle!
downhill.feed(28, 300)
assert.ok(downhill.feedback.angle! > beforeBob + 10, 'a fast head bob is not absorbed by reference tracking')
downhill.feed(16, 1100)
downhill.feed(28, 300); downhill.feed(16, 1100)
assert.equal(downhill.alerts, 1, 'two down-nods still trigger on an adapted incline')

const uphill = motionFixture()
for (let i = 1; i <= 800; i++) uphill.feed(-i * 0.02, 100)
assert.equal(uphill.alerts, 0, 'gradual uphill motion does not count as nodding')
assert.ok(Math.abs(uphill.feedback.angle!) < 3, 'the reference follows gradual uphill pitch too')
uphill.feed(-4, 300); uphill.feed(-16, 1100)
uphill.feed(-4, 300); uphill.feed(-16, 1100)
assert.equal(uphill.alerts, 1, 'downward nods remain detectable after uphill adaptation')

const configured = motionFixture()
assert.equal(configured.detector.setDownAxis({ x: 0, y: 0, z: 0 }), false)
assert.equal(configured.detector.setDownAxis({ x: 0, y: -1, z: 0 }), true)
configured.feed(0, 100)
configured.feed(12, 300); configured.feed(0, 1100)
assert.equal(configured.feedback.nods, 0, 'a device-specific sign mapping rejects its opposite direction')
configured.feed(-12, 300); configured.feed(0, 1100)
configured.feed(-12, 300); configured.feed(0, 1100)
assert.equal(configured.alerts, 1)
console.log('Downward pitch, up/left/right rejection, automatic pose learning, 750ms nod cooldown, gradual incline tracking, and bob preservation passed.')
