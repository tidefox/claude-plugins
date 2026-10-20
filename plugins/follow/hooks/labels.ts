import type { Activity } from '../types'
import { relative } from './capture'
import { clip, shortenPath } from './layout'
import { oneLine } from './text'

/** A command as the footer names it: its program and first word after, past `VAR=x` and `cd dir &&`. */
export function footerWhat(label: string): string {
  const words = oneLine(label.replace(/^.*?&&\s*/, '')).split(' ').filter(w => !/^\w+=/.test(w))
  return clip(words.slice(0, 2).join(' '), 24)
}

export const shortPath = (a: Activity) =>
  a.path === null ? oneLine(a.label) : `${relative(a.path)}${a.line ? `:${a.line}${a.endLine && a.endLine > a.line ? `-${a.endLine}` : ''}` : ''}`

export function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

/** An activity's path:line (or its one-line label) in at most `room` cells, its file name kept. */
export const fitActivity = (a: Activity, room: number) => (a.path === null ? clip(oneLine(a.label), room) : shortenPath(shortPath(a), room))
