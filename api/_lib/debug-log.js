// Opt-in diagnostic logging for real-drive debugging. Off by default (set
// DEBUG_LOG=1 in .env to enable) — this app's stated privacy posture is
// "no location/speed history persisted anywhere" (see README/STORE_LISTING),
// so this must never write anything unless explicitly turned on for a
// deliberate debugging session, and turned back off afterward.
//
// Appends one JSON line per event to ~/glass-car-dash-debug.log so a whole
// drive's worth of GPS fixes + every candidate road considered (not just
// the winner) can be pulled after the fact and used to tune the matching
// algorithm against real data instead of guesswork.
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Lives in $HOME (a sibling of the existing glass-car-dash.log — see
// start.sh), not inside the repo checkout — keeps it out of `git status`
// entirely, so collected location data can never get swept into a commit.
const LOG_PATH = path.join(os.homedir(), 'glass-car-dash-debug.log');

export function debugLoggingEnabled() {
  return process.env.DEBUG_LOG === '1';
}

export async function appendDebugLog(event) {
  if (!debugLoggingEnabled()) return;
  const line = JSON.stringify({ ...event, receivedAt: Date.now() }) + '\n';
  await appendFile(LOG_PATH, line);
}
