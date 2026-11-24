import { atom, read } from 'claude-code'
import type { EngineInterface, RenderInput, Timer } from 'claude-code'

import type { Activity } from '../types'

// The engine reads a file's state by scanning it, so each file that reads these declares them itself.
const activities = atom({ plugin: 'follow', key: 'activities' } as const, [])

/**
 * The underlay behind the fullscreen transcript: lines of what the agent last
 * read or changed rise slowly through the blank cells and fade out. The engine
 * shows a glyph only where the interface left a cell empty, and draws no
 * underlay under reduced motion or a screen reader.
 */
export const DRIFT_SITE = 'site:underlay'
export const DRIFT_KEY = 'drift'
export const TICK_MS = 125
/** Ticks a line takes to rise one row: half a second at 125 ms. */
export const RISE_TICKS = 4
/** Ticks between new lines while the agent works. */
export const SPAWN_TICKS = 12
/** A line's life in ticks, split in three steps of fading. */
export const LIFE_TICKS = 96
const MAX_MOTES = 10
const MAX_TEXT = 48

const DEFAULT = 0x01000000
/** Faint, then fainter: a change in amber, anything else in blue. */
const TONES = { change: [0x6a5428, 0x4a3b1c, 0x2c2311], other: [0x2e4766, 0x203247, 0x131d2a] } as const

type Mote = { text: string; x: number; y: number; age: number; tone: keyof typeof TONES }

const drift = { columns: 0, rows: 0, isWorking: false, tick: 0, motes: [] as Mote[], timer: null as Timer | null }

/** Claude is at work: lines start drifting, the ticking started if it stopped. */
export function wakeDrift($: EngineInterface) {
  drift.isWorking = true
  // Never in the way of following the call itself: a host with no clock just has no drift.
  try {
    drift.timer ??= $.clock.every(TICK_MS, () => void step($).catch(() => {}))
  } catch {}
}

/** The turn ended: no new lines; the ticking stops once the last one has gone. */
export function restDrift() {
  drift.isWorking = false
}

function stop() {
  drift.timer?.cancel()
  drift.timer = null
}

/** The whole window's cells, row-major, as RasterProps packs them. */
export function frame(columns: number, rows: number, motes: readonly Mote[]): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < words.length; i += 3) (words[i] = 0x20, (words[i + 1] = DEFAULT), (words[i + 2] = DEFAULT))
  for (const m of motes) {
    if (m.y < 0 || m.y >= rows) continue
    const color = TONES[m.tone][Math.min(2, Math.floor((m.age * 3) / LIFE_TICKS))]!
    for (let k = 0; k < m.text.length && m.x + k < columns; k++) {
      const ch = m.text.charCodeAt(k)
      // Printable ASCII alone: a raster cell holds one width-1 character, and a space stays unpainted.
      if (ch < 0x21 || ch > 0x7e) continue
      const at = (m.y * columns + m.x + k) * 3
      words[at] = ch
      words[at + 1] = color
    }
  }
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** A line of what the agent last touched: an edit's added lines, a read's lines, a command's output. */
function source(list: readonly Activity[]): { lines: string[]; tone: Mote['tone'] } | null {
  for (const a of list) {
    const v = a.view
    if (v === null) continue
    const tone = a.kind === 'edit' || a.kind === 'write' ? 'change' : 'other'
    const lines =
      v.mode === 'diff'
        ? v.hunk.split('\n').filter(l => l.startsWith('+')).map(l => l.slice(1))
        : v.mode === 'source'
          ? v.lines.slice(Math.max(0, v.focusFrom - v.startLine), v.focusTo - v.startLine + 1)
          : v.lines
    const shown = lines.map(l => l.trim().slice(0, MAX_TEXT)).filter(l => l.length >= 4)
    if (shown.length > 0) return { lines: shown, tone }
  }
  return null
}

/** One tick: lines rise and fade, a new one starts while the agent works; repaints only on a change. */
export async function step($: EngineInterface) {
  const { columns, rows } = drift
  // No underlay drawn (not the fullscreen layout, not a terminal), or nothing left to move.
  if (columns === 0 || (!drift.isWorking && drift.motes.length === 0)) return stop()
  drift.tick++
  // Every line rises on the same tick, so the window repaints at most twice a second however many drift.
  const isRise = drift.tick % RISE_TICKS === 0 && drift.motes.length > 0
  for (const m of drift.motes) {
    m.age++
    if (isRise) m.y--
  }
  let isDirty = isRise
  const alive = drift.motes.filter(m => m.y >= 0 && m.age < LIFE_TICKS)
  if (alive.length !== drift.motes.length) isDirty = true
  drift.motes = alive
  if (drift.isWorking && drift.tick % SPAWN_TICKS === 0 && alive.length < MAX_MOTES) {
    const from = source(await read($, activities))
    if (from) {
      const text = from.lines[Math.floor(Math.random() * from.lines.length)]!
      const x = Math.floor(Math.random() * Math.max(1, columns - text.length))
      drift.motes.push({ text, x, y: rows - 1, age: 0, tone: from.tone })
      isDirty = true
    }
  }
  if (!isDirty) return
  const done = await $.ui.blit({ requestId: DRIFT_SITE, key: DRIFT_KEY, cells: frame(columns, rows, drift.motes), columns, rows }).catch(() => ({ deny: 'failed' }))
  // Not mounted any more (the layout left fullscreen): idle until the next draw sizes it again.
  if ('deny' in done && done.deny) (drift.columns = 0)
}

/** Follow's own underlay layer: the frame as it stands, the ticking started once. */
export function renderDrift($: EngineInterface, e: Extract<RenderInput, { component: 'Underlay'; surface: 'terminal' }>) {
  const { Raster } = $.ui.resolve(e)
  const columns = Math.min(512, Math.max(1, e.props.columns))
  const rows = Math.min(256, Math.max(1, e.props.rows))
  if (columns !== drift.columns || rows !== drift.rows) drift.motes = drift.motes.filter(m => m.y < rows)
  Object.assign(drift, { columns, rows })
  return <Raster key={DRIFT_KEY} columns={columns} rows={rows} cells={frame(columns, rows, drift.motes)} />
}
