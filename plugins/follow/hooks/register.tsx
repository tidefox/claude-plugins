import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Activity, ActivityKind, FileView } from '../types'

const PANE = 'follow'
/** The dock width asked for beside a fullscreen transcript; the person's own drag wins. */
const SIDEBAR_COLUMNS = 64
/** Docking is the surface's call: only the fullscreen layout from this width docks a pane. */
const DOCK_MIN_COLUMNS = 110
const MAX_ACTIVITIES = 80
/** Only the newest few keep their file excerpt, so the state stays small. */
const MAX_VIEWS = 12
const READ_WINDOW = 120
const EDIT_CONTEXT = 12
const HUNK_CONTEXT = 3
const HUNK_CAP = 400
const MAX_FILE_CHARS = 4_000_000
const TRAIL_ROWS = 6
const FILE_ROWS = 6
/** Rows a wheel tick or j/k moves the code window. */
const SCROLL_STEP = 3

const activities = atom({ plugin: 'follow', key: 'activities' } as const, [])
const pinned = atom({ plugin: 'follow', key: 'pinned' } as const, null)
const scroll = atom({ plugin: 'follow', key: 'scroll' } as const, null)
/** How far the person scrolled the Files and Trail lists, in rows from the newest. */
const lists = atom({ plugin: 'follow', key: 'lists' } as const, { files: 0, trail: 0 })

const BADGE: Record<ActivityKind, { label: string; color: string }> = {
  read: { label: 'READ', color: 'suggestion' },
  edit: { label: 'EDIT', color: 'warning' },
  write: { label: 'WRITE', color: 'success' },
  search: { label: 'SEARCH', color: 'ide' },
  shell: { label: 'SHELL', color: 'bashBorder' },
  plan: { label: 'PLAN', color: 'planMode' },
  web: { label: 'WEB', color: 'permission' },
  agent: { label: 'AGENT', color: 'claude' },
  other: { label: 'TOOL', color: 'inactive' },
}
/** How long a finished call stays in the footer. */
const LINGER_MS = 8000
/** A command as the footer names it: its program and first word after, past `VAR=x` and `cd dir &&`. */
export function footerWhat(label: string): string {
  const words = oneLine(label.replace(/^.*?&&\s*/, '')).split(' ').filter(w => !/^\w+=/.test(w))
  return clip(words.slice(0, 2).join(' '), 24)
}
const LETTER: Partial<Record<ActivityKind, string>> = { read: 'R', edit: 'E', write: 'W' }

// ── pure helpers (exported for the tests) ──────────────────────────────────

export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The 1-based line `index` falls on. */
export function lineOf(text: string, index: number): number {
  let n = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

export const isScratchPath = (path: string) => /\/scratchpad(\/|$)/.test(path) || /^\/tmp\/claude-/.test(path)

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

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2')

/**
 * The command with heredoc bodies dropped and each quoted string swapped for a
 * placeholder, so a `>` or `|` inside a message or a pattern is not read as shell.
 */
function mask(command: string): { masked: string; restore: (s: string) => string } {
  const quoted: string[] = []
  const masked = command
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\s|\)|$)/g, '$3')
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, q => `\u0001${quoted.push(q) - 1}\u0001`)
  return { masked, restore: s => unquote(s.replace(/\u0001(\d+)\u0001/g, (_, k: string) => quoted[Number(k)] ?? '')) }
}

type ShellAccess = { kind: 'read' | 'write'; path: string; from?: number; to?: number; dir?: string }

/**
 * What a shell command does to a file, for the common read and write spellings
 * (`cat`, `head`, `tail`, `sed -n A,Bp`, `nl`, `bat`; `>`, `>>`, `tee`). Null otherwise.
 * `dir` is a leading `cd <dir>`, which a relative path is read against.
 */
export function parseShell(command: string): ShellAccess | null {
  const found = matchShell(command)
  // A path held in a shell variable cannot be followed.
  if (!found || found.path === '' || /[$`*?\u0001]/.test(found.path)) return null
  if (/^~?\//.test(found.path)) return found
  const dir = shellDir(command)
  if (dir === null) return null
  return dir === undefined ? found : { ...found, dir }
}

/**
 * The directory a command's relative paths are read against: a leading `cd
 * <dir>`, undefined with no cd at all, null when a cd cannot be followed (a
 * variable, `~`, `-`, or one further on) and a relative path is somewhere unknown.
 */
export function shellDir(command: string): string | null | undefined {
  const { masked, restore } = mask(command)
  const cds = masked.match(/(?:^|[;&|(]\s*)cd\b/g)?.length ?? 0
  if (cds === 0) return undefined
  const cd = /^\s*cd\s+([^\s;&|<>()]+)\s*(?:&&|;)/.exec(masked)
  const dir = cd?.[1] ? restore(cd[1]) : ''
  return cds === 1 && dir !== '' && dir !== '-' && !/[$`*?~\u0001]/.test(dir) ? dir : null
}

/** Path-like words anywhere in a command, heredoc bodies and quoted strings included: what a script may change. */
export function namedPaths(command: string, limit = 12): string[] {
  const found = new Set<string>()
  const text = command.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, ' ')
  // A quoted word (`open('notes.md')`) or one with a slash is likelier a file than `e.tool`: those first.
  const rank = (path: string) => (/['"]$/.test(text.slice(0, text.indexOf(path))) || path.includes('/') ? 0 : 1)
  const words: string[] = []
  for (const m of text.matchAll(/(?<![\w$@{}.\/~-])(?:~\/|\.{1,2}\/|\/)?(?:[\w@+-][\w.@+-]*\/)*[\w@+-][\w@+-]*(?:\.[\w-]+)*\.[A-Za-z][\w-]{0,9}(?![\w\/(])/g)) {
    const path = m[0]
    if (/^\d|^-|\.(?:com|org|io|net)$/.test(path) || BINARY.test(path)) continue
    words.push(path)
  }
  for (const path of words.sort((a, b) => rank(a) - rank(b))) {
    found.add(path)
    if (found.size >= limit) break
  }
  return [...found]
}

function matchShell(command: string): ShellAccess | null {
  const { masked, restore } = mask(command)
  // A file operand: never an option, never a redirect.
  const file = `([^\\s<>|;&()-][^\\s<>|;&()]*)`

  // A redirect target that names a path (a `/` or a `.`): `a > b` in code is a comparison.
  const redirect = new RegExp(`(?:^|[^0-9&<>=-])>>?\\s*(?!=)${file}`).exec(masked)
  const target = redirect?.[1] ? restore(redirect[1]) : ''
  if (/[./]/.test(target) && !/^\/dev\//.test(target)) return { kind: 'write', path: target }
  const tee = new RegExp(`\\btee\\s+(?:-a\\s+)?${file}`).exec(masked)
  if (tee?.[1]) return { kind: 'write', path: restore(tee[1]) }

  for (const raw of masked.split(/\s*(?:&&|\|\||;|\||\n)\s*/)) {
    const seg = raw.trim().replace(/^cd\s+\S+\s*$/, '')
    const sed = new RegExp(`^sed\\s+-n\\s+\\u0001?(\\d+)(?:,(\\d+))?p\\u0001?\\s+${file}$`).exec(
      seg.replace(/\u0001(\d+)\u0001/g, (q, k: string) => {
        const text = restore(q)
        return /^\d+(,\d+)?p$/.test(text) ? `\u0001${text}\u0001` : `\u0001${k}\u0001`
      }),
    )
    if (sed?.[1] && sed[3]) {
      const from = Number(sed[1])
      return { kind: 'read', path: restore(sed[3]), from, to: sed[2] ? Number(sed[2]) : from }
    }
    const headCmd = new RegExp(`^head(?:\\s+-n)?(?:\\s+-?(\\d+))?\\s+${file}$`).exec(seg)
    if (headCmd?.[2]) return { kind: 'read', path: restore(headCmd[2]), from: 1, to: Number(headCmd[1] ?? 10) }
    const cat = new RegExp(`^(?:cat|bat|batcat|nl|tail|less|more)((?:\\s+[^\\s<>|;&()]+)+)$`).exec(seg)
    // Options and a count (`tail -n 20`) are no file; of several files, the first.
    const operand = cat?.[1]?.trim().split(/\s+/).find(w => !w.startsWith('-') && !/^\d+$/.test(w))
    if (operand) return { kind: 'read', path: restore(operand) }
  }

  return null
}

const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tgz|xz|jar|wasm|so|dylib|exe|bin|woff2?|ttf|otf|mp[34]|mov|ipynb)$/i

const clean = (line: string) => line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

// ── capture ────────────────────────────────────────────────────────────────

/** The project root paths are shown against; a shell `cd` does not move it. */
let root = ''
let home = ''

const expandHome = (path: string) => (home && /^~(\/|$)/.test(path) ? `${home}${path.slice(1)}` : path)
let nvimServer = ''

/** `path` against `dir` (the calling loop's directory: a subagent's may be a worktree of its own). */
const absolute = (path: string, dir: string) =>
  path.startsWith('/') || !dir ? path : `${dir.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`

function relative(path: string) {
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  const scratch = /\/scratchpad\/(.*)$/.exec(path)
  if (scratch) return `scratchpad/${scratch[1]}`
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/)/, '~')
}

/** A label as one line: whitespace runs (a heredoc's newlines) folded, a leading `cd <dir> &&` dropped. */
export function oneLine(label: string): string {
  return label
    .replace(/\s+/g, ' ')
    .replace(/^cd\s+\S+\s*(?:&&|;)\s*/, '')
    .trim()
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    if (BINARY.test(path)) return null
    const text = await $.fs.read(path)
    return text.length > MAX_FILE_CHARS || text.includes('\0') ? null : text
  } catch {
    return null
  }
}

