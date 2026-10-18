import {
  AttributionControl,
  LngLatBounds,
  Map,
  Marker,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
} from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { LngLat, LocationFix } from './route'

setWorkerUrl(workerUrl)

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'
const ROUTE_SOURCE = 'active-route'
const ROUTE_CASING = 'active-route-casing'
const ROUTE_LINE = 'active-route-line'

export class MobileNavigationMap {
  private map: Map
  private positionMarker: Marker
  private destinationMarker: Marker | null = null
  private route: LngLat[] = []
  private latestFix: LocationFix | null = null
  private following = true
  private loaded = false

  constructor(container: HTMLElement) {
    const position = document.createElement('div')
    position.className = 'phone-position-marker'
    position.innerHTML = '<span></span>'
    this.map = new Map({
      container,
      style: STYLE_URL,
      center: [-118.2437, 34.0522],
      zoom: 10,
      attributionControl: false,
    })
    this.positionMarker = new Marker({ element: position, rotationAlignment: 'map' })
      .setLngLat([-118.2437, 34.0522])
      .addTo(this.map)
    this.map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    this.map.addControl(new AttributionControl({ compact: true }), 'bottom-right')
    this.map.on('dragstart', () => { this.following = false })
    this.map.on('load', () => {
      this.loaded = true
      this.ensureRouteLayers()
      this.drawRoute()
    })
  }

  updateLocation(fix: LocationFix) {
    const firstFix = this.latestFix == null
    this.latestFix = fix
    const coordinates: LngLat = [fix.longitude, fix.latitude]
    this.positionMarker.setLngLat(coordinates)
    if (fix.headingDegrees != null) this.positionMarker.setRotation(fix.headingDegrees)
    if (firstFix || this.following) {
      this.map.easeTo({
        center: coordinates,
        zoom: firstFix ? 15 : Math.max(this.map.getZoom(), 15),
        duration: firstFix ? 800 : 350,
      })
    }
  }

  showRoute(coordinates: LngLat[], destination: LngLat) {
    this.route = coordinates
    this.destinationMarker?.remove()
    this.destinationMarker = new Marker({ color: '#167d37' }).setLngLat(destination).addTo(this.map)
    this.drawRoute()
    if (coordinates.length > 1) {
      const bounds = coordinates.reduce((value, coordinate) => value.extend(coordinate), new LngLatBounds(coordinates[0], coordinates[0]))
      this.map.fitBounds(bounds, { padding: 44, maxZoom: 16, duration: 800 })
      this.following = false
    }
  }

  clearRoute() {
    this.route = []
    this.destinationMarker?.remove()
    this.destinationMarker = null
    this.drawRoute()
  }

  recenter() {
    if (!this.latestFix) return
    this.following = true
    this.map.easeTo({ center: [this.latestFix.longitude, this.latestFix.latitude], zoom: 16, duration: 500 })
  }

  resize() {
    this.map.resize()
  }

  private ensureRouteLayers() {
    if (!this.loaded || this.map.getSource(ROUTE_SOURCE)) return
    this.map.addSource(ROUTE_SOURCE, {
      type: 'geojson',
      data: this.routeGeoJson(),
    })
    this.map.addLayer({
      id: ROUTE_CASING,
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#123d22', 'line-width': 9, 'line-opacity': 0.8 },
    })
    this.map.addLayer({
      id: ROUTE_LINE,
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#58d36b', 'line-width': 5 },
    })
  }

  private drawRoute() {
    if (!this.loaded) return
    this.ensureRouteLayers()
    ;(this.map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined)?.setData(this.routeGeoJson())
  }

  private routeGeoJson(): GeoJSON.Feature<GeoJSON.LineString> {
    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: this.route },
    }
  }
}
