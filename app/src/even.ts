// Runtime wrapper around @evenrealities/even_hub_sdk. Header/footer/body are
// text containers; the body shares its row with a bitmap "dash panel" image
// container (speed-limit sign) on the right.
//
// The phone-side WebView always shows a live preview of the same content
// (plus buttons that fire the same input handler as real glasses gestures)
// — this isn't just a browser-dev convenience, it's the permanent phone-side
// UI, since the phone screen would otherwise just sit on index.html's static
// placeholder the whole time the app runs. `real` distinguishes where the
// DATA comes from, not whether the preview renders:
//   - REAL: inside the Even app WebView -> also drives the actual glasses.
//   - MIRROR: no native bridge (plain browser, or bridge connect failed) ->
//     preview only, and startLocationUpdates/onBattery synthesize fake data
//     so the whole pipeline is exercisable without hardware.
//
// Real-vs-mirror detection: waitForEvenAppBridge() resolves a JS-side bridge
// object almost immediately even with no native host listening, so it's not
// a reliable signal on its own — every subsequent bridge call would then
// just silently warn "Flutter handler not available" and no-op instead of
// throwing, leaving the mirror fallback never triggered. Check the actual
// native primitive directly first (see connect()).
import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  ImageContainerProperty,
  ImageRawDataUpdate,
  OsEventTypeList,
  AppLocationAccuracy,
  DeviceConnectType,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

export type Input = 'click' | 'up' | 'down' | 'double' | 'foreground'

export interface RawLocation {
  lat: number
  lon: number
  speedMps: number | null
  headingDeg: number | null
}

const W = 576
const H = 288
const HEADER_H = 40
const FOOTER_H = 40
const BODY_Y = HEADER_H
const BODY_H = H - HEADER_H - FOOTER_H
const SCROLL_THROTTLE_MS = 300

// Body splits into a bordered text panel (left, media status — the border's
// right edge is what reads as "separated by a border" since
// ImageContainerProperty has no border property of its own to give the
// image panel one directly) and a bitmap image panel (right, the dash/sign
// display). This package's own .d.ts claims 20-288 x 20-144, but that's
// wrong for what real hardware actually accepts: even-realities/
// evenhub-templates' official "image" scaffold uses 200x100 and its
// renderer.ts states the real limits are width 20-200, height 20-100 —
// confirmed by a from-scratch imageException on a 180x140 panel.
export const PANEL_W = 200
export const PANEL_H = 100
const LEFT_W = W - PANEL_W - 28 // 28px margin between the two panels + right edge
const PANEL_X = W - PANEL_W - 20
const PANEL_Y = BODY_Y + (BODY_H - PANEL_H) / 2
const PANEL_ID = 4
const PANEL_NAME = 'dash'

function headerC(content: string) {
  return new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: W, height: HEADER_H,
    borderWidth: 1, borderColor: 10, borderRadius: 0, paddingLength: 6,
    containerID: 3, containerName: 'header', content, isEventCapture: 0,
  })
}
function bodyC(content: string) {
  return new TextContainerProperty({
    xPosition: 0, yPosition: BODY_Y, width: LEFT_W, height: BODY_H,
    borderWidth: 1, borderColor: 8, borderRadius: 0, paddingLength: 8,
    containerID: 1, containerName: 'body', content, isEventCapture: 1,
  })
}
function footerC(content: string) {
  return new TextContainerProperty({
    xPosition: 0, yPosition: BODY_Y + BODY_H, width: W, height: FOOTER_H,
    borderWidth: 1, borderColor: 6, borderRadius: 0, paddingLength: 6,
    containerID: 2, containerName: 'footer', content, isEventCapture: 0,
  })
}
function panelC() {
  return new ImageContainerProperty({
    xPosition: PANEL_X, yPosition: PANEL_Y, width: PANEL_W, height: PANEL_H,
    containerID: PANEL_ID, containerName: PANEL_NAME,
  })
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bridge timeout')), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) }
    )
  })
}

export class Runtime {
  real = false
  private bridge: EvenAppBridge | null = null
  private started = false
  private last = { h: '', b: '', f: '' }
  private handler: (i: Input) => void = () => {}
  private lastScroll = 0
  private lastInput = { type: '', at: 0 }
  private previewEls: { header: HTMLElement; body: HTMLElement; footer: HTMLElement } | null = null
  private previewPanelCtx: CanvasRenderingContext2D | null = null
  private lastDeviceStatus: any = null
  private batteryHandler: ((levelPct: number | null, charging: boolean) => void) | null = null

