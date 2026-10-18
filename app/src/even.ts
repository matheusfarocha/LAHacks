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
  type AppLocation,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { MotionSample } from './drowsiness'
import {
  DEFAULT_NAVIGATION,
  formatCompassHeading,
  formatNavigationDistance,
  shouldShowManeuver,
  type Maneuver,
  type NavigationInstruction,
} from './navigation'
import type { LocationFix } from './route'
import { MobileNavigationMap } from './mobile-map'
import mockupUrl from '../../docs/mockups/amg-silverline.png?url'

const TILE_W = 200
const TILE_H = 100
const WIDTH = TILE_W * 2
const HEIGHT = TILE_H * 2
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
  private exited = false
  private lastFrame: string | undefined
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
  private startNavigationHandler: (destination: string) => void = () => {}
  private stopNavigationHandler: () => void = () => {}
  private navigationStatus = document.createElement('p')
  private mobileMap: MobileNavigationMap | null = null

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
  onStartNavigation(handler: (destination: string) => void) { this.startNavigationHandler = handler }
  onStopNavigation(handler: () => void) { this.stopNavigationHandler = handler }

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
  setNavigationStatus(message: string) { this.navigationStatus.textContent = message }
  updateMapLocation(fix: LocationFix) { this.mobileMap?.updateLocation(fix) }
  showMapRoute(coordinates: [number, number][], destination: [number, number]) {
    this.mobileMap?.showRoute(coordinates, destination)
  }
  clearMapRoute() { this.mobileMap?.clearRoute() }

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

  async render(
    speedMph: number | null,
    alert = false,
    navigation = DEFAULT_NAVIGATION,
    headingDegrees: number | null = null,
  ): Promise<void> {
    if (this.exited) return
    const text = speedMph == null ? '—' : String(Math.round(speedMph))
    const key = alert ? 'head-nod-alert' : `${text}|${navigation.maneuver}|${navigation.distanceMiles}|${navigation.streetName}|${headingDegrees}`
    if (key === this.lastFrame) return
    const ctx = this.canvas.getContext('2d')!
    ctx.clearRect(0, 0, WIDTH, HEIGHT)
    if (alert) {
      this.drawAlert(ctx)
    } else {
      ctx.save()
      const speedScale = 0.6
      ctx.translate(0, 34)
      ctx.scale(speedScale, speedScale)
      ctx.drawImage(this.gauge, 0, 0)
      ctx.fillStyle = '#78df6c'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = 'italic 700 100px -apple-system, BlinkMacSystemFont, Arial, sans-serif'
      ctx.fillText(text, WIDTH / 2, 88, 210)
      ctx.font = '500 21px -apple-system, BlinkMacSystemFont, Arial, sans-serif'
      ctx.fillText('MPH', WIDTH / 2, 155)
      ctx.restore()
      this.drawNavigation(ctx, navigation, headingDegrees)
    }
    this.canvas.setAttribute('aria-label', alert
      ? 'Take a break. Head nod detected. Tap to dismiss.'
      : `${speedMph == null ? 'Waiting for GPS speed' : `${text} MPH`}. ${navigation.streetName}.${shouldShowManeuver(navigation.distanceMiles) ? ` ${formatNavigationDistance(navigation.distanceMiles)} to the maneuver.` : ''}`)

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
    this.lastFrame = key
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

  private drawNavigation(
    ctx: CanvasRenderingContext2D,
    instruction: NavigationInstruction,
    headingDegrees: number | null,
  ) {
    const green = '#91f27b'
    ctx.strokeStyle = green
    ctx.fillStyle = green
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (shouldShowManeuver(instruction.distanceMiles)) {
      // The scaled arrow's top aligns with the top of the speedometer arcs.
      this.drawManeuverArrow(ctx, instruction.maneuver, 321, 60)
      ctx.font = '700 27px -apple-system, BlinkMacSystemFont, Arial, sans-serif'
      ctx.fillText(formatNavigationDistance(instruction.distanceMiles), 321, 116, 145)
    } else {
      this.drawCompass(ctx, headingDegrees, 321, 82)
    }
    ctx.font = '600 15px -apple-system, BlinkMacSystemFont, Arial, sans-serif'
    ctx.fillText(instruction.streetName.toUpperCase(), 321, 164, 145)
  }

  private drawCompass(ctx: CanvasRenderingContext2D, headingDegrees: number | null, x: number, y: number) {
    ctx.font = '600 23px -apple-system, BlinkMacSystemFont, Arial, sans-serif'
    ctx.fillText(formatCompassHeading(headingDegrees), x - 17, y, 55)
    ctx.save()
    ctx.translate(x + 29, y)
    ctx.rotate(((headingDegrees ?? 0) * Math.PI) / 180)
    ctx.beginPath()
    ctx.moveTo(0, -13)
    ctx.lineTo(9, 11)
    ctx.lineTo(0, 7)
    ctx.lineTo(-9, 11)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  private drawManeuverArrow(ctx: CanvasRenderingContext2D, maneuver: Maneuver, x: number, y: number) {
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(0.7, 0.7)
    if (maneuver === 'arrive') {
      ctx.lineWidth = 4
      ctx.strokeRect(-23, -21, 46, 42)
      ctx.beginPath()
      ctx.moveTo(-23, -21); ctx.lineTo(23, 21)
      ctx.moveTo(23, -21); ctx.lineTo(-23, 21)
      ctx.stroke()
      ctx.restore()
      return
    }
    if (maneuver === 'roundabout') {
      ctx.beginPath()
      ctx.arc(0, 0, 22, Math.PI * 0.2, Math.PI * 1.85)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(14, -25); ctx.lineTo(25, -18); ctx.lineTo(14, -10)
      ctx.stroke()
      ctx.restore()
      return
    }
    const mirror = maneuver.includes('left') ? -1 : 1
    ctx.scale(mirror, 1)
    ctx.beginPath()
    if (maneuver === 'straight') {
      ctx.moveTo(0, 26); ctx.lineTo(0, -25)
    } else if (maneuver === 'u-turn') {
      ctx.moveTo(18, 27); ctx.lineTo(18, -5); ctx.quadraticCurveTo(18, -27, 0, -27); ctx.quadraticCurveTo(-18, -27, -18, -5)
    } else if (maneuver.startsWith('slight')) {
      ctx.moveTo(-17, 27); ctx.lineTo(-17, 4); ctx.lineTo(17, -25)
    } else {
      ctx.moveTo(-18, 27); ctx.lineTo(-18, 0); ctx.quadraticCurveTo(-18, -19, 1, -19); ctx.lineTo(23, -19)
    }
    ctx.stroke()
    ctx.beginPath()
    if (maneuver === 'straight') {
      ctx.moveTo(-11, -14); ctx.lineTo(0, -27); ctx.lineTo(11, -14)
    } else if (maneuver === 'u-turn') {
      ctx.moveTo(-8, 4); ctx.lineTo(-18, -7); ctx.lineTo(-28, 4)
    } else if (maneuver.startsWith('slight')) {
      ctx.moveTo(3, -25); ctx.lineTo(19, -27); ctx.lineTo(17, -10)
    } else {
      ctx.moveTo(12, -29); ctx.lineTo(24, -19); ctx.lineTo(12, -9)
    }
    ctx.stroke()
    ctx.restore()
  }

  async startLocationUpdates(onLocation: (fix: LocationFix) => void): Promise<void> {
    if (this.exited) return
    if (!this.bridge) {
      if (!navigator.geolocation) throw new Error('This browser does not provide GPS location.')
      const watchId = navigator.geolocation.watchPosition(
        (position) => {
          if (!this.exited) onLocation(this.browserLocationFix(position))
        },
        (error) => {
          this.showError(`GPS unavailable: ${error.message}`)
          this.setNavigationStatus(`GPS unavailable: ${error.message}`)
        },
        // Desktop browsers often have Wi-Fi/network location but no GPS radio.
        // The native G2 path below still requests high-accuracy phone GPS.
        { enableHighAccuracy: false, maximumAge: 60_000, timeout: 30_000 },
      )
      this.unsubscribeLocation = () => navigator.geolocation.clearWatch(watchId)
      return
    }
    // Subscribe before starting so the first GPS fix cannot be missed.
    this.unsubscribeLocation = this.bridge.onAppLocationChanged((location) => {
      if (!this.exited) onLocation(this.appLocationFix(location))
    })
    const started = await this.bridge.startAppLocationUpdates({
      accuracy: AppLocationAccuracy.High,
      intervalMs: 1000,
      distanceFilter: 0,
    })
    if (!started) throw new Error('Location unavailable. Allow location access for the Even app, then reopen this app.')
    // A double-tap can arrive while the native start request is in flight.
    if (this.exited) this.stopLocationUpdates()
  }

  async requestCurrentLocation(): Promise<LocationFix> {
    if (this.exited) throw new Error('The display has already closed.')
    if (this.bridge) {
      const location = await this.bridge.getAppLocation({ accuracy: AppLocationAccuracy.High, timeoutMs: 15_000 })
      if (!location) throw new Error('The Even app did not return a location. Confirm Precise Location is enabled.')
      return this.appLocationFix(location)
    }
    if (!navigator.geolocation) throw new Error('This browser does not provide location services.')
    const request = (options: PositionOptions) => new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, options)
    })
    try {
      return this.browserLocationFix(await request({ enableHighAccuracy: true, maximumAge: 60_000, timeout: 10_000 }))
    } catch (error) {
      const geolocationError = error as GeolocationPositionError
      if (geolocationError.code === geolocationError.PERMISSION_DENIED) {
        throw new Error(geolocationError.message || 'Location permission was denied.')
      }
      try {
        return this.browserLocationFix(await request({ enableHighAccuracy: false, maximumAge: 300_000, timeout: 20_000 }))
      } catch (fallbackError) {
        const message = (fallbackError as GeolocationPositionError).message
        throw new Error(message || 'No GPS or network location fix is available on this computer.')
      }
    }
  }

  private browserLocationFix(position: GeolocationPosition): LocationFix {
    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      speedMps: Number.isFinite(position.coords.speed) ? position.coords.speed : null,
      headingDegrees: Number.isFinite(position.coords.heading) ? position.coords.heading : null,
      timestamp: position.timestamp,
    }
  }

  private appLocationFix(location: AppLocation): LocationFix {
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: typeof location.accuracy === 'number' ? location.accuracy : 50,
      speedMps: typeof location.speed === 'number' ? location.speed : null,
      headingDegrees: typeof location.heading === 'number' ? location.heading : null,
      timestamp: typeof location.timestamp === 'number'
        ? location.timestamp < 1_000_000_000_000 ? location.timestamp * 1000 : location.timestamp
        : Date.now(),
    }
  }

  stopLocationUpdates() {
    this.unsubscribeLocation?.()
    this.unsubscribeLocation = undefined
    if (this.bridge) void this.bridge.stopAppLocationUpdates().catch(() => {})
  }

  async exit(): Promise<void> {
    this.exited = true
    this.stopLocationUpdates()
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
    hint.textContent = hasHost ? 'Live phone GPS navigation · double-tap to exit' : 'Live browser GPS preview'
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
    const navigationControls = this.createNavigationControls()
    const { section: mapSection, container: mapContainer, recenter } = this.createPhoneMap()
    document.getElementById('app')!.replaceChildren(display, hint, this.error, navigationControls, mapSection, controls)
    document.getElementById('app')!.style.height = 'auto'
    document.getElementById('app')!.style.minHeight = '100%'
    this.error.setAttribute('role', 'status')
    try {
      this.mobileMap = new MobileNavigationMap(mapContainer)
      recenter.onclick = () => this.mobileMap?.recenter()
      requestAnimationFrame(() => this.mobileMap?.resize())
    } catch (error) {
      mapContainer.textContent = error instanceof Error ? `Map unavailable: ${error.message}` : 'Map unavailable.'
    }
  }

  private createPhoneMap() {
    const section = document.createElement('section')
    section.style.cssText = 'width:min(576px,100%);padding:16px;box-sizing:border-box;border:1px solid #333;border-radius:8px;display:flex;flex-direction:column;gap:10px;text-align:left'
    const header = document.createElement('div')
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px'
    const title = document.createElement('strong')
    title.textContent = 'Live route map'
    const recenter = document.createElement('button')
    recenter.type = 'button'
    recenter.textContent = 'Recenter'
    recenter.style.cssText = 'padding:7px 10px;border:1px solid #555;border-radius:6px;background:#242424;color:#ddd;cursor:pointer'
    header.append(title, recenter)
    const container = document.createElement('div')
    container.setAttribute('aria-label', 'OpenFreeMap navigation map')
    container.style.cssText = 'position:relative;width:100%;height:320px;overflow:hidden;border-radius:8px;background:#171717'
    const attribution = document.createElement('p')
    attribution.style.cssText = 'margin:0;color:#888;font:11px/1.4 system-ui'
    attribution.textContent = 'OpenFreeMap · OpenStreetMap data · OSRM routing'
    section.append(header, container, attribution)
    return { section, container, recenter }
  }

  private createNavigationControls() {
    const section = document.createElement('section')
    section.style.cssText = 'width:min(576px,100%);padding:16px;box-sizing:border-box;border:1px solid #333;border-radius:8px;display:flex;flex-direction:column;gap:10px;text-align:left'
    const title = document.createElement('strong')
    title.textContent = 'GPS navigation'
    const note = document.createElement('p')
    note.textContent = 'Enter an address or place. Keyless OpenStreetMap routing advances each turn from live phone GPS and reroutes after a sustained deviation.'
    note.style.cssText = 'margin:0;color:#aaa;font:13px/1.5 system-ui'
    const form = document.createElement('form')
    form.style.cssText = 'display:grid;grid-template-columns:1fr auto auto;gap:8px'
    const destination = document.createElement('input')
    destination.type = 'search'
    destination.placeholder = 'Address or destination'
    destination.autocomplete = 'street-address'
    destination.setAttribute('aria-label', 'Destination')
    destination.style.cssText = 'box-sizing:border-box;width:100%;min-width:0;padding:9px;border:1px solid #555;border-radius:6px;background:#181818;color:#ddd'
    const button = (label: string, type: 'submit' | 'button') => {
      const element = document.createElement('button')
      element.type = type
      element.textContent = label
      element.style.cssText = 'padding:9px 12px;border:1px solid #555;border-radius:6px;background:#242424;color:#ddd;cursor:pointer'
      return element
    }
    const start = button('Start', 'submit')
    const stop = button('Stop', 'button')
    form.onsubmit = (event) => {
      event.preventDefault()
      this.startNavigationHandler(destination.value)
    }
    stop.onclick = () => this.stopNavigationHandler()
    form.append(destination, start, stop)
    this.navigationStatus.style.cssText = 'margin:0;color:#9ce78b;font:13px/1.5 system-ui'
    this.navigationStatus.setAttribute('role', 'status')
    this.navigationStatus.textContent = 'Waiting for a live GPS fix…'
    section.append(title, note, form, this.navigationStatus)
    return section
  }

  showError(message: string) {
    this.error.textContent = message
    this.error.style.cssText = 'color:#aaa;font:13px system-ui;margin:0'
  }
}
