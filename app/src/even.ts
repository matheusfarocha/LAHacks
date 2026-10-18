import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
  OsEventTypeList,
  AppLocationAccuracy,
  StartUpPageCreateResult,
  ImuReportPace,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { MotionSample } from './drowsiness'
import mockupUrl from '../../docs/mockups/amg-silverline.png?url'

const TILE_W = 200
const TILE_H = 100
const WIDTH = TILE_W * 2
const HEIGHT = TILE_H * 2
const GAUGE_SCALE = 0.75
const LEFT = (576 - WIDTH) / 2
const TOP = 84

export class Runtime {
  private bridge: EvenAppBridge | null = null
  private canvas = document.createElement('canvas')
  private artwork = new Image()
  private gauge = document.createElement('canvas')
  private error = document.createElement('p')
  private exitHandler: () => void = () => {}
  private unsubscribeLocation: (() => void) | undefined
  private previewTimer: ReturnType<typeof setInterval> | undefined
  private exited = false
  private lastSpeed: string | undefined
  private motionHandler: (sample: MotionSample) => void = () => {}
  private tapHandler: () => void = () => {}
  private unsubscribeEvents: (() => void) | undefined
  private motionStatus = document.createElement('p')
  private neutralButton = document.createElement('button')
  private downButton = document.createElement('button')
  private calibrationHandler: (pose: 'neutral' | 'down') => void = () => {}
  private testAlertHandler: () => void = () => {}
  private acknowledgeHandler: () => void = () => {}
  private warning = document.createElement('canvas')