  async connect(): Promise<void> {
    this.setupPreview()
    const hasFlutterHost = typeof (window as any).flutter_inappwebview?.callHandler === 'function'
    if (!hasFlutterHost) {
      this.real = false
      return
    }
    try {
      this.bridge = await withTimeout(waitForEvenAppBridge(), 2500)
      this.real = true
      void (this.bridge as any).connect?.().catch(() => {})
      this.bridge.onEvenHubEvent((e: any) => this.onEvent(e))
      // Registered here, immediately on bridge availability, not later from
      // onBattery() — onLaunchSource is documented as a one-shot push right
      // after load, and device status looks to follow the same shape; a
      // listener attached after other startup awaits (network calls,
      // location setup) risks missing the one moment it reports
      // Connected + a real batteryLevel, leaving every later read stuck on
      // whatever placeholder value it fired before that.
      this.bridge.onDeviceStatusChanged((status: any) => this.handleDeviceStatus(status))
    } catch {
      this.real = false
    }
  }

  onInput(handler: (i: Input) => void) {
    this.handler = handler
  }

  async render(header: string, body: string, footer: string): Promise<void> {
    this.paintPreview(header, body, footer)
    if (!this.real || !this.bridge) return

    if (!this.started) {
      await this.bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          containerTotalNum: 4,
          textObject: [headerC(header), bodyC(body), footerC(footer)],
          imageObject: [panelC()],
        })
      )
      this.started = true
      this.last = { h: header, b: body, f: footer }
      return
    }

    let ok = true
    if (header !== this.last.h) ok = (await this.upgrade(3, 'header', header)) && ok
    if (body !== this.last.b) ok = (await this.upgrade(1, 'body', body)) && ok
    if (footer !== this.last.f) ok = (await this.upgrade(2, 'footer', footer)) && ok

    if (ok) {
      this.last = { h: header, b: body, f: footer }
    } else {
      await this.bridge.rebuildPageContainer(
        new RebuildPageContainer({
          containerTotalNum: 4,
          textObject: [headerC(header), bodyC(body), footerC(footer)],
          imageObject: [panelC()],
        })
      )
      this.last = { h: header, b: body, f: footer }
    }
  }

  // Pushes a fresh bitmap into the dash panel (right side). `pngBytes` must
  // be an *encoded* PNG file's bytes, not raw per-pixel luminance —
  // updateImageRawData decodes and 4-bit-greyscale-converts internally (see
  // even-realities/evenhub-templates' image/src/image/renderer.ts). Sending
  // flat luminance bytes here is what produced imageException before.
  async pushPanel(pngBytes: Uint8Array): Promise<string> {
    await this.paintPreviewPanel(pngBytes)
    if (!this.real || !this.bridge) return 'success'
    const res = await this.bridge.updateImageRawData(new ImageRawDataUpdate({
      containerID: PANEL_ID, containerName: PANEL_NAME, imageData: pngBytes,
    }))
    return String(res)
  }

  private async upgrade(id: number, name: string, content: string): Promise<boolean> {
    try {
      return await this.bridge!.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: id, containerName: name, content })
      )
    } catch {
      return false
    }
  }

  async exit(): Promise<void> {
    this.paintPreview('Glass Car Dash', '\n  Exited. Reload the page to restart.', '')
    if (this.real && this.bridge) await this.bridge.shutDownPageContainer(1)
  }

  // Continuous location, real or synthesized. In mirror mode, drifts a fake
  // point along a small loop with varying fake speed/heading so the whole
  // downstream pipeline (Overpass lookups included) is exercisable without
  // real hardware or a real drive.
  async startLocationUpdates(onLocation: (loc: RawLocation) => void): Promise<void> {
    if (!this.real || !this.bridge) {
      const baseLat = 51.60202673636377
      const baseLon = 0.042996564880013466
      let t = 0
      setInterval(() => {
        t += 0.08
        onLocation({
          lat: baseLat + Math.sin(t) * 0.0006,
          lon: baseLon + Math.cos(t * 0.7) * 0.0006,
          speedMps: 8 + Math.sin(t * 2) * 6, // wobbles roughly 4-31 mph
          headingDeg: (t * 40) % 360,
        })
      }, 2000)
      return
    }
    await this.bridge.startAppLocationUpdates({
      accuracy: AppLocationAccuracy.High,
      intervalMs: 3000,
      distanceFilter: 5,
    })
    this.bridge.onAppLocationChanged((loc: any) => {
      onLocation({
        lat: loc.latitude,
        lon: loc.longitude,
        speedMps: typeof loc.speed === 'number' ? loc.speed : null,
        headingDeg: typeof loc.heading === 'number' ? loc.heading : null,
      })
    })
  }

  // Glasses battery, real or synthesized (mirror mode fakes a fixed, plausible
  // value). Only trust batteryLevel when connectType is actually Connected —
  // the SDK's own README example gates on exactly this before reading
  // batteryLevel, implying it's meaningless (observed: reads as 0) during
  // None/Connecting/Disconnected states. Skipping this check was the bug
  // behind battery always showing 0%.
  //
  // onDeviceStatusChanged alone still never fired even after subscribing at
  // the earliest possible point (see connect()) — it's most likely
  // edge-triggered (fires on a connect/disconnect or wearing transition),
  // not on-subscribe-with-current-state, so a session that's been
  // continuously connected/worn the whole time this app has run would never
  // see it fire regardless of registration timing. getDeviceInfo() is a
  // request/response call with the same DeviceStatus shape (confirmed in the
  // SDK's own type defs) — polling it doesn't depend on catching a
  // transition at all, so it's the primary source now; the event listener
  // stays registered as a free bonus for faster updates when it does fire.
  onBattery(onUpdate: (levelPct: number | null, charging: boolean) => void): void {
    if (!this.real || !this.bridge) {
      onUpdate(73, false)
      return
    }
    this.batteryHandler = onUpdate
    if (this.lastDeviceStatus) this.handleDeviceStatus(this.lastDeviceStatus)
    void this.pollBattery()
    setInterval(() => void this.pollBattery(), 15_000)
  }

  private async pollBattery(): Promise<void> {
    if (!this.bridge) return
    try {
      const info = await this.bridge.getDeviceInfo()
      if (info?.status) this.handleDeviceStatus(info.status)
    } catch {
      // best-effort — the live event listener may still catch a status change instead
    }
  }

  private handleDeviceStatus(status: any): void {
    this.lastDeviceStatus = status
    if (!this.batteryHandler) return
    if (status.connectType !== DeviceConnectType.Connected) return
    this.batteryHandler(typeof status.batteryLevel === 'number' ? status.batteryLevel : null, !!status.isCharging)
  }

  private onEvent(e: any) {
    const env = e.listEvent ?? e.textEvent ?? e.sysEvent
    if (!env) return
    const t = env.eventType === undefined ? OsEventTypeList.CLICK_EVENT : env.eventType
    const mapped = this.mapType(t)
    if (!mapped) return

    if (mapped === 'up' || mapped === 'down') return this.emitScroll(mapped)
    if (mapped === 'foreground') return this.handler('foreground')

    const now = Date.now()
    if (mapped === this.lastInput.type && now - this.lastInput.at < 280) return
    this.lastInput = { type: mapped, at: now }
    this.handler(mapped)
  }

  private mapType(t: number | undefined): Input | null {
    switch (t) {
      case OsEventTypeList.CLICK_EVENT: return 'click'
      case OsEventTypeList.DOUBLE_CLICK_EVENT: return 'double'
      case OsEventTypeList.SCROLL_TOP_EVENT: return 'up'
      case OsEventTypeList.SCROLL_BOTTOM_EVENT: return 'down'
      case OsEventTypeList.FOREGROUND_ENTER_EVENT: return 'foreground'
      default: return null
    }
  }

  private emitScroll(dir: 'up' | 'down') {
    const now = Date.now()
    if (now - this.lastScroll < SCROLL_THROTTLE_MS) return
    this.lastScroll = now
    this.handler(dir)
  }

  // Permanent phone-side UI — not just a browser-dev convenience (see the
  // file-level doc comment). The panel is built at the glasses' actual
  // 576x288 pixel size so it's a true 1:1 preview, then scaled down to fit
  // whatever the phone's viewport actually is via a wrapper + CSS
  // transform, since a real phone WebView is nowhere near 576px wide.
  private setupPreview() {
    const app = document.getElementById('app')!
    app.innerHTML = ''
    app.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:14px;justify-content:center;padding:16px;box-sizing:border-box;min-height:100%'

    const panel = document.createElement('div')
    panel.style.cssText = [
      'width:576px', 'height:288px', 'background:#000', 'color:#43e000',
      'font:16px/27px ui-monospace,SFMono-Regular,Menlo,monospace',
      'border:2px solid #2a2a2a', 'border-radius:8px', 'overflow:hidden',
      'display:flex', 'flex-direction:column', 'box-shadow:0 0 24px #0a3',
    ].join(';')

    const mk = (h: number, border: string, extraCss = '') => {
      const d = document.createElement('div')
      d.style.cssText = `height:${h}px;padding:4px 8px;white-space:pre;overflow:hidden;box-sizing:border-box;${border};${extraCss}`
      panel.appendChild(d)
      return d
    }
    const header = mk(HEADER_H, 'border-bottom:1px solid #154')

    // Body row: text zone (left) + dash panel canvas (right), side by side —
    // mirrors the real layout's bordered-left-panel / image-right-panel split.
    const bodyRow = document.createElement('div')
    bodyRow.style.cssText = `height:${BODY_H}px;display:flex;align-items:center`
    panel.appendChild(bodyRow)

    const body = document.createElement('div')
    body.style.cssText = `width:${LEFT_W}px;height:${BODY_H}px;padding:4px 8px;white-space:pre;overflow:hidden;box-sizing:border-box;border-right:1px solid #154`
    bodyRow.appendChild(body)

    const dashCanvas = document.createElement('canvas')
    dashCanvas.width = PANEL_W
    dashCanvas.height = PANEL_H
    dashCanvas.style.cssText = `width:${PANEL_W}px;height:${PANEL_H}px;margin-left:${(W - LEFT_W - PANEL_W) / 2}px;image-rendering:pixelated`
    bodyRow.appendChild(dashCanvas)
    this.previewPanelCtx = dashCanvas.getContext('2d')

    const footer = mk(FOOTER_H, 'border-top:1px solid #154;color:#2a9')
    this.previewEls = { header, body, footer }

    // Scaled wrapper: transform:scale() doesn't affect layout flow, so the
    // wrapper is sized to the POST-scale dimensions itself, otherwise
    // everything below it (buttons, hint) would sit under the unscaled
    // 576x288 footprint instead of right after the visible (smaller) panel.
    const panelWrap = document.createElement('div')
    panelWrap.style.cssText = 'position:relative;flex-shrink:0'
    panelWrap.appendChild(panel)
    app.appendChild(panelWrap)

    const rescale = () => {
      const scale = Math.min(1, (window.innerWidth - 32) / W)
      panel.style.transform = `scale(${scale})`
      panel.style.transformOrigin = 'top left'
      panelWrap.style.width = `${W * scale}px`
      panelWrap.style.height = `${H * scale}px`
    }
    rescale()
    window.addEventListener('resize', rescale)

    const bar = document.createElement('div')
    bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center'
    const btn = (label: string, i: Input) => {
      const b = document.createElement('button')
      b.textContent = label
      b.style.cssText = 'padding:8px 14px;background:#333;color:#ddd;border:1px solid #555;border-radius:6px;cursor:pointer;font:13px system-ui'
      b.onclick = () => this.handler(i)
      bar.appendChild(b)
    }
    btn('▲ up (next)', 'up')
    btn('● tap (play/pause)', 'click')
    btn('▼ down (prev)', 'down')
    btn('×2 exit', 'double')
    app.appendChild(bar)

    const hint = document.createElement('div')
    hint.textContent = 'Live preview of the glasses display — buttons above mirror the real gestures'
    hint.style.cssText = 'color:#888;font:12px system-ui;text-align:center'
    app.appendChild(hint)

    // Only ever fires in a browser (real phones have no physical keyboard),
    // harmless to register unconditionally.
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowUp') { ev.preventDefault(); this.handler('up') }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); this.handler('down') }
      else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.handler('click') }
      else if (ev.key === 'Escape' || ev.key === 'Backspace') { ev.preventDefault(); this.handler('double') }
    })
  }

  private paintPreview(header: string, body: string, footer: string) {
    if (!this.previewEls) return
    this.previewEls.header.textContent = header
    this.previewEls.body.textContent = body
    this.previewEls.footer.textContent = footer
  }

  // Decodes the same PNG bytes real hardware would receive and draws them —
  // this exercises the actual encode step, not just a pixel approximation.
  private async paintPreviewPanel(pngBytes: Uint8Array) {
    if (!this.previewPanelCtx) return
    const bitmap = await createImageBitmap(new Blob([pngBytes as BlobPart], { type: 'image/png' }))
    this.previewPanelCtx.clearRect(0, 0, PANEL_W, PANEL_H)
    this.previewPanelCtx.drawImage(bitmap, 0, 0)
  }
}
