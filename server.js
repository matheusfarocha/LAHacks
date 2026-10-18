// Glass Car Dash backend (zero deps). Sends media keyevents via the phone's
// own adb client (connected to itself over wireless debugging) so tapping
// the glasses can play/pause/skip whatever's actually playing on the phone.
//
//   node --env-file=.env server.js
import http from 'node:http';
import { getStatus, sendAction } from './api/_lib/media.js';
import { appendDebugLog, debugLoggingEnabled } from './api/_lib/debug-log.js';
import { getPhoneStatus } from './api/_lib/phone.js';

const PORT = process.env.PORT || 8790;
const KEY = process.env.REMOTE_KEY;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(Object.assign(new Error('bad json body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'x-remote-key, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (u.pathname === '/api/health') return send(res, 200, { ok: true });

  // Write actions are deny-by-default, key only via the custom header — same
  // reasoning as every other app in this pattern: a custom header forces a
  // CORS preflight, so a random page reaching this LAN/localhost port can't
  // fire a media command (or spam the debug log) cross-origin.
  const isMediaAction = req.method === 'POST' && u.pathname === '/api/media/action';
  const isDebugLog = req.method === 'POST' && u.pathname === '/api/debug/log';
  if (isMediaAction || isDebugLog) {
    if (!KEY) return send(res, 401, { ok: false, error: 'auth required (set REMOTE_KEY)' });
    if (req.headers['x-remote-key'] !== KEY) return send(res, 401, { ok: false, error: 'bad key' });
  } else if (KEY) {
    const got = req.headers['x-remote-key'] || u.searchParams.get('key');
    if (got !== KEY) return send(res, 401, { ok: false, error: 'bad key' });
  }

  try {
    let data;
    if (req.method === 'GET' && u.pathname === '/api/media/status') {
      data = await getStatus();
    } else if (req.method === 'GET' && u.pathname === '/api/phone/status') {
      data = await getPhoneStatus();
    } else if (isMediaAction) {
      data = await sendAction(await readJson(req));
    } else if (isDebugLog) {
      // Silently no-ops unless DEBUG_LOG=1 is set — see api/_lib/debug-log.js.
      await appendDebugLog(await readJson(req));
      data = { logged: debugLoggingEnabled() };
    } else {
      return send(res, 404, { ok: false, error: 'not found' });
    }
    send(res, 200, { ok: true, data, fetchedAt: Date.now() });
  } catch (e) {
    console.error('[' + req.method + ' ' + u.pathname + ']', e.message);
    send(res, e.status || 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`Glass Car Dash backend -> http://0.0.0.0:${PORT}  (key ${KEY ? 'required' : 'DISABLED - set REMOTE_KEY'})`);
  if (debugLoggingEnabled()) console.log('Debug logging ENABLED -> ~/glass-car-dash-debug.log');
});
