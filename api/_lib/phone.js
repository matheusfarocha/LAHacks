// Phone battery via Termux:API's `termux-battery-status` (already a listed
// dependency for this app — see README). Degrades to nulls rather than an
// error if Termux:API isn't installed or the permission wasn't granted —
// this is a nice-to-have display, never something that should break the
// backend or the rest of the response.
import { spawn } from 'node:child_process';

const TIMEOUT_MS = 5000;

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '', errOut = '';
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      reject(new Error(`${cmd} timed out`));
    }, TIMEOUT_MS);
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { errOut += c; });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(errOut.trim() || `${cmd} exited ${code}`));
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function getPhoneStatus() {
  try {
    const out = await runCommand('termux-battery-status', []);
    const json = JSON.parse(out);
    return {
      levelPct: typeof json.percentage === 'number' ? json.percentage : null,
      charging: json.status === 'CHARGING' || json.status === 'FULL',
    };
  } catch {
    return { levelPct: null, charging: false };
  }
}
