import type { MediaStatus, ActionResult } from './types'

export interface PhoneStatus {
  levelPct: number | null
  charging: boolean
}

const BASE = import.meta.env.VITE_API_BASE || ''
const KEY = import.meta.env.VITE_API_KEY || ''

async function call<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers as Record<string, string>) }
  if (KEY) headers['x-remote-key'] = KEY
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let r: Response
  try {
    r = await fetch(`${BASE}/api/${path}`, { ...init, headers, signal: ac.signal })
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('timed out')
    throw e
  } finally {
    clearTimeout(timer)
  }
  const j = await r.json().catch(() => ({ ok: false, error: 'bad json' }))
  if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`)
  return j.data as T
}

export const api = {
  status: () => call<MediaStatus>('media/status', {}, 6_000),
  phoneStatus: () => call<PhoneStatus>('phone/status', {}, 6_000),
  send: (id: string) =>
    call<ActionResult>('media/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }, 8_000),
  // Fire-and-forget: opt-in diagnostic logging, silently a no-op on the
  // backend unless DEBUG_LOG=1 is set there (see api/_lib/debug-log.js).
  // Must never throw — a logging failure can't be allowed to affect the
  // actual feature.
  debugLog: (event: Record<string, unknown>): void => {
    void call('debug/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) }, 4_000).catch(() => {})
  },
}
