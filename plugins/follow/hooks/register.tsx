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
const HUNK_CAP = 80
const MAX_FILE_CHARS = 4_000_000
const TRAIL_ROWS = 6
const FILE_ROWS = 5

const activities = atom({ plugin: 'follow', key: 'activities' } as const, [])
const pinned = atom({ plugin: 'follow', key: 'pinned' } as const, null)

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

/**
 * What a shell command does to a file, for the common read and write spellings
 * (`cat`, `head`, `tail`, `sed -n A,Bp`, `nl`, `bat`; `>`, `>>`, `tee`). Null otherwise.
 */
export function parseShell(
  command: string,
): { kind: 'read' | 'write'; path: string; from?: number; to?: number } | null {
  const found = matchShell(command)
  // A path held in a shell variable cannot be followed.
  return found && found.path !== '' && !/[$`*?\u0001]/.test(found.path) ? found : null
}

function matchShell(command: string): { kind: 'read' | 'write'; path: string; from?: number; to?: number } | null {
  const { masked, restore } = mask(command)
  // A file operand: never an option, never a redirect.
  const file = `([^\\s<>|;&()-][^\\s<>|;&()]*)`

  const redirect = new RegExp(`(?:^|[^0-9&<>=-])>>?\\s*${file}`).exec(masked)
  if (redirect?.[1] && !/^\/dev\//.test(restore(redirect[1]))) return { kind: 'write', path: restore(redirect[1]) }
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
    const cat = new RegExp(`^(?:cat|bat|batcat|nl|tail|less|more)(?:\\s+-[\\w-]+(?:\\s+\\d+)?)*\\s+${file}$`).exec(seg)
    // `tail -n 20` with no file: the count is no file.
    if (cat?.[1] && !/^\d+$/.test(cat[1])) return { kind: 'read', path: restore(cat[1]) }
  }

  return null
}

const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tgz|xz|jar|wasm|so|dylib|exe|bin|woff2?|ttf|otf|mp[34]|mov|ipynb)$/i

const clean = (line: string) => line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

// ── capture ────────────────────────────────────────────────────────────────

let cwd = ''
let nvimServer = ''

const absolute = (path: string) => (path.startsWith('/') || !cwd ? path : `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`)

function relative(path: string) {
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  const scratch = /\/scratchpad\/(.*)$/.exec(path)
  if (scratch) return `scratchpad/${scratch[1]}`
  return path
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

type Plan = {
  activity: Omit<Activity, 'id' | 'agentId' | 'tool' | 'phase' | 'at'>
  /** Runs after the tool answered; what it returns is merged into the activity. */
  after?: (ran: ToolCallResult) => Promise<Partial<Activity>>
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

async function writePlan($: EngineInterface, path: string, label: string): Promise<Plan> {
  const before = await readText($, path)
  return {
    activity: { ...base('write', label, path), line: 1 },
    after: async () => {
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

async function plan($: EngineInterface, e: ToolCallInput): Promise<Plan> {
  const tool = String(e.tool)
  if (e.tool === 'Read') {
    const path = absolute(e.file_path)
    const from = Math.max(1, e.offset ?? 1)
    return readPlan($, path, from, e.limit ? from + e.limit - 1 : null, e.file_path)
  }
  if (e.tool === 'Edit') {
    const path = absolute(e.file_path)
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
        const after = ran.isError || ran.deny !== undefined || before === null ? null : await readText($, path)
        const view = after === null || before === null ? null : diffView(path, before, after)
        return view?.mode === 'diff' ? diffFields(view) : {}
      },
    }
  }
  if (e.tool === 'Write') return writePlan($, absolute(e.file_path), e.file_path)
  if (e.tool === 'NotebookEdit') return { activity: base('edit', e.notebook_path, absolute(e.notebook_path)) }
  if (e.tool === 'Bash') {
    const found = parseShell(e.command)
    if (found?.kind === 'read') return readPlan($, absolute(found.path), found.from ?? 1, found.to ?? null, e.command)
    if (found?.kind === 'write') return writePlan($, absolute(found.path), e.command)
    return { activity: base('shell', e.command) }
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const args = e as unknown as { pattern?: string; path?: string }
    return { activity: base('search', `${args.pattern ?? ''}${args.path ? `  in ${args.path}` : ''}`) }
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

/** Newest first; only the newest few (and the pinned one) keep their excerpt. */
function trim(list: Activity[], keep: string | null): Activity[] {
  return list
    .slice(0, MAX_ACTIVITIES)
    .map((a, i) => (i < MAX_VIEWS || a.id === keep || a.view === null ? a : { ...a, view: null }))
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
  a.path === null ? a.label : `${relative(a.path)}${a.line ? `:${a.line}${a.endLine && a.endLine > a.line ? `-${a.endLine}` : ''}` : ''}`

// ── drawing ────────────────────────────────────────────────────────────────

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Follow', columns: SIDEBAR_COLUMNS, rows: 30 })

const clip = (text: string, room: number) =>
  text.length <= room ? text : room <= 1 ? '…' : `${text.slice(0, room - 1)}…`

export const register: Register = (on, options) => {
  nvimServer = String(options.nvimServer ?? '').trim()

  on('session.start', async ($, e, next) => {
    cwd = await $.session.cwd()
    await $.command.register({
      name: 'follow',
      description: 'Follow the agent: open the live file pane, or `live`, `clear`',
      argumentHint: '[live | clear]',
      immediate: true,
    })
    void openPane($)

    return next(e)
  })

  on('command.run', { command: 'follow' }, async ($, e) => {
    const verb = e.args.trim()
    if (verb === 'clear') {
      await update($, activities, () => [])
      await update($, pinned, () => null)
      return { text: 'Follow trail cleared.' }
    }
    if (verb === 'live') await update($, pinned, () => null)
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
      p = await plan($, e)
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
    if (activity.kind !== 'other') $.ui.status(`◉ ${BADGE[activity.kind].label.toLowerCase()} ${clip(shortPath(activity), 48)}`)

    const ran = await next(e)
    const isError = ran.deny !== undefined || ran.isError === true
    const extra = p.after && !isError ? await p.after(ran).catch(() => ({})) : {}
    await update($, activities, list =>
      list.map((a): Activity => (a.id === activity.id ? { ...a, ...extra, phase: isError ? 'error' : 'done' } : a)),
    )

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const list = await read($, activities)
    const pin = await read($, pinned)
    const t = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns)
    const rows = e.props.scroll.bodyRows
    const viewed = e.props.view.agentId ?? null

    const mine = list.filter(a => a.agentId === viewed)
    // While the agent in view waits on a subagent, the subagent is where the work is.
    const isDelegating = mine[0]?.kind === 'agent' && mine[0].phase === 'running'
    const pool = mine.length > 0 && !isDelegating ? mine : list
    const pinnedOne = pin === null ? undefined : list.find(a => a.id === pin)
    const focus = pinnedOne ?? pool.find(a => a.view !== null) ?? pool.find(a => a.path !== null)
    const now = pool[0]

    let who = 'main agent'
    if (viewed !== null) {
      const agent = (await $.agent.list().catch(() => [])).find(a => a.id === viewed)
      who = agent ? `${agent.type}: ${agent.description}` : 'subagent'
    } else if (isDelegating) {
      who = `main › ${mine[0]?.label ?? 'subagent'}`
    } else if (mine.length === 0 && list.length > 0) {
      who = 'newest activity'
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
          <Text color="success">+{added}</Text> <Text color="error">−{removed}</Text>
        </Text>
      )
    const statWidth = (added: number | null, removed: number | null) =>
      added == null || removed == null ? 0 : `${added}${removed}`.length + 4
    const mark = (a: Activity) => (a.phase === 'running' ? '…' : a.phase === 'error' ? '✗' : '')

    if (list.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="claude">◉ Follow</Text>
          <Text dimColor>Nothing yet. Every file Claude reads, edits or writes</Text>
          <Text dimColor>shows up here, at the line it is working on.</Text>
        </Box>
      )
    }

    const codeRows = Math.max(6, e.props.placement === 'dock' ? rows - 9 - Math.min(FILE_ROWS, 3) - TRAIL_ROWS : 14)
    const inner = width - 2

    const fileBody = (view: FileView) => {
      if (view.mode === 'diff') {
        return (
          <Box flexDirection="column">
            <Code source={view.hunk} format="diff" path={view.path} wrap="truncate-end" />
            {view.isCut && <Text dimColor>… more lines changed</Text>}
          </Box>
        )
      }
      const total = view.lines.length
      const focusAt = Math.max(0, view.focusFrom - view.startLine)
      const first = focusAt <= codeRows / 3 ? 0 : Math.min(Math.max(0, total - codeRows), focusAt - Math.floor(codeRows / 3))
      const shown = view.lines.slice(first, first + codeRows)
      const startLine = view.startLine + first
      return (
        <Box flexDirection="row">
          <Box flexDirection="column" flexShrink={0}>
            {shown.map((_, i) => {
              const n = startLine + i
              const isFocus = n >= view.focusFrom && n <= view.focusTo
              return <Text color={isFocus ? 'claude' : 'subtle'}>{isFocus ? '▌' : ' '}</Text>
            })}
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Code source={shown.join('\n') || ' '} path={view.path} startLine={startLine} wrap="truncate-end" />
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

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              <Text bold color={pin === null ? 'claude' : 'inactive'}>{pin === null ? '◉ Following' : '◎ Pinned'}</Text>{' '}
              <Text dimColor>{who}</Text>
            </Text>
          </Box>
          {pin !== null ? (
            <Button key="live" label="follow live" variant="primary" hotkey="f" onPress={() => update($, pinned, () => null)} />
          ) : focus ? (
            <Button key="pin" label="pin" hotkey="p" onPress={() => update($, pinned, () => focus.id)} />
          ) : (
            ''
          )}
        </Box>

        {now && now !== focus && (
          <Text wrap="truncate-end" dimColor>
            now: {BADGE[now.kind].label.toLowerCase()} {clip(now.path === null ? now.label : shortPath(now), inner - 12)} {mark(now)}
          </Text>
        )}

        {focus ? (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row">
              {badge(focus)}
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-start" bold> {shortPath(focus)}</Text>
              </Box>
              {stat(focus.added, focus.removed)}
              <Text dimColor> {focus.phase === 'running' ? '…' : focus.phase === 'error' ? '✗' : ago(t - focus.at)}</Text>
            </Box>
            {focus.tool === 'Bash' ? <Text dimColor wrap="truncate-end">$ {focus.label}</Text> : ''}
            <Box marginTop={1} flexDirection="column">
              {focus.view ? fileBody(focus.view) : <Text dimColor>(no preview)</Text>}
            </Box>
          </Box>
        ) : (
          <Text dimColor>No file touched yet.</Text>
        )}

        {files.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>Files</Text>
            {files.slice(0, FILE_ROWS).map(f => (
              <Button key={`file:${f.path}`} plain onPress={() => update($, pinned, () => f.latest.id)}>
                <Text color="warning">{(['R', 'E', 'W'].map(l => (f.letters.has(l) ? l : '·')).join('')).padEnd(3)}</Text>{' '}
                {clip(relative(f.path), inner - 6 - statWidth(f.added, f.removed))}
                {isScratchPath(f.path) ? <Text color="remember"> ✎</Text> : ''}
                {stat(f.added, f.removed)}
              </Button>
            ))}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Trail</Text>
          {pool.slice(0, TRAIL_ROWS).map(a => (
            <Button key={`trail:${a.id}`} plain onPress={() => update($, pinned, () => a.id)}>
              <Text color={a.id === focus?.id ? 'claude' : 'subtle'}>{a.id === focus?.id ? '▸' : ' '}</Text>{' '}
              <Text color={BADGE[a.kind].color}>{BADGE[a.kind].label.toLowerCase().padEnd(6)}</Text>{' '}
              {clip(a.path === null ? a.label : shortPath(a), inner - 16 - statWidth(a.added, a.removed))}
              {stat(a.added, a.removed)}{' '}
              <Text dimColor>{mark(a) || ago(t - a.at)}</Text>
            </Button>
          ))}
        </Box>

        {nvimServer && focus?.path && (
          <Box marginTop={1}>
            <Button key="nvim" label="open in nvim" hotkey="n" onPress={() => mirror($, focus)} />
          </Box>
        )}
      </Box>
    )
  })
}
