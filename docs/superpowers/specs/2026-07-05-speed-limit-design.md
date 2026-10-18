# Glass Car Dash: driving info on the hidden screen

**Status**: implemented — `osm.ts`, `speed.ts`, `battery.ts` built, 35/35
tests passing, verified end-to-end in the browser mirror (synthetic GPS →
real Overpass call → correct render), packed into `glass-car-dash.ehpk`
**Date**: 2026-07-05

## Problem

While driving, Glass Car Dash is deliberately hidden (double-tap from the
normal remote screen) to minimize distraction — next/previous still work
blind, but the screen goes near-blank. That blank screen is wasted space:
showing current speed, the local speed limit, and a few other cheap,
driving-relevant signals there would be genuinely useful, displayed exactly
where and when the user has already said "minimal, but don't waste this."

**Scope for this design**: current speed, speed limit, glasses battery,
compass heading, speed camera proximity, trip distance/timer — chosen
specifically because each is either a field already sitting in an API call
this design already makes, or reuses infrastructure the design already
builds. Bigger ideas considered and explicitly deferred as separate future
projects: turn-by-turn navigation (needs a destination-input mechanism +
routing API), notification previews (needs Android's
NotificationListenerService, not reachable via ADB/Termux), weather (needs
a new API integration, low value-to-effort while driving vs. looking
outside).

## Decisions made (with reasoning)

**GPS source: native SDK, not Termux.** `bridge.getAppLocation()` /
`startAppLocationUpdates()` / `onAppLocationChanged()` (documented in
`work-hub/app-development.md` Part 6) gives continuous location with zero
backend involvement. Termux's `termux-location` (used elsewhere in this
app family, e.g. Sensorscope) was considered and rejected for this
feature specifically — it's a one-shot call polled on a timer, slower to
get a fix, and would require Glass Car Dash to gain a Termux dependency it
currently doesn't have at all.

**Speed-limit lookup: direct client-side fetch to OSM Overpass API, no
backend.** Verified live (not assumed) that `overpass-api.de` sends
`Access-Control-Allow-Origin: *` on both preflight and actual requests —
the only data source in this whole app family that doesn't need a backend
proxy to work around missing CORS. This means the feature adds **zero**
new backend code to Glass Car Dash.

**Display location: the existing hidden screen, not a new screen or an
addition to the visible one.** No new gesture needed — reuses exactly the
double-tap-to-hide interaction that already exists. The visible
(play/pause-controls) screen is unchanged.

**Road matching: nearest tagged way within ~100m + a UK default-limit
table**, not full map-matching. Verified live against a real GPS fix that
this correctly resolves a speed limit even when zero nearby roads have an
explicit `maxspeed` tag (the common case for ordinary UK residential
streets — confirmed 0/11 nearby ways were tagged in the test location).
True map-matching (projecting onto the road segment aligned with direction
of travel, to avoid picking a parallel road at a complex junction) was
considered and explicitly rejected as unnecessary complexity for a
driving-info display, not a navigation system.

**Polling: decoupled rates.** Current speed updates on every native
location callback (cheap, device-local). The Overpass lookup only re-fires
when position has moved >100–150m since the last successful lookup, or
after a ~30s fallback timeout (covers sitting stationary at a junction
where the limit differs from the road just traveled). Roads don't change
speed limit every few meters; speed does change continuously — the two
update rates should not be coupled.

**Heading: free, from the same location call.** Checked the SDK's actual
`AppLocation` type (not assumed) — it already has both `speed?: number`
and `heading?: number`. No new API call, no new decision to make; it rides
along with the speed reading already being fetched.