/** The focused file's lines, kept while its size and mtime hold: every redraw would read and split it again. */
let shownFile: { path: string; size: number; mtimeMs: number; lines: string[] } | null = null

async function fileLines($: EngineInterface, path: string): Promise<string[] | null> {
  const stat = await $.fs.stat(path).catch(() => null)
  const at = shownFile
  if (stat && at && at.path === path && at.size === stat.size && at.mtimeMs === stat.mtimeMs) return at.lines
  const text = await readText($, path)
  const lines = text === null ? null : splitLines(text).map(clean)
  shownFile = stat && lines ? { path, size: stat.size, mtimeMs: stat.mtimeMs, lines } : null
  return lines
}

function sourceView(path: string, lines: string[], from: number, to: number, pad: number, limit: number): FileView {
  const start = Math.max(1, from - pad)
  const end = Math.min(lines.length, Math.min(to + pad, start + limit - 1))
  return {
    mode: 'source',
    path,
    startLine: start,
    lines: lines.slice(start - 1, end).map(clean),
    focusFrom: from,
    focusTo: Math.min(to, lines.length),
  }
}

function diffView(path: string, before: string, after: string): FileView | null {
  const hunk = buildHunk(splitLines(before).map(clean), splitLines(after).map(clean))
  return hunk && { mode: 'diff', path, ...hunk }
}

const diffFields = (view: FileView & { mode: 'diff' }): Partial<Activity> => ({
  line: view.line,
  view,
  added: view.added,
  removed: view.removed,
})

type Found = Omit<Activity, 'id' | 'agentId' | 'tool' | 'phase' | 'at'>

type Plan = {
  activity: Found
  /**
   * Runs after the tool answered; what it returns is merged into the activity,
   * and each of `more` (further files the call changed) is an activity of its own.
   */
  after?: (ran: ToolCallResult) => Promise<Partial<Activity> & { more?: Found[] }>
}

const base = (kind: ActivityKind, label: string, path: string | null = null) => ({
  kind,
  label,
  path,
  isScratch: path !== null && isScratchPath(path),
  line: null,
  endLine: null,
  view: null,
  added: null,
  removed: null,
})

async function readPlan($: EngineInterface, path: string, from: number, to: number | null, label: string): Promise<Plan> {
  const text = await readText($, path)
  const lines = text === null ? [] : splitLines(text)
  const end = Math.min(to ?? lines.length, lines.length || (to ?? from))
  return {
    activity: {
      ...base('read', label, path),
      line: from,
      endLine: end,
      view: text === null ? null : sourceView(path, lines, from, end, 0, READ_WINDOW),
    },
  }
}

/**
 * What an Edit or Write result says beyond its text: the file as the tool found
 * it (truer than a snapshot taken before the permission prompt), and whether
 * the change was held for review rather than written.
 */
function toolRecord(ran: ToolCallResult): { originalFile?: string | null; staged?: boolean } {
  const result = ran.isError || ran.deny !== undefined ? null : ran.result
  return typeof result === 'object' && result !== null ? (result as { originalFile?: string | null; staged?: boolean }) : {}
}

async function writePlan($: EngineInterface, path: string, label: string, isTool = false): Promise<Plan> {
  const snapshot = await readText($, path)
  return {
    activity: { ...base('write', label, path), line: 1 },
    after: async ran => {
      const record = isTool ? toolRecord(ran) : {}
      if (record.staged === true) return { isHeld: true }
      const before = typeof record.originalFile === 'string' ? record.originalFile : snapshot
      const after = await readText($, path)
      if (after === null) return {}
      if (before === null) {
        const lines = splitLines(after)
        return { label: `${label} (new file)`, endLine: lines.length, added: lines.length, removed: 0, view: sourceView(path, lines, 1, 0, 0, READ_WINDOW) }
      }
      const view = diffView(path, before, after)
      return view?.mode === 'diff' ? diffFields(view) : {}
    },
  }
}

const GIT_STATS = 300
const GIT_TEXTS = 50
const GIT_SHOWN = 20
/** A command that only looks: no tree to compare around it. */
const LOOKS_ONLY = /^\s*(?:ls|cat|echo|pwd|grep|rg|head|tail|wc|which|date|stat|file|tree|du|df)\b/

type Tree = { root: string; stats: Map<string, string> }

