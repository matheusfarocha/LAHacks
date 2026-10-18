// Draws the "dash panel" bitmap: current speed on top, a circular speed-limit
// sign in the middle (mimicking a UK repeater sign — thick ring, bold number),
// and heading/camera warning on the bottom row. Encoded as a real PNG via
// canvas.toBlob() — updateImageRawData expects encoded image bytes (PNG/JPEG),
// not raw per-pixel luminance (confirmed against even-realities/
// evenhub-templates' official image scaffold; see even.ts's pushPanel doc
// comment for the imageException this was producing before the fix).
import { PANEL_W, PANEL_H } from './even'
import type { DrivingState } from './speed'

const canvas = document.createElement('canvas')
canvas.width = PANEL_W
canvas.height = PANEL_H
const ctx = canvas.getContext('2d')!

// A humanist sans-serif instead of monospace is most of "less robotic" on
// its own — monospace reads as a terminal/calculator. Matches the family
// Even Realities' own toolkit uses for its UI (FK Grotesk, a licensed
// commercial font we can't bundle) via the closest freely-available
// system-font stack.
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

// Top band now stacks two lines (big number + small "MPH" label, matching
// the reference HUD style) — needs real room, not the old single-line
// budget, otherwise the label bleeds into the ring below it (confirmed by
// an actual render: this exact overlap happened at TOP_H=24). Kept tight
// (not padded further) so the ring below gets as much of the 100px budget
// as possible — a cropped real render showed the whole cluster looking
// small/centered with dead space around it when the bands were generous;
// growing the ring is what actually fills the canvas, not adding more gap.
const TOP_H = 26
const BOTTOM_H = 16
// Double ring (thin outer accent + thick main ring, like a real road sign's
// coloured border) reads as more deliberately designed than a single flat
// stroke — and does it without any blur, which at this resolution (a 100px-
// tall bitmap, quantized to 4-bit on the real display) smears text into an
// illegible blob rather than glowing, confirmed by an actual render.
const OUTER_RING_W = 2
const RING_GAP = 1
const INNER_RING_W = 5
const CIRCLE_D = PANEL_H - TOP_H - BOTTOM_H
const CIRCLE_R = CIRCLE_D / 2
const CIRCLE_CX = PANEL_W / 2
const CIRCLE_CY = TOP_H + CIRCLE_R

export async function renderDashPanelPng(d: DrivingState): Promise<Uint8Array> {
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, PANEL_W, PANEL_H)
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // Pinned near the top edge (not centered in its band) so it reads as
  // clearly separate from the circle below, not stacked on top of it.
  ctx.font = `700 15px ${FONT_STACK}`
  const speedText = d.speedMph != null ? `${Math.round(d.speedMph)}` : '…'
  ctx.fillText(speedText, PANEL_W / 2, 7)
  ctx.font = `600 8px ${FONT_STACK}`
  ctx.fillText('MPH', PANEL_W / 2, 19)

  ctx.strokeStyle = '#fff'
  ctx.beginPath()
  ctx.arc(CIRCLE_CX, CIRCLE_CY, CIRCLE_R - OUTER_RING_W / 2, 0, Math.PI * 2)
  ctx.lineWidth = OUTER_RING_W
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(CIRCLE_CX, CIRCLE_CY, CIRCLE_R - OUTER_RING_W - RING_GAP - INNER_RING_W / 2, 0, Math.PI * 2)
  ctx.lineWidth = INNER_RING_W
  ctx.stroke()

  const limitText = d.limitMph != null ? String(d.limitMph) : (d.limitSource === 'pending' ? '…' : '?')
  ctx.font = `800 28px ${FONT_STACK}`
  ctx.fillText(limitText, CIRCLE_CX, CIRCLE_CY + 1)

  // Camera warning takes priority over heading on the bottom row — it's the
  // safety-critical one, and the two never both matter at the same instant.
  // Pinned near the bottom edge for the same separation-from-circle reason
  // as the speed text above.
  ctx.font = `600 11px ${FONT_STACK}`
  const bottomText = d.cameraDistanceM != null ? `⚠ ${d.cameraDistanceM}m` : (d.heading || '')
  if (bottomText) ctx.fillText(bottomText, PANEL_W / 2, PANEL_H - 7)

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}