**Glasses battery: free, from a callback already worth having.**
`DeviceStatus` (via `onDeviceStatusChanged`) has `batteryLevel`,
`isCharging`, `isWearing` — checked the actual type, not assumed. Only
`batteryLevel` is rendered (header, next to the connection dot — a
persistent indicator regardless of hide state). `isCharging` is exposed by
`battery.ts` too, cheap enough to also show (e.g. a small `⚡` next to the
%) — in scope for this design since it costs nothing beyond one more
ternary at render time. `isWearing` is explicitly **not** used: showing it
would be pointless (if the glasses aren't being worn, nobody can see the
display to read it), and using it to pause tracking while not worn is a
real possible battery-saving optimization but is future work, not part of
this design.

**Speed camera warning: extends the existing Overpass query, doesn't add a
second one.** OSM tags fixed cameras as nodes with `highway=speed_camera`.
Verified live: `(way(around:100,lat,lon)["highway"]; node(around:1000,lat,lon)["highway"="speed_camera"];)`
is valid Overpass QL, returns both element types in one round trip (tested
result: 11 ways + 0 camera nodes at the test location — zero cameras
nearby is a correct result for a quiet residential street, not a query
failure). Wider radius (1000m) than the road lookup (100m) because a
camera half a kilometre ahead is still actionable information; the nearest
road tag is not useful from that far away. **Not direction-aware for v1**
— a camera behind you triggers the same warning as one ahead; using the
`heading` we're now already collecting to filter to "roughly ahead of
travel direction" is a natural follow-up, explicitly deferred rather than
built now (see Out of scope).

**Trip distance/timer: accumulated from data already flowing through
`speed.ts`.** Every location update already arrives at the >100–150m
movement-check; summing the haversine distance between consecutive fixes
(regardless of whether that update also triggers a new Overpass lookup)
gives trip distance for free. Timer is just wall-clock since tracking
started. No persistence — resets on app restart, same treatment as the
Overpass cache (see Out of scope).

## What was actually tested (not just planned)

1. Overpass CORS headers — confirmed present via `curl -I` with `Origin`
   header, both OPTIONS preflight and actual GET.
2. Node's `fetch()` to Overpass got **HTTP 406** with no custom headers —
   traced to Overpass's anti-abuse filtering rejecting Node's/undici's
   default (non-browser) User-Agent signature.
3. **Real browser context** (Playwright, actual Chrome UA, no header
   spoofing) — succeeded, HTTP 200, real OSM data returned. This is the
   representative test for what the glasses WebView will actually do,
   since WebView is a real browser engine sending its own genuine UA
   (which JS cannot override — `User-Agent` is a forbidden header in the
   Fetch spec, enforced by every browser including WebView).
4. Full matching logic (nearest-way + haversine distance + UK default
   table) run as real in-browser JS against a live GPS fix
   (51.60202673636377, 0.042996564880013466): correctly resolved a 30mph
   limit for the nearest residential road (14m away, 11 candidate ways in
   range, none explicitly tagged) — confirms the fallback-table path
   works end to end, not just the happy path.
5. Combined query (nearby highway ways + wider-radius speed-camera nodes
   in one request) — verified valid Overpass QL against the same live
   fix: 200 OK, 11 ways + 0 camera nodes (correctly zero for this quiet
   residential test location — the query works, this location just has no
   nearby camera to find).
6. Checked `AppLocation` and `DeviceStatus`'s actual type definitions in
   the installed SDK (not assumed from memory): `AppLocation.heading` and
   `DeviceStatus.batteryLevel`/`isCharging`/`isWearing` all genuinely exist.

Conclusion: no backend proxy is needed for this feature, and none of the
groundwork depends on an unverified assumption — every architectural claim
above was checked against a real request/response or the real installed
SDK types, not inferred.

## Components