  async connect(): Promise<void> {
    this.setupPreview()
    this.artwork.src = mockupUrl
    await this.artwork.decode()
    this.prepareGauge()
    const hasHost = typeof (window as any).flutter_inappwebview?.callHandler === 'function'
    if (!hasHost) return
    this.bridge = await waitForEvenAppBridge()
    this.unsubscribeEvents = this.bridge.onEvenHubEvent((event: any) => {
      const sys = event.sysEvent
      if (sys?.eventType === OsEventTypeList.IMU_DATA_REPORT && sys.imuData) {
        if (!this.exited) this.motionHandler(sys.imuData)
        return
      }
      const input = event.listEvent ?? event.textEvent ?? event.sysEvent
      if (input?.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) this.exitHandler()
      else if (input?.eventType === OsEventTypeList.CLICK_EVENT || (input?.eventType === undefined && event.textEvent)) this.tapHandler()
    })
    const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 5,
      textObject: [new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 288,
        containerID: 1, containerName: 'input', content: '',
        isEventCapture: 1, borderWidth: 0, paddingLength: 0,
      })],
      imageObject: Array.from({ length: 4 }, (_, index) => new ImageContainerProperty({
        xPosition: LEFT + (index % 2) * TILE_W,
        yPosition: TOP + Math.floor(index / 2) * TILE_H,
        width: TILE_W, height: TILE_H,
        containerID: index + 2, containerName: 'speed' + index,
      })),
    }))
    if (result !== StartUpPageCreateResult.success) throw new Error('Unable to create the glasses display. Re-scan the QR code.')
  }

  onExit(handler: () => void) {
    this.exitHandler = handler
  }

  onMotion(handler: (sample: MotionSample) => void) { this.motionHandler = handler }
  onTap(handler: () => void) { this.tapHandler = handler }
  onCalibrate(handler: (pose: 'neutral' | 'down') => void) { this.calibrationHandler = handler }
  onTestAlert(handler: () => void) { this.testAlertHandler = handler }
  onAcknowledge(handler: () => void) { this.acknowledgeHandler = handler }

  async startMotionUpdates(): Promise<boolean> {
    if (!this.bridge || this.exited) return false
    const enabled = await this.bridge.imuControl(true, ImuReportPace.P100)
    if (this.exited) {
      void this.bridge.imuControl(false).catch(() => {})
      return false
    }
    return enabled
  }

  setMotionStatus(message: string) { this.motionStatus.textContent = message }

  setCalibrationControls(enabled: boolean, canCaptureDown: boolean) {
    this.neutralButton.disabled = !enabled
    this.downButton.disabled = !enabled || !canCaptureDown
    this.neutralButton.style.opacity = this.neutralButton.disabled ? '0.4' : '1'
    this.downButton.style.opacity = this.downButton.disabled ? '0.4' : '1'
  }

  private prepareGauge() {
    this.gauge.width = WIDTH
    this.gauge.height = HEIGHT
    const ctx = this.gauge.getContext('2d')!
    ctx.drawImage(this.artwork, 354, 250, 80, 190, 24, 8, 72, 184)
    ctx.drawImage(this.artwork, 638, 250, 80, 190, 304, 8, 72, 184)
    // Discard the mockup's dark rectangular backing; retain the green arcs.
    const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT)
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      const red = pixels.data[offset]
      const green = pixels.data[offset + 1]
      const blue = pixels.data[offset + 2]
      if (green < 38 || green - Math.max(red, blue) < 12) {
        pixels.data[offset] = 0
        pixels.data[offset + 1] = 0
        pixels.data[offset + 2] = 0
        pixels.data[offset + 3] = 0
      }
    }
    ctx.putImageData(pixels, 0, 0)
    // Preserve the warning triangle from the Head-nod Alert reference.
    this.warning.width = 100
    this.warning.height = 90
    const warningCtx = this.warning.getContext('2d')!
    warningCtx.drawImage(this.artwork, 472, 654, 126, 105, 0, 0, 100, 84)
    const warningPixels = warningCtx.getImageData(0, 0, 100, 90)
    for (let offset = 0; offset < warningPixels.data.length; offset += 4) {
      const r = warningPixels.data[offset]
      const g = warningPixels.data[offset + 1]
      const b = warningPixels.data[offset + 2]
      if (g < 38 || g - Math.max(r, b) < 12) {
        warningPixels.data.fill(0, offset, offset + 4)
      }
    }
    warningCtx.putImageData(warningPixels, 0, 0)
  }

  async render(speedMph: number | null, alert = false): Promise<void> {
    if (this.exited) return
    const text = speedMph == null ? '—' : String(Math.round(speedMph))
    const key = alert ? 'head-nod-alert' : text
    if (key === this.lastSpeed) return
    const ctx = this.canvas.getContext('2d')!
    ctx.clearRect(0, 0, WIDTH, HEIGHT)
    if (alert) {
      this.drawAlert(ctx)
    } else {
      ctx.save()
      ctx.translate(WIDTH * (1 - GAUGE_SCALE) / 2, HEIGHT * (1 - GAUGE_SCALE) / 2)
      ctx.scale(GAUGE_SCALE, GAUGE_SCALE)
      ctx.drawImage(this.gauge, 0, 0)
      ctx.fillStyle = '#78df6c'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = 'italic 700 100px -apple-system, BlinkMacSystemFont, Arial, sans-serif'
      ctx.fillText(text, WIDTH / 2, 88, 210)
      ctx.font = '500 21px -apple-system, BlinkMacSystemFont, Arial, sans-serif'
      ctx.fillText('MPH', WIDTH / 2, 155)
      ctx.restore()
    }
    this.canvas.setAttribute('aria-label', alert ? 'Take a break. Head nod detected. Tap to dismiss.' : speedMph == null ? 'Waiting for GPS speed' : text + ' MPH')

    if (this.bridge) {
      for (let index = 0; index < 4; index++) {
        if (this.exited) return
        const tile = document.createElement('canvas')
        tile.width = TILE_W
        tile.height = TILE_H
        const tileCtx = tile.getContext('2d')!
        tileCtx.drawImage(this.canvas, (index % 2) * TILE_W, Math.floor(index / 2) * TILE_H,
          TILE_W, TILE_H, 0, 0, TILE_W, TILE_H)
        // Keep PNG alpha intact while converting visible pixels to monochrome.
        const pixels = tileCtx.getImageData(0, 0, TILE_W, TILE_H)
        for (let offset = 0; offset < pixels.data.length; offset += 4) {
          const brightness = pixels.data[offset + 1]
          pixels.data[offset] = brightness
          pixels.data[offset + 2] = brightness
        }
        tileCtx.putImageData(pixels, 0, 0)
        const blob = await new Promise<Blob>((resolve, reject) => {
          tile.toBlob((value) => value ? resolve(value) : reject(new Error('Image encoding failed')), 'image/png')
        })
        if (this.exited) return
        const result = await this.bridge.updateImageRawData(new ImageRawDataUpdate({
          containerID: index + 2, containerName: 'speed' + index,
          imageData: new Uint8Array(await blob.arrayBuffer()),
        }))
        if (String(result) !== 'success') throw new Error('Display transfer failed. Retrying…')
      }
    }
    this.lastSpeed = key
    this.showError('')
  }

  private drawAlert(ctx: CanvasRenderingContext2D) {
    ctx.strokeStyle = '#91f27b'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.roundRect(3, 3, WIDTH - 6, HEIGHT - 6, 12)
    ctx.stroke()
    ctx.drawImage(this.warning, 150, 12)
    ctx.fillStyle = '#91f27b'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '700 30px -apple-system, BlinkMacSystemFont, Arial, sans-serif'
    ctx.fillText('TAKE A BREAK', WIDTH / 2, 122)
    ctx.font = '16px -apple-system, BlinkMacSystemFont, Arial, sans-serif'
    ctx.fillText('Head nod detected', WIDTH / 2, 155)
    ctx.font = '12px -apple-system, BlinkMacSystemFont, Arial, sans-serif'
    ctx.fillText('Tap to dismiss', WIDTH / 2, 181)
  }

  async startSpeedUpdates(onSpeed: (speedMps: number | null) => void): Promise<void> {
    if (this.exited) return
    if (!this.bridge) {
      let time = 0
      onSpeed(8)
      this.previewTimer = setInterval(() => {
        time += 0.16
        onSpeed(8 + Math.sin(time) * 6)
      }, 1000)
      return
    }
    // Subscribe before starting so the first GPS fix cannot be missed.
    this.unsubscribeLocation = this.bridge.onAppLocationChanged((location) => {
      if (!this.exited) onSpeed(typeof location.speed === 'number' ? location.speed : null)
    })
    const started = await this.bridge.startAppLocationUpdates({
      accuracy: AppLocationAccuracy.High,
      intervalMs: 1000,
      distanceFilter: 0,
    })
    if (!started) throw new Error('Location unavailable. Allow location access for the Even app, then reopen this app.')
    // A double-tap can arrive while the native start request is in flight.
    if (this.exited) this.stopSpeedUpdates()
  }

  stopSpeedUpdates() {
    clearInterval(this.previewTimer)
    this.unsubscribeLocation?.()
    this.unsubscribeLocation = undefined
    if (this.bridge) void this.bridge.stopAppLocationUpdates().catch(() => {})
  }

  async exit(): Promise<void> {
    this.exited = true
    this.stopSpeedUpdates()
    this.unsubscribeEvents?.()
    if (this.bridge) {
      await this.bridge.imuControl(false).catch(() => {})
      await this.bridge.shutDownPageContainer(0)
    }
  }

  private setupPreview() {
    this.canvas.width = WIDTH
    this.canvas.height = HEIGHT
    this.canvas.setAttribute('role', 'img')
    this.canvas.setAttribute('aria-label', 'Waiting for GPS speed')
    this.canvas.style.cssText = 'position:absolute;left:15.278%;top:29.167%;width:69.444%;height:auto'
    const display = document.createElement('div')
    display.style.cssText = 'position:relative;width:min(576px,100%);aspect-ratio:2;background:#000;border:1px solid #292929;border-radius:8px'
    display.append(this.canvas)
    const hint = document.createElement('p')
    const hasHost = typeof (window as any).flutter_inappwebview?.callHandler === 'function'
    hint.textContent = hasHost ? 'Live GPS speed · double-tap to exit' : 'Simulated speed · browser preview'
    hint.style.cssText = 'color:#888;font:12px system-ui;margin:0'
    const controls = document.createElement('section')
    controls.style.cssText = 'width:min(576px,100%);padding:16px;box-sizing:border-box;border:1px solid #333;border-radius:8px;display:flex;flex-direction:column;gap:12px;text-align:left'
    const title = document.createElement('strong')
    title.textContent = 'Head-nod alert'
    const note = document.createElement('p')
    note.textContent = 'Calibrate while stationary. Repeated head dips can trigger a break reminder; this is a motion heuristic, not a confirmed drowsiness assessment.'
    note.style.cssText = 'margin:0;color:#aaa;font:13px/1.5 system-ui'
    this.motionStatus.style.cssText = 'margin:0;color:#9ce78b;font:13px/1.5 system-ui'
    this.motionStatus.setAttribute('role', 'status')
    this.motionStatus.textContent = hasHost ? 'Connecting to head-motion sensor…' : 'Browser preview · automatic detection requires the glasses'
    const buttons = document.createElement('div')
    buttons.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap'
    const styleButton = (button: HTMLButtonElement, label: string, action: () => void) => {
      button.textContent = label
      button.style.cssText = 'padding:9px 12px;border:1px solid #555;border-radius:6px;background:#242424;color:#ddd;cursor:pointer'
      button.onclick = action
      buttons.append(button)
    }
    styleButton(this.neutralButton, '1. Capture forward pose', () => this.calibrationHandler('neutral'))
    styleButton(this.downButton, '2. Capture head-down pose', () => this.calibrationHandler('down'))
    styleButton(document.createElement('button'), 'Preview alert', () => this.testAlertHandler())
    styleButton(document.createElement('button'), 'Dismiss alert', () => this.acknowledgeHandler())
    this.setCalibrationControls(false, false)
    controls.append(title, note, this.motionStatus, buttons)
    document.getElementById('app')!.replaceChildren(display, hint, this.error, controls)
    document.getElementById('app')!.style.height = 'auto'
    document.getElementById('app')!.style.minHeight = '100%'
    this.error.setAttribute('role', 'status')
  }

  showError(message: string) {
    this.error.textContent = message
    this.error.style.cssText = 'color:#aaa;font:13px system-ui;margin:0'
  }
}
