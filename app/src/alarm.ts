// Wake-up alarm played through the phone (the G2 has no speaker).
// Two-tone beeping that ramps from soft to full volume, plus vibration.

let ctx: AudioContext | null = null
let gain: GainNode | null = null
let timer: number | undefined
let high = true

function audio(): AudioContext {
  if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
  return ctx
}

// Browsers block sound until the user taps something; unlock on any interaction.
function unlock() { audio().resume().catch(() => {}) }
window.addEventListener('pointerdown', unlock)
window.addEventListener('keydown', unlock)

function beep(freq: number, ms: number) {
  if (!gain) return
  const ac = audio()
  const osc = ac.createOscillator()
  osc.type = 'square'
  osc.frequency.value = freq
  osc.connect(gain)
  osc.start()
  osc.stop(ac.currentTime + ms / 1000)
}

export function startAlarm() {
  if (timer !== undefined) return
  const ac = audio()
  ac.resume().catch(() => {})
  gain = ac.createGain()
  gain.connect(ac.destination)
  // Start softer and ramp to full volume over 8 seconds to avoid a sudden startle.
  gain.gain.setValueAtTime(0.25, ac.currentTime)
  gain.gain.linearRampToValueAtTime(1, ac.currentTime + 8)
  high = true
  timer = window.setInterval(() => {
    beep(high ? 1000 : 700, 250)
    high = !high
  }, 300)
  navigator.vibrate?.([400, 200, 400, 200, 400])
}

export function stopAlarm() {
  if (timer === undefined) return
  clearInterval(timer)
  timer = undefined
  gain?.disconnect()
  gain = null
  navigator.vibrate?.(0)
}