- **`app/src/osm.ts`** (new) — pure logic, no I/O side effects beyond the
  one `fetch()` call it wraps:
  - `buildOverpassQuery(lat, lon, roadRadiusM, cameraRadiusM)` → query
    string — now the combined form (highway ways + speed-camera nodes in
    one request, verified above)
  - `parseMaxspeed(tag: string | undefined)` → `number | null` (handles
    `"30 mph"`, bare numbers; UK data is virtually always `"NN mph"`)
  - `UK_DEFAULT_LIMITS: Record<string, number>` — the fallback table
    (`motorway`/`_link`: 70, `trunk`/`primary`/`secondary`/`tertiary`/
    `unclassified` + their `_link` variants: 60, `residential`: 30,
    `living_street`: 20)
  - `nearestWay(ways, lat, lon)` → the closest way by haversine distance
    to any of its geometry nodes
  - `nearestCamera(nodes, lat, lon)` → closest speed-camera node + its
    distance, or `null`
  - `lookupDrivingInfo(lat, lon)` → `{ limitMph, limitSource, roadName?,
    highway?, distanceM?, cameraDistanceM: number | null }` — one call,
    one network round trip, both results. Replaces the earlier
    `lookupSpeedLimit` name now that it returns camera info too.
  - Testable in isolation with plain Node + fixture JSON (the fixtures are
    exactly what was captured during live validation above, including the
    zero-camera-found case).

- **`app/src/speed.ts`** (new) — the stateful glue, isolated from
  `osm.ts`'s pure logic:
  - `startSpeedTracking(onUpdate: (state: DrivingState) => void): () => void`
    (returns an unsubscribe/stop function)
  - Wraps `bridge.startAppLocationUpdates()` + `onAppLocationChanged()`
  - Converts location `speed` (m/s) → mph; converts `heading` (degrees)
    → 8-point compass label (N/NE/E/SE/S/SW/W/NW) via a small pure helper
  - Tracks last-lookup position + timestamp; on each location update,
    decides via the >100–150m-or-30s rule whether to call
    `lookupDrivingInfo()` again, or reuse the cached result
  - Accumulates trip distance (haversine sum between consecutive fixes,
    independent of whether that update also triggers a fresh Overpass
    call) and trip duration (wall-clock since tracking started)
  - Never lets a failed/slow Overpass call block the speed/heading/trip
    reading — those update independently of lookup state
  - `DrivingState = { speedMph, heading: CompassLabel | null, limitMph,
    limitSource, cameraDistanceM: number | null, tripMiles, tripDuration }`

- **`app/src/battery.ts`** (new, small) — subscribes to
  `bridge.onDeviceStatusChanged()`, exposes the latest `batteryLevel` (+
  `isCharging`) via a simple callback, same shape as `speed.ts` but far
  smaller — no polling, no lookup, just relaying a value the SDK already
  pushes.

- **`app/src/main.ts`** (existing, small change) — calls
  `startSpeedTracking()` and the battery subscription once (see Open
  Question below); the header renders battery regardless of
  visible/hidden state; the hidden-screen body renders `DrivingState`
  instead of the current blank body.

## Rendering

**Header** (both visible and hidden screens): add battery next to the
existing connection dot, e.g. `Glass Car Dash    ●  87%` (or `⚡87%` while
charging). Small, persistent,
doesn't touch the "minimal" hidden-screen body at all.

**Hidden screen body** — replaces the current blank body. Exact spacing is
an implementation decision, but the content and priority order is:
1. Speed (`"…"` until first fix, then live mph)
2. Limit + heading on one line (e.g. `limit 60 · NE`; limit is `"…"` until
   first lookup resolves, `"?"` if `no-road-found`/`unknown-highway-type`)
3. Camera warning — **conditional, only rendered when `cameraDistanceM` is
   non-null** (e.g. `⚠ camera 400m`). This is the one line that shouldn't
   always be present — the whole point of surfacing it is that it's
   normally absent and therefore meaningful when it appears.
4. Trip distance + timer (e.g. `12.4mi · 18m`) — lowest priority, first
   candidate to drop if the 7-line body zone gets tight once real device
   testing shows how this actually looks.

Footer unchanged: `"tap = show · 2x = exit"`.

## Error handling & edge cases