/** The repo's uncommitted files (git status) as a size and mtime each; null outside a repo. */
async function treeState($: EngineInterface, here: string): Promise<Tree | null> {
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: here, timeoutMs: 3000 })
    if (top.exitCode !== 0) return null
    const root = top.stdout.trim()
    const status = await $.process.run(['git', 'status', '--porcelain', '-z', '--untracked-files=all'], { cwd: root, timeoutMs: 5000 })
    if (status.exitCode !== 0) return null
    const entries = status.stdout.split('\0')
    const stats = new Map<string, string>()
    for (let i = 0; i < entries.length && stats.size < GIT_STATS; i++) {
      const entry = entries[i]!
      if (entry.length < 4) continue
      // A rename names its old path in the entry after it.
      if (entry[0] === 'R' || entry[0] === 'C') i++
      const path = `${root}/${entry.slice(3)}`
      const stat = await $.fs.stat(path).catch(() => null)
      stats.set(path, stat ? `${stat.size}:${stat.mtimeMs}` : 'gone')
    }
    return { root, stats }
  } catch {
    return null
  }
}

/**
 * Any other command (a script, `sed -i`, `perl -pi`, a formatter) may change the
 * files it names, or files it finds for itself: each named file is read before
 * it runs and diffed after, and so is every file git sees change around it.
 * The ones that changed are the call's edits.
 */
async function shellPlan($: EngineInterface, command: string, here: string): Promise<Plan> {
  const dir = shellDir(command)
  const paths = namedPaths(command)
    .map(expandHome)
    .filter(path => path.startsWith('/') || dir !== null)
    .map(path => absolute(path, dir ? absolute(dir, here) : here))
  const before = new Map<string, string | null>()
  for (const path of paths) before.set(path, await readText($, path))

  const cwd = dir ? absolute(dir, here) : here
  const treeBefore = LOOKS_ONLY.test(command) ? null : await treeState($, cwd)
  const dirty = new Map<string, string | null>()
  if (treeBefore) {
    for (const path of [...treeBefore.stats.keys()].slice(0, GIT_TEXTS)) if (!before.has(path)) dirty.set(path, await readText($, path))
  }

  return {
    activity: base('shell', command),
    after: async () => {
      const changed: Found[] = []
      const record = (path: string, was: string | null, now: string | null) => {
        if (now === null || now === was) return
        if (was === null) {
          const lines = splitLines(now)
          changed.push({ ...base('write', command, path), line: 1, endLine: lines.length, added: lines.length, removed: 0, view: sourceView(path, lines, 1, 0, 0, READ_WINDOW) })
          return
        }
        const view = diffView(path, was, now)
        if (view?.mode === 'diff') changed.push({ ...base('edit', command, path), endLine: null, ...diffFields(view) })
      }
      for (const [path, was] of before) record(path, was, await readText($, path))

      const treeAfter = treeBefore ? await treeState($, cwd) : null
      if (treeBefore && treeAfter) {
        const candidates = new Set([...treeBefore.stats.keys(), ...treeAfter.stats.keys()])
        for (const path of candidates) {
          if (changed.length >= GIT_SHOWN) break
          if (before.has(path) || treeBefore.stats.get(path) === treeAfter.stats.get(path)) continue
          let was: string | null
          if (dirty.has(path)) was = dirty.get(path)!
          else if (treeBefore.stats.has(path)) continue
          else {
            // Clean before: the committed file is what it was; absent from HEAD, it is new.
            const shown = await $.process.run(['git', 'show', `HEAD:${path.slice(treeBefore.root.length + 1)}`], { cwd: treeBefore.root, timeoutMs: 5000 }).catch(() => null)
            was = shown && shown.exitCode === 0 && !shown.isStdoutTruncated ? shown.stdout : null
          }
          record(path, was, await readText($, path))
        }
      }
      const [first, ...more] = changed
      return first ? { ...first, more } : {}
    },
  }
}

const GREP_FILES = 6

/** The text a Grep result carries: a string, a `{ content | filenames }` object, or text blocks. */
function resultText(ran: ToolCallResult): string {
  const r = ran.result as unknown
  if (typeof r === 'string') return r
  if (Array.isArray(r)) return r.map(b => (typeof b === 'string' ? b : String((b as { text?: string })?.text ?? ''))).join('\n')
  if (r && typeof r === 'object') {
    const o = r as { content?: unknown; filenames?: unknown }
    if (typeof o.content === 'string' && o.content) return o.content
    if (Array.isArray(o.filenames)) return o.filenames.join('\n')
  }
  return ''
}

/** The files a Grep matched, each with the first matching line (null where the result names only files). */
export function grepFiles(text: string): { path: string; line: number | null }[] {
  const hits = new Map<string, number | null>()
  for (const raw of text.split('\n')) {
    const row = raw.trimEnd()
    const withLine = /^(.+?):(\d+):/.exec(row)
    if (withLine) {
      if (!hits.has(withLine[1]!)) hits.set(withLine[1]!, Number(withLine[2]))
      continue
    }
    const counted = /^(.+):\d+$/.exec(row)
    const path = counted ? counted[1]! : row
    // A path, not a header (`Found 3 files`) or a context line.
    if (/^(?:\/|\.\/|[\w@.-]+\/)\S*$/.test(path) && !/-\d+-/.test(path) && !hits.has(path)) hits.set(path, null)
  }
  return [...hits].map(([path, line]) => ({ path, line }))
}

/** Where a Grep matched: the first match's file and window on the call, each further file an activity of its own. */
async function grepHits($: EngineInterface, ran: ToolCallResult, pattern: string, here: string, label: string): Promise<Partial<Activity> & { more?: Found[] }> {
  const all = grepFiles(resultText(ran))
  if (all.length === 0) return {}
  let finder: RegExp | null = null
  try {
    finder = new RegExp(pattern, 'i')
  } catch {}
  const found: Found[] = []
  for (const hit of all.slice(0, GREP_FILES)) {
    const path = absolute(expandHome(hit.path), here)
    const text = await readText($, path)
    if (text === null) continue
    const lines = splitLines(text)
    let line = hit.line ?? 1
    if (hit.line === null && finder) {
      const at = lines.findIndex(l => finder!.test(l))
      if (at >= 0) line = at + 1
    }
    found.push({ ...base('search', label, path), line, endLine: line, view: sourceView(path, lines, line, line, 3, READ_WINDOW) })
  }
  const note = `${label}  (${all.length} file${all.length === 1 ? '' : 's'})`
  const [first, ...more] = found
  return first ? { ...first, label: note, more } : { label: note }
}

