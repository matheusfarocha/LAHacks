import assert from 'node:assert/strict'
import { createSpeedFilter } from './src/speed.ts'
import { HeadNodDetector, toMotionSample } from './src/drowsiness.ts'

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

// Simulated wearer: pitch (chin down +) and roll in degrees, rendered as the
// gravity vector the G2 reports, with optional noise, batching and mounting.
function wearer({ rate = 10, noiseDeg = 0, burst = 1, mount = 0, seed = 7 } = {}) {
  const detector = new HeadNodDetector()
  let now = 1_000_000
  let alerts = 0
  const kinds: string[] = []
  let rng = seed
  let queue: { x: number; y: number; z: number }[] = []
  const random = () => (rng = (rng * 16807) % 2147483647) / 2147483647
  const gauss = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random())
  const step = 1000 / rate
  return {
    detector,
    emit(pitch: number, roll = 0, scale = 1) {
      now += step
      const p = (pitch + mount + gauss() * noiseDeg) * Math.PI / 180
      const r = (roll + gauss() * noiseDeg) * Math.PI / 180
      queue.push({ x: Math.sin(p) * Math.cos(r) * 9.81 * scale, y: Math.sin(r) * 9.81 * scale, z: Math.cos(p) * Math.cos(r) * 9.81 * scale })
      if (queue.length >= burst) {
        for (const sample of queue) {
          const alert = detector.update(sample, now)
          if (alert) { alerts++; kinds.push(alert) }
        }
        queue = []
      }
    },
    hold(pitch: number, ms: number, roll = 0) { for (let t = 0; t < ms; t += step) this.emit(pitch, roll) },
    move(from: number, to: number, ms: number, roll = 0) {
      const n = Math.max(1, Math.round(ms / step))
      for (let i = 1; i <= n; i++) this.emit(from + (to - from) * i / n, roll)
    },
    // Microsleep: still head, slow sag forward, brief hang, snap back awake.
    microsleep(depth = 18, { down = 900, hang = 300, up = 180, base = 0 } = {}) {
      this.hold(base, 2500)
      this.move(base, base + depth, down)
      this.hold(base + depth, hang)
      this.move(base + depth, base, up)
      this.hold(base, 1500)
    },
    gap(ms: number) { now += ms },
    get alerts() { return alerts },
    get kinds() { return kinds },
    get feedback() { return detector.feedback(now) },
    get now() { return now },
  }
}

function settled(options?: Parameters<typeof wearer>[0]) {
  const sim = wearer(options)
  sim.hold(0, 5000)
  assert.equal(sim.feedback.calibrated, true, 'a steady pose is learned automatically')
  return sim
}

// Raw sample decoding: protobuf JSON omits zero-valued axes.
assert.deepEqual(toMotionSample({ x: 0.5, z: 9.8 }), { x: 0.5, y: 0, z: 9.8 })
assert.deepEqual(toMotionSample({ x: '0.5', y: '-1', z: '9.8' }), { x: 0.5, y: -1, z: 9.8 })
assert.equal(toMotionSample({}), null)
assert.equal(toMotionSample({ x: 'abc', y: 1, z: 1 }), null)
assert.equal(toMotionSample(null), null)

// Learning.
const learning = wearer({ noiseDeg: 0.6 })
assert.equal(learning.feedback.calibrated, false)
learning.hold(0, 1200)
assert.ok(learning.feedback.countdownSeconds >= 1 && learning.feedback.progress > 0)
learning.hold(0, 2000)
assert.equal(learning.feedback.calibrated, true, 'noisy but steady pose is learned')
const restless = wearer()
for (let i = 0; i < 20; i++) { restless.hold(15, 300); restless.hold(-5, 300) }
assert.equal(restless.feedback.calibrated, false, 'a moving head is not learned as the pose')

