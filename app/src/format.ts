export function padHeader(left: string, right: string): string {
  const gap = Math.max(1, 46 - left.length - right.length)
  return left + ' '.repeat(gap) + right
}

export function timeAgo(ms: number): string {
  if (!ms) return ''
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 1) return 'now'
  if (s < 60) return `${s}s ago`
  return `${Math.round(s / 60)}m ago`
}

// Trip timer: "18m" under an hour, "1h 05m" once it crosses one.
export function tripDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}h ${String(m).padStart(2, '0')}m`
}
