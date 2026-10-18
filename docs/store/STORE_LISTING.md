# Even Hub store listing — Glass Car Dash

Everything needed to fill out the store listing checklist at
`hub.evenrealities.com` (Store listing tab), kept here so the GitHub repo and
the hub listing stay consistent with each other.

## 1. Personal Information

This is an account-level field on the hub (tied to your developer account,
not the app), so it can't be templated here — fill it in directly on the
portal. For reference, the values that match this app's `author` field:

- **Developer name:** Usman Kayani
- **Contact email:** usmankayaniphd@gmail.com

## 2. App icon

Already set (checklist shows a checkmark) — no action needed.

## 3. Cover and screenshots

Three images are in this folder:

- [`hero.png`](hero.png) — stylized cover/marketing image: the HUD overlaid
  on an illustrated night-driving scene, in the style of other Even Hub
  store listings (e.g. Navigaze). **Use this as the cover image.** It's a
  mockup, not a device capture — built to sell the concept at a glance, the
  same way an app icon or a feature graphic isn't a literal screenshot
  either.
- [`screenshot-dashboard.png`](screenshot-dashboard.png) and
  [`screenshot-camera-warning.png`](screenshot-camera-warning.png) — actual
  on-device UI, captured from the **official
  `@evenrealities/evenhub-simulator`** (its `/api/screenshot/glasses`
  automation endpoint — the real 576×288 glasses framebuffer render, not a
  browser approximation). Use these as the supporting screenshots, so the
  listing shows both the pitch (hero) and the real thing (these two).

All three use placeholder demo values for speed/limit/heading/road name
(42 mph, limit 30, heading NE, "Underwood Road" / a 240m camera warning)
set temporarily for the captures — the real app starts blank/pending until
GPS and the Overpass lookup return real data, and the simulator can't
produce that itself (its console log shows `unknown variant
'startAppLocationUpdates'` — it doesn't implement the SDK's location APIs).
The now-playing title and phone battery %, on the other hand, are real —
whatever the backend actually saw on the connected phone at capture time.

## 4. App description

**Short/tagline** (matches `app.json`'s `tagline`, 80 char limit):
> Speed, limit, camera warnings, media — tap to play/pause, swipe to skip

**Full description**, written in the punchy bold-feature-header style used
by other Even Hub listings:

> A driving dashboard and media remote for the Even Realities G2 — hands-free,
> right in your view.
>
> **Speed and limit, always visible.** Your current speed and the local
> speed limit — shown as a real circular road-sign graphic — sit on the
> right side of the display, sourced live from OpenStreetMap as you drive.
>
> **Speed camera warnings.** Nearby fixed speed cameras surface
> automatically, with distance, so there's no surprise.
>
> **Heading and road name, at a glance.** A compass label and the name of
> the road you're on sit alongside your speed.
>
> **Hands-free media control.** Tap to play/pause, swipe up/down for
> next/previous — works with whatever's playing (Spotify, YouTube Music,
> podcasts, anything), no app-specific integration needed, and shows the
> current track title when it can.
>
> **Both batteries at a glance.** Glasses and phone battery both show in
> the header, so you know which one needs charging first.
>
> **Free, open data, no accounts.** Works with no login and no API keys —
> OpenStreetMap's public Overpass API (with automatic fallback to two free
> mirrors if the primary is busy) for speed limits/cameras, and your own
> phone's ADB for media control. Nothing is sent to any server the developer
> controls. Full source and one-command setup at
> [github.com/drrobotk/glass-car-dash](https://github.com/drrobotk/glass-car-dash).

## 5. Permissions

Already set (checklist shows a checkmark) — declared in `app/app.json`:

| Permission | Why |
|---|---|
| `location` | Reads current speed/heading and looks up the local speed limit for your position |
| `network` (whitelist: `127.0.0.1:8790`, `overpass-api.de`, `maps.mail.ru`, `overpass.osm.ch`) | Talks to your own Termux backend (media control) and the public OSM Overpass API — primary plus two free mirrors tried in order as fallback if the primary is rate-limited (confirmed this happens under real use) |

## 6. Privacy and terms

Draft policy text — accurate as of this app's actual architecture (verified
against the source, not boilerplate):

> **Privacy**
>
> Glass Car Dash does not collect, store, or transmit any personal data to
> its developer or any third party controlled by the developer. There is no
> account system, no analytics, and no advertising.
>
> The app makes exactly two kinds of network request, both described in its
> declared permissions — everything else (phone battery, now-playing track
> title) is read from your own phone by your own backend and never leaves
> the device either:
>
> 1. **Location lookups** — your device's GPS coordinates (latitude/
>    longitude only) are sent directly from your phone to OpenStreetMap's
>    public Overpass API (`overpass-api.de`, or one of two free mirrors —
>    `maps.mail.ru`, `overpass.osm.ch` — tried in order only if the primary
>    doesn't respond) to determine the local speed limit and nearby speed
>    cameras. This is a read-only public map query; no identifying
>    information accompanies it beyond the coordinates themselves, and each
>    service's own privacy policy governs that request.
> 2. **Media control** — play/pause/next/previous commands are sent to a
>    backend that you run yourself, on your own phone, in Termux. It listens
>    only on `127.0.0.1` (the phone's own loopback interface) — this traffic
>    never leaves your device.
>
> The same local backend also reads two things directly from Android and
> serves them to the display over that same loopback connection, never
> anywhere else: your phone's battery percentage (`termux-battery-status`),
> and the title of whatever's currently playing, if the app publishes it
> (`dumpsys media_session`) — best-effort only, since that's an
> undocumented system dump, not a stable API.
>
> No trip data, speed history, location history, or now-playing history is
> persisted anywhere; trip distance/timer and the current track title exist
> only in memory for the current session and are discarded when the app
> closes.
>
> **Terms**
>
> Provided as-is, for personal use, with no warranty. Source code is public
> at <https://github.com/drrobotk/glass-car-dash> under the MIT license.