// The core pattern.
const asleep = settled()
asleep.microsleep()
assert.equal(asleep.feedback.nods, 1, 'a droop with a snap back counts')
assert.equal(asleep.feedback.lastEvent?.counted, true)
assert.equal(asleep.alerts, 0, 'one nod alone does not alert')
asleep.microsleep()
assert.equal(asleep.alerts, 1, 'two microsleep nods alert')
assert.deepEqual(asleep.kinds, ['nods'])
assert.equal(asleep.feedback.nods, 0, 'the count restarts after an alert')
asleep.microsleep(); asleep.microsleep()
assert.equal(asleep.alerts, 2, 'a later pair alerts again')

const variants = settled({ noiseDeg: 0.5 })
variants.microsleep(12, { down: 1500, hang: 0, up: 250 })
variants.microsleep(30, { down: 600, hang: 800, up: 200 })
assert.equal(variants.alerts, 1, 'shallow slow droops and deep fast-ish droops both count')

const spaced = settled()
spaced.microsleep(); spaced.hold(0, 65_000); spaced.microsleep()
assert.equal(spaced.alerts, 0, 'nods more than a minute apart do not pair up')

// Things that must not count.
const talking = settled({ noiseDeg: 0.4 })
for (let t = 0; t < 30_000; t += 100) talking.emit(7 * Math.sin(t / 1000 * 2 * Math.PI * 1.5) + 4 * Math.sin(t / 1000 * 2 * Math.PI * 0.4))
assert.equal(talking.alerts, 0, 'talking movement never alerts')
assert.equal(talking.feedback.nods, 0)

const agreeing = settled()
for (let i = 0; i < 6; i++) { agreeing.hold(0, 2500); agreeing.move(0, 15, 200); agreeing.move(15, 0, 200) }
assert.equal(agreeing.feedback.nods, 0, 'quick deliberate nods do not count')
assert.equal(agreeing.alerts, 0)

const glancing = settled()
for (let i = 0; i < 6; i++) { glancing.hold(0, 2500); glancing.move(0, 25, 350); glancing.hold(25, 1200); glancing.move(25, 0, 350) }
assert.equal(glancing.feedback.nods, 0, 'glancing down at the dash does not count')

const lowering = settled()
for (let i = 0; i < 4; i++) { lowering.hold(0, 2500); lowering.move(0, 18, 900); lowering.move(18, 0, 900) }
assert.equal(lowering.feedback.nods, 0, 'a slow look down and slow return has no snap and does not count')
assert.match(lowering.feedback.lastEvent!.reason, /snap/)

const fidgety = settled()
for (let i = 0; i < 4; i++) {
  fidgety.hold(0, 300); fidgety.hold(8, 300); fidgety.hold(-4, 300)
  fidgety.move(0, 18, 900); fidgety.move(18, 0, 180)
}
assert.equal(fidgety.feedback.nods, 0, 'a droop that starts while the head is already moving does not count')

const looking = settled()
for (let i = 0; i < 4; i++) { looking.hold(0, 2500); looking.move(0, -18, 900); looking.move(-18, 0, 180) }
for (let i = 0; i < 4; i++) { looking.hold(0, 2500); looking.move(0, 18, 900, 18); looking.move(18, 0, 180) }
for (let i = 0; i < 4; i++) { looking.hold(0, 2500); for (let t = 0; t < 900; t += 100) looking.emit(0, t / 900 * 20); looking.hold(0, 200) }
assert.equal(looking.alerts, 0, 'upward and sideways movements never count')
assert.equal(looking.feedback.nods, 0)

const bumpy = settled()
for (let i = 0; i < 40; i++) { bumpy.hold(0, 700); bumpy.emit(25, 0, 1.5); bumpy.emit(12, 0, 0.7) }
assert.equal(bumpy.feedback.nods, 0, 'road bumps do not count')
bumpy.hold(0, 2500); bumpy.move(0, 18, 900); bumpy.emit(18, 0, 1.4); bumpy.hold(18, 200); bumpy.move(18, 0, 180)
assert.equal(bumpy.feedback.nods, 0, 'a bump during a droop voids it')

