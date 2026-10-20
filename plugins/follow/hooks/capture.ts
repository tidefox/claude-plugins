import type { EngineInterface, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Activity, ActivityKind, FileView } from '../types'
import { buildHunk } from './diff'
import { BINARY, isScratchPath, namedPaths, parseShell, resultText, grepFiles, shellDir } from './parse'
import { EDIT_CONTEXT, HUNK_CAP, MAX_ACTIVITIES, MAX_FILE_CHARS, MAX_VIEWS, OUTPUT_LINES, READ_WINDOW, env, settings } from './state'
import { clean, lineOf, oneLine, splitLines } from './text'

// ── capture ────────────────────────────────────────────────────────────────

export const expandHome = (path: string) => (env.home && /^~(\/|$)/.test(path) ? `${env.home}${path.slice(1)}` : path)
/** `path` against `dir` (the calling loop's directory: a subagent's may be a worktree of its own). */
export const absolute = (path: string, dir: string) =>
  path.startsWith('/') || !dir ? path : `${dir.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`

export function relative(path: string) {
  if (env.root && path.startsWith(`${env.root}/`)) return path.slice(env.root.length + 1)
  const scratch = /\/scratchpad\/(.*)$/.exec(path)
  if (scratch) return `scratchpad/${scratch[1]}`
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/)/, '~')
}

export async function readText($: EngineInterface, path: string): Promise<string | null> {
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

export async function fileLines($: EngineInterface, path: string): Promise<string[] | null> {
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

export type Plan = {
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

/** What a command printed (stdout, then stderr), as a view the code window can scroll; null when it printed nothing. */
function outputView(command: string, ran: ToolCallResult): FileView | null {
  const r = ran.result as { stdout?: unknown; stderr?: unknown; interrupted?: unknown } | null | undefined
  const text = [r?.stdout, r?.stderr].filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => t.replace(/\n+$/, '')).join('\n')
  if (text === '') return null
  const lines = splitLines(text).map(clean)
  return {
    mode: 'output',
    command: oneLine(command),
    lines: lines.slice(0, OUTPUT_LINES),
    isCut: lines.length > OUTPUT_LINES,
    isFailed: r?.interrupted === true,
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
    after: async ran => {
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
      if (first) return { ...first, more }
      const view = outputView(command, ran)
      return view ? { view } : {}
    },
  }
}

const GREP_FILES = 6

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

export async function plan($: EngineInterface, e: ToolCallInput, here: string): Promise<Plan> {
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

const escapeVim = (path: string) => path.replace(/([ \\%#|"'])/g, '\\$1').replace(/</g, '<lt>')

export async function mirror($: EngineInterface, a: Activity) {
  if (!settings.nvimServer || a.path === null || a.kind === 'other') return
  const keys = `<C-\\><C-N>:e +${a.line ?? 1} ${escapeVim(a.path)}<CR>zz`
  try {
    const run = await $.process.run(['nvim', '--server', settings.nvimServer, '--remote-send', keys], { timeoutMs: 2000 })
    if (run.exitCode !== 0) $.ui.status(`follow: nvim at ${settings.nvimServer} did not answer`)
  } catch {
    $.ui.status('follow: nvim is not on PATH')
  }
}
