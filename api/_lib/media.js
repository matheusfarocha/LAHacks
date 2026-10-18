// Glass Car Dash backend: media control via ADB keyevents, routed through
// Termux's own adb client connected to this same phone over wireless
// debugging (paired once via Settings -> Developer options -> Wireless
// debugging -> Pair with pairing code, then `adb connect <ip>:<port>` for
// the actual debug session — the connect port rotates across
// reboots/reconnects, pairing itself does not need repeating).
//
// Every action is a fixed Android KeyEvent code from a hardcoded allowlist —
// the client only ever sends an action id, never a code or arbitrary adb
// argv, so there is no injection surface here either.
import { spawn } from 'node:child_process';

const ADB_TIMEOUT_MS = 8000;

// developer.android.com/reference/android/view/KeyEvent
const ACTIONS = {
  play_pause: { code: '85', label: 'Play/Pause' },
  next: { code: '87', label: 'Next track' },
  previous: { code: '88', label: 'Previous track' },
};

function err(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function runAdb(args) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('adb', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '', errOut = '';
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      reject(err(504, 'adb timed out'));
    }, ADB_TIMEOUT_MS);
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { errOut += c; });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(err(502, errOut.trim() || `adb exited ${code}`));
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// Exactly one authorized ("...\tdevice", not "unauthorized"/"offline")
// connected device is required — plain `adb shell` with no -s target is
// only unambiguous when there's just one.
export async function checkConnected() {
  const out = await runAdb(['devices']);
  const lines = out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  const ready = lines.filter((l) => l.endsWith('\tdevice'));
  if (ready.length === 1) return { ok: true, serial: ready[0].split('\t')[0] };
  if (lines.length === 0) {
    return { ok: false, reason: 'no device connected — run `adb connect <ip>:<port>` (check Settings > Developer options > Wireless debugging for the current port; it rotates)' };
  }
  return { ok: false, reason: `expected exactly 1 ready device, found: ${lines.join('; ')}` };
}

export function listActions() {
  return Object.entries(ACTIONS).map(([id, a]) => ({ id, label: a.label }));
}

// Best-effort now-playing title, parsed from `dumpsys media_session` — an
// undocumented debug dump, not a stable API, so this degrades to nulls
// rather than erroring if the format doesn't match what was verified live
// against a real device (Pixel 9 Pro, Android build current as of 2026-07).
// "Media button session is X" identifies which package our own keyevents
// actually target — that's the session whose metadata is worth showing,
// not just whichever happens to be first/active, since multiple apps
// (e.g. a paused video app) can hold a session at once.
async function getNowPlaying() {
  try {
    const out = await runAdb(['shell', 'dumpsys', 'media_session']);
    const targetMatch = out.match(/Media button session is ([^\s/]+)\//);
    const targetPkg = targetMatch ? targetMatch[1] : null;
    if (!targetPkg) return { title: null, playing: null };

    const blocks = out.split(/\n(?=    \S.*\(userId=\d+\))/);
    const block = blocks.find((b) => b.includes(`package=${targetPkg}`));
    if (!block) return { title: null, playing: null };

    const stateMatch = block.match(/state=PlaybackState \{state=(\w+)\(/);
    const playing = stateMatch ? stateMatch[1] === 'PLAYING' : null;

    // `description=<title>, <subtitle>, <artist>` — verified live against
    // two real shapes: "Frank's Pretty Woman, S7:E1 - ..., null" (video, no
    // artist) and "Skepta - Nasty, Skepta, Skepta" (music, artist repeated
    // in both subtitle and artist position, AND already folded into the
    // title). The last field is the most reliable "artist" signal; the
    // middle one is too inconsistent (sometimes artist, sometimes an
    // episode subtitle) to use on its own.
    const metaMatch = block.match(/metadata: size=\d+, description=(.*)/);
    let title = null;
    let artist = null;
    if (metaMatch) {
      const parts = metaMatch[1].trim().split(',').map((s) => s.trim());
      title = parts[0] || null;
      if (title === 'null') title = null;
      const last = parts[parts.length - 1];
      if (last && last !== 'null' && last.toLowerCase() !== (title || '').toLowerCase()) artist = last;
    }
    return { title, artist, playing };
  } catch {
    return { title: null, artist: null, playing: null };
  }
}

export async function getStatus() {
  const status = await checkConnected();
  const nowPlaying = status.ok ? await getNowPlaying() : { title: null, artist: null, playing: null };
  return { connected: status.ok, serial: status.serial || null, reason: status.reason || null, actions: listActions(), nowPlaying };
}

export async function sendAction(input) {
  const id = String(input?.id || '');
  const action = ACTIONS[id];
  if (!action) throw err(404, 'unknown action: ' + id);

  const status = await checkConnected();
  if (!status.ok) throw err(409, status.reason);

  await runAdb(['shell', 'input', 'keyevent', action.code]);
  return { action: id, label: action.label, sentAt: Date.now() };
}