const braking = settled()
braking.hold(0, 2500); braking.detector.noteVehicleAcceleration(-3.5, braking.now)
braking.move(0, 14, 900); braking.move(14, 0, 180); braking.hold(0, 1500)
assert.equal(braking.feedback.nods, 0, 'hard braking tilts gravity like a nod but does not count')
braking.detector.noteVehicleAcceleration(0.5, braking.now)
braking.microsleep(); braking.microsleep()
assert.equal(braking.alerts, 1, 'gentle speed changes do not suppress detection')

// Staying asleep: no snap back ever comes, so a held drop alerts on its own.
const stillAsleep = settled({ noiseDeg: 0.5 })
stillAsleep.hold(0, 2500); stillAsleep.move(0, 30, 1200); stillAsleep.hold(30, 2000)
assert.equal(stillAsleep.alerts, 0, 'no alert before the head has been down three seconds')
assert.ok(stillAsleep.feedback.headDownMs > 2000)
stillAsleep.hold(30, 1500)
assert.deepEqual(stillAsleep.kinds, ['head-down'], 'a head that stays down raises the wake-up alert')
stillAsleep.detector.reset() // Dismissed, but still asleep.
stillAsleep.hold(30, 3200)
assert.deepEqual(stillAsleep.kinds, ['head-down', 'head-down'], 'still down after dismissal alerts again')

const nodThenOut = settled()
nodThenOut.microsleep()
nodThenOut.hold(0, 2500); nodThenOut.move(0, 25, 1500); nodThenOut.hold(25, 3500)
assert.deepEqual(nodThenOut.kinds, ['head-down'], 'a nod followed by falling fully asleep alerts without a second snap')

const asleepOnBumps = settled()
asleepOnBumps.hold(0, 2500); asleepOnBumps.move(0, 28, 1000)
for (let i = 0; i < 5; i++) { asleepOnBumps.hold(28, 800); asleepOnBumps.emit(28, 0, 1.4); asleepOnBumps.hold(8, 200) }
assert.deepEqual(asleepOnBumps.kinds, ['head-down'], 'a bouncing head on a rough road is still caught')

const reading = settled()
for (let i = 0; i < 5; i++) { reading.hold(0, 3000); reading.move(0, 30, 300); reading.hold(30, 2000); reading.move(30, 0, 300) }
assert.equal(reading.alerts, 0, 'glances down of a couple of seconds do not alert')

const slumped = settled()
slumped.hold(0, 2500); slumped.move(0, 12, 2000); slumped.hold(12, 9000)
assert.equal(slumped.alerts, 0, 'a modestly lowered posture is not a head-down alert')
assert.equal(slumped.feedback.poseJustReset || slumped.feedback.angle! < 3, true, 'it becomes the new reference')
slumped.microsleep(15, { base: 12 }); slumped.microsleep(15, { base: 12 })
assert.deepEqual(slumped.kinds, ['nods'], 'after adopting the lowered posture, nods from it are detected')

const reclined = settled()
reclined.move(0, -12, 2000); reclined.hold(-12, 6000)
assert.equal(reclined.feedback.poseJustReset, true, 'a new steady posture is adopted')
reclined.microsleep(18, { base: -12 }); reclined.microsleep(18, { base: -12 })
assert.equal(reclined.alerts, 1)

const incline = settled()
for (let t = 0; t < 60_000; t += 100) incline.emit(t / 60_000 * 8)
assert.equal(incline.feedback.nods, 0, 'a gradual change in head angle is not a nod')
incline.microsleep(18, { base: 8 }); incline.microsleep(18, { base: 8 })
assert.equal(incline.alerts, 1)

