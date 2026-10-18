import assert from 'node:assert/strict'
import { createSpeedFilter } from './src/speed.ts'
import { HeadNodDetector, averageMotion } from './src/drowsiness.ts'

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

assert.equal(averageMotion([]), null)
assert.equal(averageMotion(Array(5).fill({ x: NaN, y: 0, z: 0 })), null)
assert.deepEqual(averageMotion(Array(5).fill({ x: 1, y: 2, z: 3 })), { x: 1, y: 2, z: 3 })
const neutral = { x: 0, y: 0, z: 0 }
const down = { x: 0, y: 10, z: 0 }

function motionFixture() {
  const detector = new HeadNodDetector()
  assert.equal(detector.calibrate(neutral, down), true)
  let now = 0
  let alerts = 0
  return {
    detector,
    feed(y: number, duration: number, x = 0, enabled = true) {
      for (let elapsed = 0; elapsed < duration; elapsed += 100) {
        now += 100
        if (detector.update({ x, y, z: 0 }, now, enabled)) alerts++
      }
    },
    nod() { this.feed(10, 600); this.feed(0, 300) },
    gap() { now += 2000 },
    get alerts() { return alerts },
  }
}

const repeated = motionFixture()
repeated.feed(10, 600) // Ending calibration head-down must not count as a nod.
repeated.feed(0, 300)
repeated.nod()
assert.equal(repeated.alerts, 0)
repeated.nod()
assert.equal(repeated.alerts, 1)
repeated.nod(); repeated.nod()
assert.equal(repeated.alerts, 1, 'cooldown suppresses repeated alerts')
repeated.feed(0, 31000)
repeated.nod(); repeated.nod()
assert.equal(repeated.alerts, 2, 'detection resumes after cooldown')

const jitter = motionFixture()
jitter.feed(0, 200)
for (let i = 0; i < 10; i++) { jitter.feed(10, 100); jitter.feed(0, 100) }
assert.equal(jitter.alerts, 0, 'brief bumps are rejected')
jitter.feed(10, 3000); jitter.feed(0, 300)
assert.equal(jitter.alerts, 0, 'a prolonged look down is rejected')
jitter.feed(10, 600, 20); jitter.feed(0, 300)
jitter.feed(10, 600, 20); jitter.feed(0, 300)
assert.equal(jitter.alerts, 0, 'sideways movement is rejected')

const interrupted = motionFixture()
interrupted.feed(0, 200); interrupted.nod(); interrupted.gap()
interrupted.feed(0, 200); interrupted.nod()
assert.equal(interrupted.alerts, 0, 'sensor gaps clear the prior nod')
interrupted.feed(0, 100, 0, false)
interrupted.feed(0, 200); interrupted.nod()
assert.equal(interrupted.alerts, 0, 'disabled monitoring clears the prior nod')
interrupted.feed(NaN, 100)
interrupted.feed(0, 200); interrupted.nod()
assert.equal(interrupted.alerts, 0, 'invalid samples clear the prior nod')

const expired = motionFixture()
expired.feed(0, 200); expired.nod(); expired.feed(0, 9000); expired.nod()
assert.equal(expired.alerts, 0, 'isolated nods outside the window do not alert')
assert.equal(expired.detector.calibrate(neutral, neutral), false)
assert.equal(expired.detector.update(down, 20000, true), false, 'bad calibration disables detection')
console.log('Head-nod calibration, repeated nods, cooldown, jitter, sideways motion, stale data, invalid data, and isolated nods passed.')