| Condition | Behavior |
|---|---|
| No GPS fix yet | Show `"…"` for speed, not blank, not an error |
| Overpass unreachable / times out | Keep showing the last successfully-fetched limit/camera state; don't blank it or surface an error — this is a non-critical background enhancement |
| No road found within radius | Speed shown normally; limit shows `"?"` |
| Highway type not in the default table (e.g. `path`, `footway` — shouldn't normally be nearest while driving, but possible) | Same `"?"` treatment as no-road-found |
| No camera within the wider radius (the common case) | Camera line simply isn't rendered — not shown as `"none"` or similar, just absent |
| `heading` field missing from a location update (SDK marks it optional) | Omit the compass label for that update rather than showing a stale/wrong direction |
| Glasses disconnected/status callback never fires | Battery indicator shows `"…"` rather than a stale last-known percentage that could mislead |
| App just switched from visible→hidden | Speed/battery tracking already running (started once, not per-hide) so the hidden screen has data immediately, not a fresh cold-start delay |

## Explicitly out of scope (YAGNI)

- No map-matching / heading-aware road selection for the speed limit
- No direction-awareness for camera warnings (v1 warns regardless of
  whether the camera is ahead or behind — see Decisions above)
- No average-speed enforcement zones (`enforcement=average_speed`,
  more complex relation-based OSM tagging) — fixed-point cameras
  (`highway=speed_camera`) only
- No countries besides UK in the default limit table
- No speeding alerts/warnings beyond the plain camera-proximity line
  (no flashing, no color change, no audio) — display only
- No persisting Overpass responses, trip distance, or trip timer across
  app restarts — in-memory only, everything resets on relaunch
- No custom User-Agent spoofing — unnecessary (validated) and not
  something to build regardless
- Turn-by-turn navigation, notification previews, weather — separate
  future projects, not part of this design (see Problem statement)

## Testing plan

- `osm.ts`: plain-Node unit tests (same style as `test.mts` elsewhere in
  this pattern) using **fixture JSON captured from the live validation
  above** — the real Overpass response for the test coordinates, checked
  into the test file or a fixtures folder. Covers: explicit-tag path,
  default-table path, no-road-found path, `parseMaxspeed` string variants,
  camera-found path, and the zero-camera-found path (already have a real
  fixture for this last one from live testing).
- `speed.ts`: the >100–150m-or-30s decision logic, trip-distance
  accumulation, and heading→compass-label conversion can all be unit
  tested with a fake clock + synthetic location sequence (no real GPS or
  network needed — inject a fake `lookupDrivingInfo` and assert call
  counts / accumulated distance for a scripted sequence of position
  updates).
- `battery.ts`: trivial enough that a unit test mostly just confirms the
  callback plumbing forwards `batteryLevel` correctly.
- End-to-end: real-device verification the same way everything else in
  this project has been verified — a walk outside is enough to confirm
  the plumbing (real GPS fix → real Overpass call → real render) before
  ever needing an actual drive. Camera-warning path specifically needs a
  drive/walk near a known camera location to verify (can't be fully
  confirmed from a stationary test if none are nearby).

## Open question for the implementation plan

`app/src/main.ts` currently has no place to "start something once,
regardless of which screen is showing." The plan should settle whether
`startSpeedTracking()` and the battery subscription begin in `main()` at
app startup (always running, simplest) versus lazily on first hide (saves
a small amount of battery/network when the remote is never hidden, more
state to manage). Given this app runs continuously while driving anyway,
starting at startup is likely simpler with no meaningful downside for
speed tracking — but the battery subscription in particular has no reason
to ever be lazy, since it's shown in the header regardless of screen state
and costs nothing beyond holding a callback. That asymmetry (battery:
always start immediately; speed tracking: probably also always-on, but
worth the plan explicitly deciding) is worth settling explicitly rather
than defaulting silently — but that's a call for the implementation plan,
not this design.