async function plan($: EngineInterface, e: ToolCallInput, here: string): Promise<Plan> {
  const tool = String(e.tool)
  if (e.tool === 'Read') {
    const path = absolute(e.file_path, here)
    const from = Math.max(1, e.offset ?? 1)
    return readPlan($, path, from, e.limit ? from + e.limit - 1 : null, e.file_path)
  }
  if (e.tool === 'Edit') {
    const path = absolute(e.file_path, here)
    const before = await readText($, path)
    const at = before === null ? -1 : before.indexOf(e.old_string)
    const line = at < 0 || before === null ? null : lineOf(before, at)
    const endLine = line === null ? null : line + splitLines(e.old_string).length - 1
    return {
      activity: {
        ...base('edit', e.replace_all ? `${e.file_path} (all)` : e.file_path, path),
        line,
        endLine,
        view: before === null || line === null || endLine === null ? null : sourceView(path, splitLines(before), line, endLine, EDIT_CONTEXT, READ_WINDOW),
      },
      after: async ran => {
        const record = toolRecord(ran)
        if (record.staged === true) return { isHeld: true }
        const from = typeof record.originalFile === 'string' ? record.originalFile : before
        const after = ran.isError || ran.deny !== undefined || from === null ? null : await readText($, path)
        const view = after === null || from === null ? null : diffView(path, from, after)
        return view?.mode === 'diff' ? diffFields(view) : {}
      },
    }
  }
  if (e.tool === 'Write') return writePlan($, absolute(e.file_path, here), e.file_path, true)
  if (e.tool === 'NotebookEdit') return { activity: base('edit', e.notebook_path, absolute(e.notebook_path, here)) }
  if (e.tool === 'Bash') {
    const found = parseShell(e.command)
    const path = found && absolute(expandHome(found.path), found.dir === undefined ? here : absolute(found.dir, here))
    if (found?.kind === 'read' && path) return readPlan($, path, found.from ?? 1, found.to ?? null, e.command)
    if (found?.kind === 'write' && path) return writePlan($, path, e.command)
    return shellPlan($, e.command, here)
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const args = e as unknown as { pattern?: string; path?: string }
    const label = `${args.pattern ?? ''}${args.path ? `  in ${args.path}` : ''}`
    if (tool === 'Glob') return { activity: base('search', label) }
    return { activity: base('search', label), after: ran => grepHits($, ran, args.pattern ?? '', here, label) }
  }
  if (e.tool === 'TodoWrite') {
    const doing = e.todos.find(t => t.status === 'in_progress')
    return { activity: base('plan', doing?.activeForm ?? `${e.todos.length} todos`) }
  }
  if (e.tool === 'TaskCreate') return { activity: base('plan', e.subject) }
  if (e.tool === 'WebFetch') return { activity: base('web', e.url) }
  if (e.tool === 'WebSearch') return { activity: base('web', e.query) }
  if (e.tool === 'Agent') return { activity: base('agent', e.description) }
  return { activity: base('other', tool.replace(/^mcp__/, '').replace(/__/g, ' › ')) }
}