// Sensor noise, delivery quirks, and mounting.
const longDrive = settled({ noiseDeg: 0.8, seed: 99 })
for (let minute = 0; minute < 10; minute++) {
  for (let t = 0; t < 50_000; t += 100) longDrive.emit(2 * Math.sin(t / 7000) + (t % 9000 < 100 ? 25 : 0))
  longDrive.hold(0, 2000); longDrive.move(0, 20, 300); longDrive.hold(20, 1000); longDrive.move(20, 0, 300)
  for (let t = 0; t < 6000; t += 100) longDrive.emit(6 * Math.sin(t / 1000 * 2 * Math.PI * 2))
}
assert.equal(longDrive.alerts, 0, 'ten noisy minutes of normal driving raise no alert')
longDrive.microsleep(); longDrive.microsleep()
assert.equal(longDrive.alerts, 1, 'microsleep nods are still caught through the noise')

for (const [rate, burst] of [[5, 1], [20, 1], [20, 5], [10, 10], [50, 4]]) {
  const delivery = settled({ rate, burst, noiseDeg: 0.4 })
  delivery.microsleep(); delivery.microsleep()
  assert.equal(delivery.alerts, 1, `detects at ${rate} Hz delivered ${burst} at a time`)
}
const samestamp = new HeadNodDetector()
for (let i = 0; i < 400; i++) samestamp.update({ x: 0, y: 0, z: 9.81 }, 5000 + Math.floor(i / 4) * 100)
assert.equal(samestamp.feedback().calibrated, true, 'samples sharing a timestamp do not reset learning')

const mounted = settled({ mount: 20 })
mounted.microsleep(); mounted.microsleep()
assert.equal(mounted.alerts, 1, 'how the glasses sit on the face does not matter')

const glitchy = settled()
glitchy.microsleep()
glitchy.detector.update(null, glitchy.now + 50)
glitchy.microsleep()
assert.equal(glitchy.alerts, 1, 'an isolated unreadable sample does not erase counted nods')
const dead = settled()
for (let i = 0; i < 10; i++) dead.detector.update({ x: 0, y: 0, z: 0 }, dead.now + i)
assert.equal(dead.feedback.signalValid, false, 'a stream of zero vectors is flagged')

const dropout = settled()
dropout.hold(0, 2500); dropout.move(0, 18, 600); dropout.gap(3000); dropout.hold(18, 300); dropout.move(18, 0, 180)
assert.equal(dropout.feedback.nods, 0, 'a droop split by a sensor gap does not count')
dropout.hold(0, 2000); dropout.microsleep(); dropout.gap(40_000); dropout.hold(0, 3000); dropout.microsleep()
assert.equal(dropout.alerts, 0, 'a long sensor outage forgets earlier nods')

// Device axis: a wrong sign is fixable by teaching the direction.
const flipped = settled()
flipped.detector.setPitchAxis({ x: 0, y: -1, z: 0 })
flipped.microsleep(); flipped.microsleep()
assert.equal(flipped.alerts, 0, 'with the wrong axis sign, nods read as looking up')
assert.equal(flipped.detector.teachDownDirection(), true)
assert.equal(flipped.feedback.phase, 'teaching')
flipped.hold(0, 500); flipped.move(0, 25, 600); flipped.hold(25, 1500); flipped.move(25, 0, 600)
assert.notEqual(flipped.feedback.phase, 'teaching')
const taught = flipped.detector.takeLearnedAxis()
assert.ok(taught && taught.y > 0.99, 'teaching recovers the correct axis')
assert.equal(flipped.detector.takeLearnedAxis(), null)
flipped.microsleep(); flipped.microsleep()
assert.equal(flipped.alerts, 1, 'nods are detected after teaching')

const relearned = settled()
relearned.microsleep()
relearned.detector.relearn()
assert.equal(relearned.feedback.calibrated, false)
relearned.hold(0, 3500); relearned.microsleep()
assert.equal(relearned.alerts, 0, 'relearning the pose clears counted nods')

console.log('Microsleep nods, staying-asleep head-down alert, talking/glance/bump/braking rejection, noise, batching, posture and axis teaching passed.')
