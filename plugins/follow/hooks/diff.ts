import { HUNK_CAP, HUNK_CONTEXT } from './state'

type Op = { t: ' ' | '-' | '+'; line: string }

/** Past this many cells the middle is diffed as one block, not aligned line by line. */
const MAX_DIFF_CELLS = 4_000_000

/** A line-by-line alignment (LCS) of `a` and `b`: each change's removals before its additions. */
function align(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n * m > MAX_DIFF_CELLS) return [...a.map(line => ({ t: '-' as const, line })), ...b.map(line => ({ t: '+' as const, line }))]
  // lcs[i * (m + 1) + j]: the longest common run of a[i..] and b[j..].
  const lcs = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] =
        a[i] === b[j] ? lcs[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i++]! })
      j++
    } else if (j >= m || (i < n && lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!)) {
      ops.push({ t: '-', line: a[i++]! })
    } else {
      ops.push({ t: '+', line: b[j++]! })
    }
  }
  return ops
}

/**
 * Unified-diff hunks of what differs between `before` and `after`, lines aligned
 * as `git diff` does, with `context` unchanged lines around each change; hunks
 * whose context would meet are merged. At most `cap` body lines are drawn, each
 * header counting exactly the lines under it.
 */
export function buildHunk(
  before: string[],
  after: string[],
  context = HUNK_CONTEXT,
  cap = HUNK_CAP,
): { hunk: string; line: number; isCut: boolean; added: number; removed: number } | null {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }
  if (head === before.length && head === after.length) return null

  const lead = before.slice(Math.max(0, head - context), head)
  const ops: Op[] = [
    ...lead.map(line => ({ t: ' ' as const, line })),
    ...align(before.slice(head, before.length - tail), after.slice(head, after.length - tail)),
    ...before.slice(before.length - tail, before.length - tail + context).map(line => ({ t: ' ' as const, line })),
  ]
  const added = ops.filter(o => o.t === '+').length
  const removed = ops.filter(o => o.t === '-').length

  // Each op's line number on either side.
  const first = head - lead.length + 1
  const at: { old: number; new: number }[] = []
  let oldNo = first
  let newNo = first
  for (const o of ops) {
    at.push({ old: oldNo, new: newNo })
    if (o.t !== '+') oldNo++
    if (o.t !== '-') newNo++
  }

  // Spans of ops to draw: each change with its context, merged where they meet.
  const spans: [number, number][] = []
  ops.forEach((o, k) => {
    if (o.t === ' ') return
    const from = Math.max(0, k - context)
    const to = Math.min(ops.length, k + context + 1)
    const last = spans[spans.length - 1]
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else spans.push([from, to])
  })

  const hunks: string[] = []
  let room = cap
  let isCut = false
  for (const [from, full] of spans) {
    if (room <= 0) {
      isCut = true
      break
    }
    const to = Math.min(full, from + room)
    if (to < full) isCut = true
    const body = ops.slice(from, to)
    room -= body.length
    const oldCount = body.filter(o => o.t !== '+').length
    const newCount = body.filter(o => o.t !== '-').length
    const start = at[from]!
    // An empty side names the line before it, as diff does.
    const range = (line: number, count: number) => `${count === 0 ? line - 1 : line},${count}`
    hunks.push(
      [`@@ -${range(start.old, oldCount)} +${range(start.new, newCount)} @@`, ...body.map(o => `${o.t}${o.line}`)].join('\n'),
    )
  }

  const firstChange = ops.findIndex(o => o.t !== ' ')
  return { hunk: hunks.join('\n'), line: at[firstChange]!.new, isCut, added, removed }
}

export type DiffRow = { t: ' ' | '-' | '+'; text: string; old: number; new: number; hunk: number }

/** A diff's body rows, each with the line numbers it stands at on either side. */
export function diffRows(hunks: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  let hunk = -1
  for (const row of hunks.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row)
    if (header) {
      hunk++
      // An empty side names the line before it.
      oldNo = Number(header[1]) + (header[2] === '0' ? 1 : 0)
      newNo = Number(header[3]) + (header[4] === '0' ? 1 : 0)
      continue
    }
    const t = row[0]
    if (hunk < 0 || (t !== ' ' && t !== '-' && t !== '+')) continue
    rows.push({ t, text: row.slice(1), old: oldNo, new: newNo, hunk })
    if (t !== '+') oldNo++
    if (t !== '-') newNo++
  }
  return rows
}
