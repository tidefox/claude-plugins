// ── layout and cells ───────────────────────────────────────────────────────

/** Where the code window starts on its own: the focus a third of the way down. */
export function autoTop(focusAt: number, total: number, rows: number): number {
  return Math.min(Math.max(0, total - rows), Math.max(0, focusAt - Math.floor(rows / 3)))
}

/**
 * The fixed layout's rows, top to bottom: header, gap, the focused block (title,
 * info, code rows), then gap + heading + rows for Files and for Trail, and the
 * key hints.
 */
export function codeLayout(bodyRows: number, fileRows: number, trailRows: number) {
  const codeTop = 4
  return { codeTop, codeRows: Math.max(4, bodyRows - codeTop - (2 + fileRows) - (2 + trailRows) - 1) }
}

// ── cells ──────────────────────────────────────────────────────────────────

/** East Asian Wide and Fullwidth: CJK, and the emoji a terminal draws two cells wide. */
const WIDE =
  /[\u1100-\u115f\u231a-\u231b\u2329-\u232a\u23e9-\u23ec\u23f0\u23f3\u25fd-\u25fe\u2614-\u2615\u2648-\u2653\u267f\u2693\u26a1\u26aa-\u26ab\u26bd-\u26be\u26c4-\u26c5\u26ce\u26d4\u26ea\u26f2-\u26f3\u26f5\u26fa\u26fd\u2705\u270a-\u270b\u2728\u274c\u274e\u2753-\u2755\u2757\u2795-\u2797\u27b0\u27bf\u2b1b-\u2b1c\u2b50\u2b55\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{16fe0}-\u{18cff}\u{1b000}-\u{1b2ff}\u{1f004}\u{1f0cf}\u{1f18e}\u{1f191}-\u{1f19a}\u{1f1e6}-\u{1f1ff}\u{1f200}-\u{1f2ff}\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f7e0}-\u{1f7eb}\u{1f90c}-\u{1f9ff}\u{1fa70}-\u{1faff}\u{20000}-\u{3fffd}]/u
const ZERO = /[\u0300-\u036f\u200b-\u200f\u20d0-\u20ff\ufe00-\ufe0f]/u
const TAB = 4

/** Terminal cells one character takes: two for wide (CJK, emoji), none for a combining mark. */
const charCells = (ch: string) => (ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1)
/** Printable ASCII, a cell a character: most source lines, measured and cut without a look at each character. */
const ASCII = /^[ -~]*$/

export function cellWidth(text: string): number {
  if (ASCII.test(text)) return text.length
  let n = 0
  for (const ch of text) n += charCells(ch)
  return n
}

/** Tabs as spaces to the next stop, so a line's width is known before it is drawn. */
export function expandTabs(text: string): string {
  if (!text.includes('\t')) return text
  let out = ''
  let col = 0
  for (const ch of text) {
    if (ch === '\t') {
      const pad = TAB - (col % TAB)
      out += ' '.repeat(pad)
      col += pad
    } else {
      out += ch
      col += charCells(ch)
    }
  }
  return out
}

/** A line cut into rows of `room` cells, as a terminal wraps it: never none, a wide character never split. */
export function wrapCells(text: string, room: number): string[] {
  if (ASCII.test(text)) {
    if (text.length <= room) return [text]
    return Array.from({ length: Math.ceil(text.length / room) }, (_, i) => text.slice(i * room, (i + 1) * room))
  }
  const rows: string[] = []
  let row = ''
  let col = 0
  for (const ch of text) {
    const w = charCells(ch)
    if (col + w > room && col > 0) {
      rows.push(row)
      row = ''
      col = 0
    }
    row += ch
    col += w
  }
  rows.push(row)
  return rows
}

/** `text` in at most `room` cells: cut at the end with `…`. */
export function clip(text: string, room: number): string {
  if (cellWidth(text) <= room) return text
  if (room <= 1) return room === 1 ? '…' : ''
  let out = ''
  let col = 0
  for (const ch of text) {
    const w = charCells(ch)
    if (col + w > room - 1) break
    out += ch
    col += w
  }
  return `${out}…`
}

/** `text` in at most `room` cells: cut at the start with `…`, its end kept. */
export function clipStart(text: string, room: number): string {
  if (cellWidth(text) <= room) return text
  if (room <= 1) return room === 1 ? '…' : ''
  let out = ''
  let col = 0
  for (const ch of Array.from(text).reverse()) {
    const w = charCells(ch)
    if (col + w > room - 1) break
    out = ch + out
    col += w
  }
  return `…${out}`
}

/** A path in at most `room` cells: its first directory and file name kept, the directories between elided from the middle. */
export function shortenPath(path: string, room: number): string {
  if (cellWidth(path) <= room) return path
  const dirs = path.split('/')
  const name = dirs.pop() ?? ''
  for (let keep = dirs.length - 2; keep >= 0; keep--) {
    const short = [dirs[0], '…', ...dirs.slice(dirs.length - keep), name].join('/')
    if (cellWidth(short) <= room) return short
  }
  const bare = `…/${name}`
  return dirs.length > 0 && cellWidth(bare) <= room ? bare : clipStart(path, room)
}

/**
 * One row of the code window: a piece of a line, the line's numbers on either side and its diff
 * marker; or, between two hunks of a diff, a gap.
 */
export type CodeRow = { line: number; part: number; text: string; t: ' ' | '-' | '+'; old: number; new: number; isGap?: true; whole?: string; offset?: number }

/** Lines hard-wrapped to `room` cells, tabs expanded: one CodeRow per row the window draws, a gap where the hunk changes. */
export function wrapRows(lines: { text: string; t: CodeRow['t']; old: number; new: number; hunk?: number }[], room: number): CodeRow[] {
  const rows: CodeRow[] = []
  lines.forEach((l, line) => {
    const before = lines[line - 1]
    if (before && before.hunk !== l.hunk) rows.push({ line, part: 0, text: '⋯', t: ' ', old: 0, new: 0, isGap: true })
    const whole = expandTabs(l.text)
    const parts = wrapCells(whole, Math.max(1, room))
    // A wrapped line keeps its whole text and where each piece starts, so the piece is drawn cut from the highlighted line.
    let offset = 0
    parts.forEach((text, part) => {
      rows.push({ line, part, text, t: l.t, old: l.old, new: l.new, ...(parts.length > 1 ? { whole, offset } : {}) })
      offset += cellWidth(text)
    })
  })
  return rows
}

/** A scrollbar's thumb over `rows` cells for a window at `top` of `total`: where it starts and how long. */
export function thumb(top: number, total: number, rows: number): { from: number; size: number } {
  if (total <= rows) return { from: 0, size: rows }
  const size = Math.max(1, Math.round((rows * rows) / total))
  const from = Math.round((top / (total - rows)) * (rows - size))
  return { from: Math.min(rows - size, Math.max(0, from)), size }
}