/** Newest first; only the newest few keep their excerpt. The pinned one stays, excerpt and all. */
export function trim(list: Activity[], keep: string | null): Activity[] {
  const kept = list.slice(0, MAX_ACTIVITIES)
  const held = keep === null || kept.some(a => a.id === keep) ? undefined : list.find(a => a.id === keep)
  return [...kept, ...(held ? [held] : [])].map((a, i) =>
    i < MAX_VIEWS || a.id === keep || a.view === null ? a : { ...a, view: null },
  )
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
function clipStart(text: string, room: number): string {
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
export type CodeRow = { line: number; part: number; text: string; t: ' ' | '-' | '+'; old: number; new: number; isGap?: true }

/** Lines hard-wrapped to `room` cells, tabs expanded: one CodeRow per row the window draws, a gap where the hunk changes. */
export function wrapRows(lines: { text: string; t: CodeRow['t']; old: number; new: number; hunk?: number }[], room: number): CodeRow[] {
  const rows: CodeRow[] = []
  lines.forEach((l, line) => {
    const before = lines[line - 1]
    if (before && before.hunk !== l.hunk) rows.push({ line, part: 0, text: '⋯', t: ' ', old: 0, new: 0, isGap: true })
    wrapCells(expandTabs(l.text), Math.max(1, room)).forEach((text, part) => rows.push({ line, part, text, t: l.t, old: l.old, new: l.new }))
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

let codeBackgroundOption = 'auto'
let themeName: string | null = null

async function theme($: EngineInterface): Promise<string> {
  themeName ??= String((await $.config.list().catch(() => [])).find(row => row.key === 'theme')?.value ?? '')
  return themeName
}

/** The code window's fill: a shade dimmer than the terminal's, by theme, unless set in /config. */
async function codeBackground($: EngineInterface): Promise<string | undefined> {
  if (codeBackgroundOption === 'none') return undefined
  if (codeBackgroundOption !== 'auto') return codeBackgroundOption
  const name = await theme($)
  return /light/.test(name) ? '#eeeeee' : /ansi/.test(name) ? undefined : '#1c1c1c'
}

/** A Files or Trail row under the pointer: a step off the fill, by theme. */
async function rowHover($: EngineInterface): Promise<string> {
  const name = await theme($)
  return /light/.test(name) ? '#dcdcdc' : /ansi/.test(name) ? 'subtle' : '#303030'
}

/** What the code window last drew: the wheel and j/k move it from there. */
let drawn: { id: string; top: number; maxTop: number; codeTop: number; codeRows: number } | null = null

async function scrollCode($: EngineInterface, by: number) {
  const at = drawn
  if (at === null) return
  const top = Math.min(at.maxTop, Math.max(0, at.top + by))
  if (top === at.top) return
  drawn = { ...at, top }
  await update($, scroll, () => ({ id: at.id, top }))
}

/** Where Files and Trail last drew (their rows from the pane's top), so the wheel over one scrolls that list. */
let drawnLists: { name: 'files' | 'trail'; from: number; rows: number; top: number; maxTop: number }[] = []

async function scrollList($: EngineInterface, name: 'files' | 'trail', by: number) {
  const at = drawnLists.find(l => l.name === name)
  if (!at) return
  const top = Math.min(at.maxTop, Math.max(0, at.top + by))
  if (top === at.top) return
  at.top = top
  await update($, lists, cur => ({ ...cur, [name]: top }))
}

const escapeVim = (path: string) => path.replace(/([ \\%#|"'])/g, '\\$1').replace(/</g, '<lt>')

async function mirror($: EngineInterface, a: Activity) {
  if (!nvimServer || a.path === null || a.kind === 'other') return
  const keys = `<C-\\><C-N>:e +${a.line ?? 1} ${escapeVim(a.path)}<CR>zz`
  try {
    const run = await $.process.run(['nvim', '--server', nvimServer, '--remote-send', keys], { timeoutMs: 2000 })
    if (run.exitCode !== 0) $.ui.status(`follow: nvim at ${nvimServer} did not answer`)
  } catch {
    $.ui.status('follow: nvim is not on PATH')
  }
}

const shortPath = (a: Activity) =>
  a.path === null ? oneLine(a.label) : `${relative(a.path)}${a.line ? `:${a.line}${a.endLine && a.endLine > a.line ? `-${a.endLine}` : ''}` : ''}`

// ── drawing ────────────────────────────────────────────────────────────────

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

async function reset($: EngineInterface) {
  await update($, activities, () => [])
  await update($, pinned, () => null)
  await update($, scroll, () => null)
  await update($, lists, () => ({ files: 0, trail: 0 }))
  $.ui.status(undefined)
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Follow', columns: SIDEBAR_COLUMNS, rows: 30 })

/** An activity's path:line (or its one-line label) in at most `room` cells, its file name kept. */
const fitActivity = (a: Activity, room: number) => (a.path === null ? clip(oneLine(a.label), room) : shortenPath(shortPath(a), room))

/** The last wrap, kept while its lines and width hold: a redraw would wrap the whole file again. */
let wrapped: { of: unknown; room: number; rows: CodeRow[] } | null = null
function wrapOnce(of: unknown, room: number, lines: () => Parameters<typeof wrapRows>[0]): CodeRow[] {
  if (wrapped && wrapped.of === of && wrapped.room === room) return wrapped.rows
  const rows = wrapRows(lines(), room)
  wrapped = { of, room, rows }
  return rows
}

export const register: Register = (on, options) => {
  nvimServer = String(options.nvimServer ?? '').trim()
  codeBackgroundOption = String(options.codeBackground ?? 'auto').trim() || 'auto'
  themeName = null

  on('session.start', async ($, e, next) => {
    root = await $.session.root().catch(() => $.session.cwd())
    home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    await $.command.register({
      name: 'follow',
      description: 'Follow the agent: open the live file pane, or `live`, `clear`',
      argumentHint: '[live | clear]',
      immediate: true,
    })
    void openPane($)

    return next(e)
  })

  // A /clear starts a new conversation with no session.start: its trail goes too.
  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await reset($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The status line names what the agent is doing; once the turn ends it is doing nothing.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // Redraw the footer now, and again once the finished call's linger has run out.
      $.ui.invalidate('ui.render')
      $.clock.after(LINGER_MS + 500, () => $.ui.invalidate('ui.render'))
    }
    return next(e)
  })

  on('command.run', { command: 'follow' }, async ($, e) => {
    const verb = e.args.trim()
    if (verb === 'clear') {
      await reset($)
      return { text: 'Follow trail cleared.' }
    }
    if (verb === 'live') {
      await update($, pinned, () => null)
      await update($, scroll, () => null)
    }
    await openPane($)
    const { isFullscreen, columns } = e.presentation
    if (!isFullscreen) {
      return {
        text: 'Following the agent, above the prompt. For a sidebar beside the transcript, restart with CLAUDE_CODE_NO_FLICKER=1 (fullscreen layout) in a terminal at least 110 columns wide.',
      }
    }
    if (columns < DOCK_MIN_COLUMNS) {
      return { text: `Following the agent. Widen the terminal to ${DOCK_MIN_COLUMNS}+ columns (now ${columns}) to dock it as a sidebar.` }
    }
    return { text: 'Following the agent in the sidebar.' }
  })

  on('tool.call', async ($, e, next) => {
    let p: Plan
    try {
      // The calling loop's directory: a subagent's own, a worktree's after a move.
      const here = await $.session.cwd()
      // /cd and a worktree move take the root along.
      if (e.agentId === undefined) root = await $.session.root().catch(() => root || here)
      p = await plan($, e, here)
    } catch {
      return next(e)
    }
    const activity: Activity = {
      ...p.activity,
      id: e.tool_use_id,
      agentId: e.agentId ?? null,
      tool: String(e.tool),
      phase: 'running',
      at: await $.clock.now(),
    }
    const keep = await read($, pinned)
    await update($, activities, list => trim([activity, ...list.filter(a => a.id !== activity.id)], keep))
    if (keep === null) void mirror($, activity)

    const settle = (extra: Partial<Activity>, phase: Activity['phase']) =>
      update($, activities, list => list.map((a): Activity => (a.id === activity.id ? { ...a, ...extra, phase } : a)))

    let ran: ToolCallResult
    try {
      ran = await next(e)
    } catch (error) {
      // Interrupted or thrown: the row would otherwise read `…` for good.
      await settle({}, 'error').catch(() => {})
      throw error
    }
    const isError = ran.deny !== undefined || ran.isError === true
    type After = Awaited<ReturnType<NonNullable<Plan['after']>>>
    const { more = [], ...extra }: After = p.after && !isError ? await p.after(ran).catch(() => ({})) : {}
    await settle(extra, isError ? 'error' : 'done')
    if (more.length > 0) {
      const also = more.map((m, i): Activity => ({ ...activity, ...m, id: `${activity.id}#${i + 1}`, phase: 'done' }))
      const keep = await read($, pinned)
      await update($, activities, list => {
        const at = list.findIndex(a => a.id === activity.id)
        return trim([...list.slice(0, at + 1), ...also, ...list.slice(at + 1)], keep)
      })
    }

    return ran
  }).catch(($, e, next) => next(e))

  // The footer's right side, beside the statusline: what the main agent is doing now, so it shows with the pane closed.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const main = (await read($, activities)).filter(a => a.agentId === null)
    const a = main.find(x => x.phase === 'running') ?? main[0]
    const t = await $.clock.now()
    const isRunning = a?.phase === 'running'
    // A finished call lingers a few seconds, then the label goes quiet.
    const doing = a && (isRunning || t - a.at <= LINGER_MS) ? a : null
    // Subagents at work, by type: `2 agents Explore + general-purpose`, like the model and effort chip.
    const working = (await $.agent.list().catch(() => [])).filter(g => g.status === 'running')
    if (!doing && working.length === 0 && e.props.modes.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const types = [...new Set(working.map(g => g.type))]
    const what = !doing ? '' : doing.path === null ? footerWhat(doing.label) : `${shortenPath(shortPath(doing), 28)}${doing.line ? `:${doing.line}` : ''}`
    const modes = e.props.modes.join(' & ')
    // Two rows, right-aligned: the labels (CI, subagents) over what the agent is doing.
    return (
      <Box flexDirection="column" flexGrow={1} alignItems="flex-end">
        {modes || working.length > 0 ? (
          <Box flexDirection="row" gap={1} justifyContent="flex-end">
            {modes ? <Text dimColor>{modes}</Text> : ''}
            {working.length > 0 ? (
              <Text>
                <Text bold color="claude">{`${working.length} ${working.length === 1 ? 'agent' : 'agents'}`}</Text>
                <Text dimColor>{` ${clip(types.join(' + '), 28)}`}</Text>
              </Text>
            ) : (
              ''
            )}
          </Box>
        ) : (
          ''
        )}
        {doing ? (
          <Box flexDirection="row" gap={1} justifyContent="flex-end">
            <Text bold color={BADGE[doing.kind].color}>{BADGE[doing.kind].label.toLowerCase()}</Text>
            <Text dimColor={!isRunning} wrap="truncate-end">{what}</Text>
            {isRunning ? <Text dimColor>{ago(t - doing.at)}</Text> : ''}
          </Box>
        ) : (
          ''
        )}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const list = await read($, activities)
    const stored = await read($, pinned)
    // Only an activity id still in the trail pins; anything else follows live.
    const pin = typeof stored === 'string' && list.some(a => a.id === stored) ? stored : null
    const scrolled = await read($, scroll)
    const listTops = await read($, lists)
    const t = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns)
    const viewed = e.props.view.agentId ?? null

    const mine = list.filter(a => a.agentId === viewed)
    // While the agent in view waits on a subagent, the subagent is where the work is.
    const isDelegating = mine[0]?.kind === 'agent' && mine[0].phase === 'running'
    const pool = mine.length > 0 && !isDelegating ? mine : list
    const pinnedOne = list.find(a => a.id === pin)
    const focus = pinnedOne ?? pool.find(a => a.view !== null) ?? pool.find(a => a.path !== null)
    const now = pool[0]
    const isIdle = list.length === 0

    let who = 'main agent'
    if (viewed !== null) {
      const agent = (await $.agent.list().catch(() => [])).find(a => a.id === viewed)
      who = agent ? `${agent.type}: ${agent.description}` : 'subagent'
    } else if (isDelegating) {
      who = `main › ${mine[0]?.label ?? 'subagent'}`
    } else if (mine.length === 0 && list.length > 0) {
      who = 'newest activity'
    } else if (isIdle) {
      who = 'waiting for Claude'
    }

    const badge = (a: Activity) => (
      <Text>
        <Text bold color="inverseText" backgroundColor={BADGE[a.kind].color}>{` ${BADGE[a.kind].label} `}</Text>
        {a.isScratch ? <Text bold color="inverseText" backgroundColor="remember">{' SCRATCH '}</Text> : ''}
      </Text>
    )
    const stat = (added: number | null, removed: number | null) =>
      added == null || removed == null ? (
        ''
      ) : (
        <Text>
          {' '}
          <Text bold backgroundColor="#1d460f">{` +${added} `}</Text>
          <Text bold backgroundColor="#540d06">{` −${removed} `}</Text>
        </Text>
      )
    const statWidth = (added: number | null, removed: number | null) =>
      added == null || removed == null ? 0 : `${added}${removed}`.length + 7
    const mark = (a: Activity) => (a.phase === 'running' ? '…' : a.phase === 'error' ? '✗' : a.isHeld ? 'held' : '')

    // A fixed layout as tall as the body: the code window takes what the header,
    // Files and Trail leave, and scrolls inside itself while they stay put.
    const rows = Math.max(16, e.props.scroll.bodyRows)
    const isRoomy = rows >= 34
    const fileRows = isRoomy ? FILE_ROWS : 3
    const trailRows = isRoomy ? TRAIL_ROWS : 3
    const layout = codeLayout(rows, fileRows, trailRows)
    // A block's text runs between the pane's padding, its accent bar and its own padding.
    const inner = width - 5

    // What the code window scrolls over: the whole file for a read, the diff for a change,
    // each line hard-wrapped into rows under a gutter as wide as its largest line number.
    let codeRows: CodeRow[] = []
    let codeAuto = 0
    let gutter = 0
    let digits = 1
    let isFocusLine = (_row: CodeRow) => false
    let place = (_from: CodeRow, _to: CodeRow) => ''
    const fit = (lines: { old: number; new: number }[], extra: number) => {
      digits = String(lines.reduce((n, l) => Math.max(n, l.old, l.new), 1)).length
      gutter = extra + digits * (extra > 3 ? 2 : 1)
      // The scrollbar's column is kept whether it shows or not: the wrap must not depend on it.
      return Math.max(8, inner - 1 - gutter)
    }
    if (focus?.view?.mode === 'diff') {
      const view = focus.view
      const diff = diffRows(view.hunk)
      // old new ±: two numbers, a space after each, the sign and a space.
      const room = fit(diff, 4)
      codeRows = wrapOnce(view.hunk, room, () => diff)
      codeAuto = Math.max(0, codeRows.findIndex(r => r.t !== ' ') - HUNK_CONTEXT)
      place = (from, to) => `diff lines ${from.line + 1}–${to.line + 1} of ${diff.length}${view.isCut ? ' (cut)' : ''}`
    } else if (focus?.path) {
      const whole = await fileLines($, focus.path)
      const view = focus.view?.mode === 'source' ? focus.view : null
      const lines = whole ?? view?.lines ?? []
      const first = whole !== null ? 1 : view?.startLine ?? 1
      const focusFrom = focus.line ?? view?.focusFrom ?? first
      const focusTo = Math.max(focusFrom, focus.endLine ?? view?.focusTo ?? focusFrom)
      const numbered = () => lines.map((text, i) => ({ text, t: ' ' as const, old: first + i, new: first + i }))
      // mark, number, a space.
      const room = fit([{ old: 0, new: first + lines.length - 1 }], 2)
      codeRows = wrapOnce(lines, room, numbered)
      const at = codeRows.findIndex(r => r.new >= focusFrom)
      codeAuto = autoTop(at < 0 ? 0 : at, codeRows.length, layout.codeRows)
      isFocusLine = row => row.new >= focusFrom && row.new <= focusTo
      place = (from, to) => `lines ${from.new}–${to.new} of ${first + lines.length - 1}`
    }
    const codeTotal = codeRows.length

    const maxTop = Math.max(0, codeTotal - layout.codeRows)
    const isScrolled = focus !== undefined && scrolled !== null && scrolled.id === focus.id
    const top = Math.min(maxTop, Math.max(0, isScrolled ? scrolled.top : codeAuto))
    drawn = focus ? { id: focus.id, top, maxTop, codeTop: layout.codeTop, codeRows: layout.codeRows } : null
    const shown = codeRows.slice(top, top + layout.codeRows)
    const where = shown.length > 0 ? place(shown[0]!, shown[shown.length - 1]!) : ''

    const TONE = { ' ': undefined, '+': '#0e2705', '-': '#370603' } as const
    const drawCode = () => {
      if (shown.length === 0) return <Text dimColor>(no preview)</Text>
      const isDiff = focus?.view?.mode === 'diff'
      const mark = focus?.kind === 'read' ? '│' : '▌'
      const markColor = focus?.kind === 'read' ? 'suggestion' : 'warning'
      const num = (n: number, isShown: boolean) => (isShown ? String(n) : '').padStart(digits)
      // Runs of one tone share a Code, so a diff's rows take their background and a file stays one highlight.
      const runs: CodeRow[][] = []
      for (const row of shown) {
        const last = runs[runs.length - 1]
        if (last && last[0]!.t === row.t && !last[0]!.isGap && !row.isGap) last.push(row)
        else runs.push([row])
      }
      return (
        <Box flexDirection="row">
          <Box flexDirection="column" flexShrink={0} width={gutter}>
            {shown.map(row => {
              const isFirst = row.part === 0 && !row.isGap
              if (isDiff) {
                return (
                  <Text dimColor={row.t === ' '} backgroundColor={TONE[row.t]}>
                    {`${num(row.old, isFirst && row.t !== '+')} ${num(row.new, isFirst && row.t !== '-')} ${isFirst ? row.t : ' '} `}
                  </Text>
                )
              }
              const isFocus = isFocusLine(row)
              return (
                <Text>
                  <Text color={markColor}>{isFocus ? mark : ' '}</Text>
                  <Text dimColor={!isFocus} bold={isFocus} color={isFocus ? markColor : undefined}>{`${num(row.new, isFirst)} `}</Text>
                </Text>
              )
            })}
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            {runs.map((run, i) => (
              <Box key={`run:${i}`} height={run.length} backgroundColor={TONE[run[0]!.t]}>
                {run[0]!.isGap ? (
                  <Text dimColor>⋯</Text>
                ) : (
                  <Code source={run.map(r => r.text).join('\n') || ' '} path={focus?.path ?? ''} wrap="truncate-end" />
                )}
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    const files: { path: string; letters: Set<string>; latest: Activity; added: number | null; removed: number | null }[] = []
    for (const a of pool) {
      if (a.path === null) continue
      let f = files.find(x => x.path === a.path)
      if (!f) {
        f = { path: a.path, letters: new Set(), latest: a, added: null, removed: null }
        files.push(f)
      }
      const letter = LETTER[a.kind]
      if (letter) f.letters.add(letter)
      // Rows kept from before counts were recorded have none.
      if (a.added != null && a.removed != null) {
        f.added = (f.added ?? 0) + a.added
        f.removed = (f.removed ?? 0) + a.removed
      }
    }

    const filesMax = Math.max(0, files.length - fileRows)
    const trailMax = Math.max(0, pool.length - trailRows)
    const filesTop = Math.min(filesMax, Math.max(0, listTops.files))
    const trailTop = Math.min(trailMax, Math.max(0, listTops.trail))
    // Rows from the pane's top: the code block ends at codeTop + codeRows, each list is a gap, a heading and its rows.
    const filesFrom = layout.codeTop + layout.codeRows + 1
    const trailFrom = filesFrom + 2 + fileRows
    drawnLists = [
      { name: 'files', from: filesFrom, rows: 1 + fileRows, top: filesTop, maxTop: filesMax },
      { name: 'trail', from: trailFrom, rows: 1 + trailRows, top: trailTop, maxTop: trailMax },
    ]
    const span = (top: number, total: number, rows: number) => (total > rows ? `${top + 1}–${Math.min(total, top + rows)} of ${total}` : String(total))

    const followLive = () => Promise.all([update($, pinned, () => null), update($, scroll, () => null)])
    const panel = await codeBackground($)
    const isLive = pin === null && !isScrolled
    const chip = isIdle ? { text: '○ IDLE', color: 'inactive' } : pin !== null ? { text: '◎ PINNED', color: 'warning' } : isScrolled ? { text: '◎ SCROLLED', color: 'warning' } : { text: '● LIVE', color: 'claude' }
    const isChange = (kind: ActivityKind) => kind === 'edit' || kind === 'write'

    // A block as OpenCode draws one: an accent bar down its left, a raised fill.
    const block = (key: string, accent: string, height: number, body: unknown) => (
      <Box key={key} flexDirection="row" marginTop={1} height={height}>
        <Box flexDirection="column" flexShrink={0}>
          {Array.from({ length: height }, () => (
            <Text color={accent}>┃</Text>
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} backgroundColor={panel} paddingX={1} overflow="hidden">
          {body as never}
        </Box>
      </Box>
    )
    const heading = (title: string, note: string) => (
      <Box flexDirection="row" height={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text bold wrap="truncate-end">{title}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{note}</Text>
        </Box>
      </Box>
    )

    const grip = thumb(top, codeTotal, layout.codeRows)
    const totalAdded = files.reduce((n, f) => n + (f.added ?? 0), 0)
    const totalRemoved = files.reduce((n, f) => n + (f.removed ?? 0), 0)
    const kindName = focus ? BADGE[focus.kind].label.charAt(0) + BADGE[focus.kind].label.slice(1).toLowerCase() : ''
    const focusAge = focus ? mark(focus) || ago(t - focus.at) : ''
    const focusRoom = focus
      ? inner - cellWidth(kindName) - (focus.isScratch ? 8 : 0) - 1 - statWidth(focus.added, focus.removed) - 1 - cellWidth(focusAge)
      : 0
    const hover = await rowHover($)

    return (
      <Box flexDirection="column" paddingX={1} height={rows} overflow="hidden">
        <Box flexDirection="row" height={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              <Text bold color="claude">Follow</Text>
              <Text dimColor>  {who}</Text>
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Text bold color={chip.color}>{chip.text}</Text>
            {isLive ? (
              focus ? <Button key="pin" label="pin" hotkey="p" onPress={() => update($, pinned, () => focus.id)} /> : ''
            ) : (
              <Button key="live" label="⟲ follow live" variant="primary" hotkey="f" onPress={followLive} />
            )}
          </Box>
        </Box>

        {focus ? (
          block(
            'focus',
            isLive ? 'claude' : 'warning',
            layout.codeRows + 2,
            <Box flexDirection="column">
              <Box flexDirection="row" height={1}>
                {/* The kind, the chips and the age keep their cells: only the path gives way. */}
                <Box flexShrink={0}>
                  <Text bold color={BADGE[focus.kind].color}>{kindName}</Text>
                  {focus.isScratch ? <Text color="remember"> scratch</Text> : ''}
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate-start" bold>{` ${fitActivity(focus, focusRoom)}`}</Text>
                </Box>
                <Box flexShrink={0}>
                  {stat(focus.added, focus.removed)}
                  <Text dimColor>{` ${focusAge}`}</Text>
                </Box>
              </Box>
              <Box flexDirection="row" height={1}>
                <Box flexGrow={1} flexShrink={1}>
                  <Text dimColor wrap="truncate-end">
                    {focus.isHeld ? 'held for review: the file is unchanged' : focus.tool === 'Bash' ? `$ ${oneLine(focus.label)}` : where}
                  </Text>
                </Box>
                {maxTop > 0 ? (
                  <Box flexShrink={0}>
                    <Text dimColor>{` ${Math.round((top / maxTop) * 100)}%`}</Text>
                  </Box>
                ) : (
                  ''
                )}
              </Box>
              <Box key="code" flexDirection="row" height={layout.codeRows} overflow="hidden">
                <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
                  {drawCode() as never}
                </Box>
                {maxTop > 0 ? (
                  <Box flexDirection="column" flexShrink={0}>
                    {Array.from({ length: layout.codeRows }, (_, i) => {
                      const isThumb = i >= grip.from && i < grip.from + grip.size
                      return <Text color={isThumb ? 'claude' : 'subtle'}>{isThumb ? '┃' : '│'}</Text>
                    })}
                  </Box>
                ) : (
                  ''
                )}
              </Box>
            </Box>,
          )
        ) : isIdle ? (
          block(
            'idle',
            'claude',
            layout.codeRows + 2,
            <Box flexDirection="column">
              <Text bold color="claude">◉ Nothing yet. Watching for Claude's first move.</Text>
              <Text dimColor wrap="wrap">Every file Claude reads, edits or writes opens here, at the line it is working on.</Text>
              <Box marginTop={1} flexDirection="row" gap={1}>
                {(['read', 'edit', 'write'] as const).map(k => (
                  <Text key={`k:${k}`} bold color="inverseText" backgroundColor={BADGE[k].color}>{` ${BADGE[k].label} `}</Text>
                ))}
                <Text dimColor>open the file</Text>
              </Box>
              <Box flexDirection="row" gap={1}>
                {(['shell', 'search', 'web', 'agent'] as const).map(k => (
                  <Text key={`k:${k}`} bold color={BADGE[k].color}>{BADGE[k].label.toLowerCase()}</Text>
                ))}
                <Text dimColor>logged in the trail</Text>
              </Box>
              <Box marginTop={1} flexDirection="column">
                <Text>
                  <Text color="suggestion">│</Text>
                  <Text dimColor> lines read   </Text>
                  <Text color="warning">▌</Text>
                  <Text dimColor> lines changed   </Text>
                  <Text bold backgroundColor="#1d460f">{' +N '}</Text>
                  <Text bold backgroundColor="#540d06">{' −M '}</Text>
                </Text>
                <Text dimColor wrap="wrap">p pin · f follow live · j/k scroll · /follow clear</Text>
              </Box>
            </Box>,
          )
        ) : (
          block('nofile', 'subtle', layout.codeRows + 2, <Text dimColor>No file touched yet.</Text>)
        )}

        {block(
          'files',
          'subtle',
          fileRows + 1,
          <Box flexDirection="column">
            {heading('Files', span(filesTop, files.length, fileRows))}
            {files.length === 0 ? <Text dimColor>○ none yet</Text> : ''}
            {files.slice(filesTop, filesTop + fileRows).map(f => {
              const isChanged = f.letters.has('E') || f.letters.has('W')
              const isScratch = isScratchPath(f.path)
              // ● and a space, the ✎, then the chips or ` read` on the right.
              const room = inner - 2 - (isScratch ? 2 : 0) - (isChanged ? statWidth(f.added, f.removed) : 5)
              return (
                // The whole row lights under the pointer, not only its text.
                <Box key={`f:${f.path}`} flexDirection="row" height={1} hover={{ backgroundColor: hover }}>
                  <Box flexGrow={1} flexShrink={1}>
                    <Button key={`file:${f.path}`} plain onPress={() => update($, pinned, () => f.latest.id)}>
                      {isChanged ? <Text color="warning">●</Text> : <Text color="suggestion">○</Text>}{' '}
                      <Text bold={isChanged} dimColor={!isChanged}>
                        {shortenPath(relative(f.path), room)}
                      </Text>
                      {isScratch ? <Text color="remember"> ✎</Text> : ''}
                    </Button>
                  </Box>
                  <Box flexShrink={0}>{isChanged ? stat(f.added, f.removed) : <Text color="suggestion" dimColor> read</Text>}</Box>
                </Box>
              )
            })}
          </Box>,
        )}

        {block(
          'trail',
          'subtle',
          trailRows + 1,
          <Box flexDirection="column">
            {heading('Trail', pool.length > trailRows ? `${span(trailTop, pool.length, trailRows)} · newest first` : 'newest first')}
            {pool.length === 0 ? <Text dimColor>· waiting for the first tool call…</Text> : ''}
            {pool.slice(trailTop, trailTop + trailRows).map(a => {
              const age = mark(a) || ago(t - a.at)
              const isFocus = a.id === focus?.id
              const isQuiet = !isChange(a.kind) && !isFocus
              // ▸, the kind padded to six and a space; the chips, a space and the age on the right.
              const room = inner - 8 - statWidth(a.added, a.removed) - 1 - cellWidth(age)
              return (
                <Box key={`t:${a.id}`} flexDirection="row" height={1} hover={{ backgroundColor: hover }}>
                  <Box flexGrow={1} flexShrink={1}>
                    <Button key={`trail:${a.id}`} plain onPress={() => update($, pinned, () => a.id)}>
                      <Text color={isFocus ? 'claude' : 'subtle'}>{isFocus ? '▸' : ' '}</Text>
                      <Text bold={isChange(a.kind)} color={BADGE[a.kind].color}>{BADGE[a.kind].label.toLowerCase().padEnd(6)}</Text>{' '}
                      <Text dimColor={isQuiet} bold={isFocus}>
                        {fitActivity(a, room)}
                      </Text>
                    </Button>
                  </Box>
                  <Box flexShrink={0}>
                    {stat(a.added, a.removed)}
                    <Text dimColor>{` ${age}`}</Text>
                  </Box>
                </Box>
              )
            })}
          </Box>,
        )}

        <Box flexDirection="row" height={1} gap={1} marginTop={0}>
          {maxTop > 0 ? <Button key="up" label="↑" hotkey="k" onPress={() => scrollCode($, -SCROLL_STEP)} /> : ''}
          {maxTop > 0 ? <Button key="down" label="↓" hotkey="j" onPress={() => scrollCode($, SCROLL_STEP)} /> : ''}
          {maxTop > 0 ? <Button key="top" label="top" hotkey="t" onPress={() => scrollCode($, -codeTotal)} /> : ''}
          {maxTop > 0 ? <Button key="end" label="end" hotkey="e" onPress={() => scrollCode($, codeTotal)} /> : ''}
          {nvimServer && focus?.path ? <Button key="nvim" label="nvim" hotkey="n" onPress={() => mirror($, focus)} /> : ''}
          {/* The row's free right side: what the whole session has touched. */}
          <Box flexGrow={1} flexShrink={1} justifyContent="flex-end">
            {files.length > 0 ? (
              <Text dimColor wrap="truncate-start">
                {`${files.length} ${files.length === 1 ? 'file' : 'files'}${totalAdded + totalRemoved > 0 ? ` · +${totalAdded} −${totalRemoved}` : ''}`}
              </Text>
            ) : (
              ''
            )}
          </Box>
        </Box>
      </Box>
    )
  })

  // The wheel over the code window scrolls the code, not the pane: the layout is fixed.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const at = drawn
    if (e.origin.kind !== 'person' || e.by === 0) return next(e)
    const row = e.pointer?.row
    const list = row === undefined ? undefined : drawnLists.find(l => row >= l.from && row < l.from + l.rows)
    if (list) {
      await scrollList($, list.name, Math.sign(e.by))
      return next({ ...e, offset: Math.max(0, e.offset - e.by) })
    }
    if (at === null) return next(e)
    if (row !== undefined && (row < at.codeTop || row >= at.codeTop + at.codeRows)) return next(e)
    // A page key asks for the body's height: page the code window instead.
    const by = row === undefined && Math.abs(e.by) >= e.bodyRows ? Math.sign(e.by) * at.codeRows : e.by
    await scrollCode($, by)
    return next({ ...e, offset: Math.max(0, e.offset - e.by) })
  }).catch(($, e, next) => next(e))
}
