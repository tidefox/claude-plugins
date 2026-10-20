import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Check, CheckBucket, Phase, WatchedPr } from '../types'

const PANE = 'ci-watch'
/** The dock width asked for beside a fullscreen transcript, as follow asks; the person's own drag wins. */
const SIDEBAR_COLUMNS = 64
const TICK_MS = 1000
const NO_CI_GRACE_MS = 5 * 60 * 1000
const CONFIRM_MS = 10 * 1000
const RERUN_HOLD_MS = 60 * 1000

const prs = atom({ plugin: 'ci-watch', key: 'prs' } as const, [])
const now = atom({ plugin: 'ci-watch', key: 'now' } as const, 0)
const paneShown = atom({ plugin: 'ci-watch', key: 'paneShown' } as const, false)
const pinned = atom({ plugin: 'ci-watch', key: 'pinned' } as const, null)

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g
const PR_REF = /([\w.-]+\/[\w.-]+)#(\d+)/
const PR_COMMAND = /\bgh\s+pr\s+(create|ready)\b/
const SPINNER = ['◐', '◓', '◑', '◒']

const GLYPH: Record<CheckBucket, string> = {
  pass: '✓',
  fail: '✗',
  pending: '●',
  skipping: '○',
  cancel: '⊘',
}
const COLOR: Record<CheckBucket, string> = {
  pass: 'success',
  fail: 'error',
  pending: 'warning',
  skipping: 'inactive',
  cancel: 'inactive',
}
const ORDER: Record<CheckBucket, number> = { fail: 0, cancel: 1, pending: 2, pass: 3, skipping: 4 }
const BADGE: Record<Phase, { label: string; color: string }> = {
  waiting: { label: 'WAITING', color: 'inactive' },
  running: { label: 'RUNNING', color: 'warning' },
  passed: { label: 'PASSED', color: 'success' },
  failed: { label: 'FAILED', color: 'error' },
  'no-ci': { label: 'NO CI', color: 'inactive' },
  error: { label: 'ERROR', color: 'error' },
}

export const isActive = (pr: WatchedPr) => pr.phase === 'waiting' || pr.phase === 'running' || pr.phase === 'error'

/** The PR a command's output names: the last github.com PR URL, else `owner/repo#N`. */
export function findPr(text: string): { url: string; repo: string; number: number } | null {
  const urls = [...text.matchAll(PR_URL)]
  const last = urls[urls.length - 1]
  if (last?.[1] && last[2]) {
    return { url: last[0], repo: last[1], number: Number(last[2]) }
  }
  const ref = PR_REF.exec(text)
  if (ref?.[1] && ref[2]) {
    return { url: `https://github.com/${ref[1]}/pull/${ref[2]}`, repo: ref[1], number: Number(ref[2]) }
  }

  return null
}

function toTime(iso: unknown): number | null {
  if (typeof iso !== 'string') return null
  const t = Date.parse(iso)
  // gh reports a check that has not started as 0001-01-01.
  return Number.isFinite(t) && t > 946684800000 ? t : null
}

export function parseChecks(stdout: string): Check[] {
  const rows = JSON.parse(stdout) as Record<string, unknown>[]
  return rows.map(row => ({
    name: String(row.name ?? ''),
    workflow: String(row.workflow ?? ''),
    bucket: (['pass', 'fail', 'pending', 'skipping', 'cancel'].includes(String(row.bucket))
      ? row.bucket
      : 'pending') as CheckBucket,
    link: String(row.link ?? ''),
    startedAt: toTime(row.startedAt),
    completedAt: toTime(row.completedAt),
  }))
}

export function phaseOf(checks: Check[]): Phase {
  if (checks.length === 0) return 'waiting'
  if (checks.some(c => c.bucket === 'pending')) return 'running'
  if (checks.some(c => c.bucket === 'fail' || c.bucket === 'cancel')) return 'failed'
  return 'passed'
}

function count(checks: Check[], bucket: CheckBucket) {
  return checks.filter(c => c.bucket === bucket).length
}

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function checkTime(c: Check, t: number) {
  if (c.startedAt === null) return ''
  return duration((c.completedAt ?? t) - c.startedAt)
}

function summary(pr: WatchedPr, t: number) {
  const done = pr.checks.filter(c => c.bucket !== 'pending').length
  const fails = count(pr.checks, 'fail') + count(pr.checks, 'cancel')
  const state =
    pr.phase === 'running'
      ? `${SPINNER[Math.floor(t / TICK_MS) % SPINNER.length]} ${done}/${pr.checks.length}${fails > 0 ? ` ✗${fails}` : ''}`
      : pr.phase === 'passed'
        ? `✓ passed`
        : pr.phase === 'failed'
          ? `✗ ${fails} failed`
          : pr.phase === 'waiting'
            ? '◌ waiting for checks'
            : pr.phase === 'no-ci'
              ? '○ no checks'
              : '⚠ gh error'
  return `CI #${pr.number} ${state}`
}

/** How long CI has run: first check start to last finish, else since the watch began. */
function ciElapsed(pr: WatchedPr, t: number) {
  const starts = pr.checks.map(c => c.startedAt).filter((v): v is number => v !== null)
  if (starts.length === 0) return duration((pr.finishedAt ?? t) - pr.addedAt)
  const ends = pr.checks.map(c => (c.bucket === 'pending' ? t : c.completedAt ?? t))
  return duration(Math.max(...ends) - Math.min(...starts))
}

/** A row of the checks list: one check, or a count standing in for those that did not fit. */
export type CheckLine = { check: Check } | { bucket: CheckBucket; text: string }

/**
 * The checks list in at most `room` rows: failing, then running, then passed, each by name.
 * Passed and skipped checks become one count each when the list runs out of room, and the
 * counts give way before any failing or running name does: those that still do not fit end
 * in an `N more` row.
 */
export function checkLines(checks: Check[], room: number): CheckLine[] {
  const sorted = [...checks].sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket] || a.name.localeCompare(b.name))
  const of = (...buckets: CheckBucket[]) => sorted.filter(c => buckets.includes(c.bucket))
  const head = of('fail', 'cancel', 'pending')
  const passed = of('pass')
  const skipped = of('skipping').length
  const tail: CheckLine[] = skipped > 0 ? [{ bucket: 'skipping', text: `${skipped} skipped` }] : []
  if (head.length + passed.length + tail.length <= room) return [...[...head, ...passed].map(check => ({ check })), ...tail]
  if (passed.length > 0) tail.unshift({ bucket: 'pass', text: `${passed.length} passed` })
  const kept = tail.slice(0, Math.max(0, room - head.length))
  if (head.length <= room) return [...head.map(check => ({ check })), ...kept]
  if (room <= 0) return []
  const shown = head.slice(0, room - 1)
  return [...shown.map(check => ({ check })), { bucket: head[shown.length]!.bucket, text: `${head.length - shown.length} more` }]
}

/** The PR the pane shows: the pinned one while it is watched, else the newest running, else the newest. */
export function focusOf(list: WatchedPr[], pin: string | null): WatchedPr | undefined {
  return list.find(pr => pr.url === pin) ?? list.find(isActive) ?? list[0]
}

/**
 * The fixed layout's rows, top to bottom: header, gap, the focused PR's block (title, branch,
 * bar, then the checks), gap + heading + rows for the PR list, and the buttons.
 */
export function paneLayout(bodyRows: number) {
  const listRows = bodyRows >= 34 ? 4 : 2
  const focusRows = Math.max(6, bodyRows - 2 - (2 + listRows) - 1)
  return { listRows, focusRows, checkRows: focusRows - 3 }
}

// ── cells (as follow measures them) ──────────────────────────────────────

/** East Asian Wide and Fullwidth: CJK, and the emoji a terminal draws two cells wide. */
const WIDE =
  /[\u1100-\u115f\u231a-\u231b\u2329-\u232a\u23e9-\u23ec\u23f0\u23f3\u25fd-\u25fe\u2614-\u2615\u2648-\u2653\u267f\u2693\u26a1\u26aa-\u26ab\u26bd-\u26be\u26c4-\u26c5\u26ce\u26d4\u26ea\u26f2-\u26f3\u26f5\u26fa\u26fd\u2705\u270a-\u270b\u2728\u274c\u274e\u2753-\u2755\u2757\u2795-\u2797\u27b0\u27bf\u2b1b-\u2b1c\u2b50\u2b55\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{16fe0}-\u{18cff}\u{1b000}-\u{1b2ff}\u{1f004}\u{1f0cf}\u{1f18e}\u{1f191}-\u{1f19a}\u{1f1e6}-\u{1f1ff}\u{1f200}-\u{1f2ff}\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f7e0}-\u{1f7eb}\u{1f90c}-\u{1f9ff}\u{1fa70}-\u{1faff}\u{20000}-\u{3fffd}]/u
const ZERO = /[\u0300-\u036f\u200b-\u200f\u20d0-\u20ff\ufe00-\ufe0f]/u

/** Terminal cells one character takes: two for wide (CJK, emoji), none for a combining mark. */
const charCells = (ch: string) => (ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1)
/** Printable ASCII, a cell a character: most names, measured and cut without a look at each character. */
const ASCII = /^[ -~]*$/

export function cellWidth(text: string): number {
  if (ASCII.test(text)) return text.length
  let n = 0
  for (const ch of text) n += charCells(ch)
  return n
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

let blockBackgroundOption = 'auto'
let themeName: string | null = null

async function theme($: EngineInterface): Promise<string> {
  themeName ??= String((await $.config.list().catch(() => [])).find(row => row.key === 'theme')?.value ?? '')
  return themeName
}

/** The blocks' fill: a shade dimmer than the terminal's, by theme, unless set in /config. */
async function blockBackground($: EngineInterface): Promise<string | undefined> {
  if (blockBackgroundOption === 'none') return undefined
  if (blockBackgroundOption !== 'auto') return blockBackgroundOption
  const name = await theme($)
  return /light/.test(name) ? '#eeeeee' : /ansi/.test(name) ? undefined : '#1c1c1c'
}

/** A PR row under the pointer: a step off the fill, by theme. */
async function rowHover($: EngineInterface): Promise<string> {
  const name = await theme($)
  return /light/.test(name) ? '#dcdcdc' : /ansi/.test(name) ? 'subtle' : '#303030'
}

let pollMs = 15000
let onFinish = 'notify'
const inFlight = new Set<string>()
let lastStatus: string | undefined

function patch($: EngineInterface, url: string, fields: Partial<WatchedPr>) {
  return update($, prs, list => list.map(pr => (pr.url === url ? { ...pr, ...fields } : pr)))
}

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: 'CI', columns: SIDEBAR_COLUMNS, rows: 30 })
  await update($, paneShown, () => opened.isPlaced)
}

async function watch($: EngineInterface, found: { url: string; repo: string; number: number }, isReady = false) {
  const t = await $.clock.now()
  const list = await read($, prs)
  const known = list.find(pr => pr.url === found.url)
  if (known) {
    // Marked ready for review: workflows that skip drafts start now, so watch again.
    if (isReady) {
      await patch($, found.url, { isDraft: false, phase: 'waiting', addedAt: t, polledAt: null, finishedAt: null, error: null, settleKey: null })
    }
  } else {
    const pr: WatchedPr = {
      ...found,
      title: '',
      isDraft: false,
      branch: '',
      phase: 'waiting',
      checks: [],
      addedAt: t,
      polledAt: null,
      finishedAt: null,
      error: null,
      settleKey: null,
      rerunAt: null,
    }
    await update($, prs, all => [pr, ...all.filter(p => p.url !== found.url)].slice(0, 8))
  }
  void openPane($)
}

async function announce($: EngineInterface, pr: WatchedPr) {
  const failed = pr.checks.filter(c => c.bucket === 'fail' || c.bucket === 'cancel')
  const text =
    pr.phase === 'passed'
      ? `✓ CI passed on #${pr.number} (${pr.checks.length} checks)`
      : pr.phase === 'failed'
        ? `✗ CI failed on #${pr.number}: ${failed.map(c => c.name).join(', ')}`
        : `No CI checks reported on #${pr.number}`
  $.ui.toast(text)
  void $.ui.notify(text, { title: pr.title ? `CI · ${pr.title}` : 'CI' })

  if (onFinish === 'notify' || pr.phase === 'no-ci') return
  const detail = failed.map(c => `- ${c.workflow ? `${c.workflow} / ` : ''}${c.name}: ${c.link}`).join('\n')
  const note = `[ci-watch] ${text}\nPR: ${pr.url}${detail ? `\nFailing checks:\n${detail}` : ''}`
  if (onFinish === 'fix-failures' && pr.phase === 'failed') {
    await $.prompt.submit({
      text: `${note}\n\nInvestigate the failing CI checks on this PR (gh run view --log-failed), fix them, and push.`,
    })
  } else {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  }
}

async function poll($: EngineInterface, pr: WatchedPr) {
  if (inFlight.has(pr.url)) return
  inFlight.add(pr.url)
  try {
    const t = await $.clock.now()
    await patch($, pr.url, { polledAt: t })

    if (pr.title === '') {
      const view = await $.process.run(['gh', 'pr', 'view', pr.url, '--json', 'title,isDraft,headRefName'])
      if (view.exitCode === 0) {
        const meta = JSON.parse(view.stdout) as { title?: string; isDraft?: boolean; headRefName?: string }
        await patch($, pr.url, { title: meta.title ?? '', isDraft: meta.isDraft === true, branch: meta.headRefName ?? '' })
      }
    }

    // gh exits 8 while checks are pending and 1 when one failed: the JSON is on stdout either way.
    const run = await $.process.run([
      'gh', 'pr', 'checks', pr.url, '--json', 'bucket,name,workflow,link,startedAt,completedAt',
    ])
    const out = run.stdout.trim()
    let next: Partial<WatchedPr>
    if (out.startsWith('[')) {
      const checks = parseChecks(out)
      next = { checks, phase: phaseOf(checks), error: null }
    } else if (/no checks reported/i.test(run.stderr)) {
      next = { checks: [], phase: t - pr.addedAt > NO_CI_GRACE_MS ? 'no-ci' : 'waiting', error: null }
    } else {
      next = { phase: 'error', error: (run.stderr.trim() || `gh exited ${run.exitCode}`).split('\n')[0] ?? null }
    }

    // Every check reported so far may be done while later jobs have yet to register, or a
    // re-run has yet to show: settle only when a second poll sees the same settled set.
    if (next.phase === 'passed' || next.phase === 'failed') {
      const key = (next.checks ?? []).map(c => `${c.name}:${c.bucket}`).sort().join('|')
      const isHeld = pr.rerunAt !== null && t - pr.rerunAt < RERUN_HOLD_MS
      if (isHeld || pr.settleKey !== key) {
        next = { ...next, phase: 'running', settleKey: isHeld ? null : key, polledAt: t - pollMs + CONFIRM_MS }
      }
    } else if (next.phase === 'running') {
      next = { ...next, settleKey: null, rerunAt: null }
    }

    const isDone = next.phase === 'passed' || next.phase === 'failed' || next.phase === 'no-ci'
    if (isDone) next.finishedAt = t
    await patch($, pr.url, next)
    if (isDone) {
      const settled = (await read($, prs)).find(p => p.url === pr.url)
      // A failed notice must never reopen a settled PR, or it would announce on every poll.
      if (settled) await announce($, settled).catch(() => undefined)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await patch($, pr.url, { phase: 'error', error: /ENOENT|not found|cannot start/i.test(message) ? 'gh is not installed or not on PATH' : message })
  } finally {
    inFlight.delete(pr.url)
  }
}

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  const list = await read($, prs)
  if (list.some(isActive)) await update($, now, () => t)
  for (const pr of list) {
    if (isActive(pr) && (pr.polledAt === null || t - pr.polledAt >= pollMs)) void poll($, pr)
  }

  const top = list.find(isActive) ?? list[0]
  const status = top ? summary(top, t) : undefined
  if (status !== lastStatus) {
    lastStatus = status
    $.ui.status(status)
  }
}

async function rerunFailed($: EngineInterface, pr: WatchedPr) {
  const runs = new Set<string>()
  for (const c of pr.checks) {
    const id = /\/actions\/runs\/(\d+)/.exec(c.link)?.[1]
    if (id && (c.bucket === 'fail' || c.bucket === 'cancel')) runs.add(id)
  }
  if (runs.size === 0) {
    $.ui.toast('No failed GitHub Actions runs to re-run')
    return
  }
  for (const id of runs) {
    const res = await $.process.run(['gh', 'run', 'rerun', id, '--failed', '-R', pr.repo])
    if (res.exitCode !== 0) {
      $.ui.toast(`Re-run of ${id} failed: ${res.stderr.trim().split('\n')[0] ?? ''}`)
      return
    }
  }
  $.ui.toast(`Re-running ${runs.size} failed workflow run${runs.size > 1 ? 's' : ''} on #${pr.number}`)
  const t = await $.clock.now()
  await patch($, pr.url, { phase: 'running', finishedAt: null, settleKey: null, rerunAt: t, polledAt: t - pollMs + 5000 })
}

export const register: Register = (on, options) => {
  pollMs = Math.max(5, Number(options.pollSeconds ?? 15)) * 1000
  onFinish = String(options.onFinish ?? 'notify')
  blockBackgroundOption = String(options.blockBackground ?? 'auto').trim() || 'auto'
  themeName = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ci',
      description: 'CI watcher: open the pane, or watch <PR url|owner/repo#N>, clear, stop',
      argumentHint: '[watch <pr> | clear | stop]',
      immediate: true,
    })
    $.clock.every(TICK_MS, () => void tick($))
    if ((await read($, prs)).length > 0) void openPane($)

    return next(e)
  })

  on('command.run', { command: 'ci' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'watch') {
      const arg = rest.join(' ')
      const found = findPr(arg)
      if (!found) return { text: 'Usage: /ci watch <https://github.com/owner/repo/pull/N | owner/repo#N>' }
      await watch($, found)
      return { text: `Watching CI on ${found.repo}#${found.number}` }
    }
    if (verb === 'clear') {
      await update($, prs, list => list.filter(isActive))
      return { text: 'Cleared finished PRs.' }
    }
    if (verb === 'stop') {
      await update($, prs, () => [])
      await update($, pinned, () => null)
      lastStatus = undefined
      $.ui.status(undefined)
      await $.ui.close({ id: PANE })
      return { text: 'Stopped watching all PRs.' }
    }
    await openPane($)
    return { text: 'CI pane opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const match = PR_COMMAND.exec(e.command)
    if (!match) return next(e)
    const ran = await next(e)
    const found = findPr(ran.text ?? '')
    if (found) void watch($, found, match[1] === 'ready')

    return ran
  }).catch(($, e, next) => next(e))

  // GitHub MCP servers' create / ready tools.
  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    if (!name.startsWith('mcp__') || !/(create_pull_request|ready_for_review)/i.test(name)) return next(e)
    const ran = await next(e)
    const found = ran.isError ? null : findPr(ran.text ?? '')
    if (found) void watch($, found, /ready/i.test(name))

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, paneShown, () => false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const list = await read($, prs)
    const pin = await read($, pinned)
    const t = Math.max(await read($, now), await $.clock.now())
    const width = Math.max(24, e.props.bodyColumns)
    const focus = focusOf(list, pin)
    const isPinned = focus !== undefined && focus.url === pin
    const isIdle = list.length === 0
    const active = list.filter(isActive).length
    const spin = SPINNER[Math.floor(t / TICK_MS) % SPINNER.length] ?? '●'

    // A fixed layout as tall as the body: the checks take what the header and the PR list leave.
    const rows = Math.max(16, e.props.scroll.bodyRows)
    const layout = paneLayout(rows)
    // A block's text runs between the pane's padding, its accent bar and its own padding.
    const inner = width - 5
    const panel = await blockBackground($)
    const hover = await rowHover($)

    const chip = isIdle
      ? { text: '○ IDLE', color: 'inactive' }
      : isPinned
        ? { text: '◎ PINNED', color: 'warning' }
        : active > 0
          ? { text: '● LIVE', color: 'claude' }
          : { text: '○ SETTLED', color: 'inactive' }
    const who = isIdle ? 'waiting for a pull request' : active > 0 ? `${active} running · every ${pollMs / 1000}s` : 'all settled'

    const badge = (phase: Phase) => (
      <Text bold color="inverseText" backgroundColor={BADGE[phase].color}>
        {` ${phase === 'running' ? `${spin} ` : ''}${BADGE[phase].label} `}
      </Text>
    )
    const fails = (pr: WatchedPr) => count(pr.checks, 'fail') + count(pr.checks, 'cancel')
    const tally = (pr: WatchedPr) => (
      <Text>
        <Text bold backgroundColor="diffAddedWord">{` ✓${count(pr.checks, 'pass')} `}</Text>
        <Text bold backgroundColor="diffRemovedWord">{` ✗${fails(pr)} `}</Text>
        <Text bold color="warning">{` ●${count(pr.checks, 'pending')} `}</Text>
      </Text>
    )
    const tallyWidth = (pr: WatchedPr) => `${count(pr.checks, 'pass')}${fails(pr)}${count(pr.checks, 'pending')}`.length + 9

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

    const bar = (pr: WatchedPr, room: number) => {
      const total = pr.checks.length
      if (total === 0) return <Text color="subtle">{'─'.repeat(room)}</Text>
      const segments = (['pass', 'fail', 'cancel', 'pending', 'skipping'] as const).map(b => [b, count(pr.checks, b)] as const)
      let used = 0
      const cells = segments.map(([b, n], i) => {
        const cellsFor = i === segments.length - 1 ? room - used : Math.round((n / total) * room)
        used += cellsFor
        return [b, cellsFor] as const
      })
      return (
        <Text>
          {cells.filter(([, n]) => n > 0).map(([b, n]) => (
            <Text color={COLOR[b]} dimColor={b === 'skipping' || b === 'cancel'}>
              {(b === 'pending' ? '╍' : '━').repeat(n)}
            </Text>
          ))}
        </Text>
      )
    }

    const checkRow = (line: CheckLine, i: number) => {
      if (!('check' in line)) {
        return (
          <Text key={`more:${i}`} wrap="truncate-end">
            <Text color={COLOR[line.bucket]}>{line.bucket === 'pending' ? spin : GLYPH[line.bucket]}</Text>
            <Text dimColor> {line.text}</Text>
          </Text>
        )
      }
      const c = line.check
      const time = checkTime(c, t)
      // The glyph and a space; the duration and a space on the right.
      const room = Math.max(4, inner - 2 - (time ? time.length + 1 : 0))
      const flow = c.workflow && c.workflow !== c.name ? clip(c.workflow, Math.floor(room / 3)) : ''
      const name = clip(c.name, room - (flow ? cellWidth(flow) + 3 : 0))
      const isQuiet = c.bucket === 'pass' || c.bucket === 'skipping'
      return (
        <Box key={`check:${i}`} flexDirection="row" height={1}>
          <Box flexShrink={0}>
            <Text color={COLOR[c.bucket]}>{c.bucket === 'pending' ? spin : GLYPH[c.bucket]} </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end" dimColor={isQuiet} bold={c.bucket === 'fail'}>
              {flow ? <Text dimColor>{flow} › </Text> : ''}
              {c.link ? <Link href={c.link}>{name}</Link> : name}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>{time ? ` ${time}` : ''}</Text>
          </Box>
        </Box>
      )
    }

    const focusBlock = (pr: WatchedPr) => {
      const elapsed = ciElapsed(pr, t)
      const done = pr.checks.filter(c => c.bucket !== 'pending').length
      const notes = [
        pr.phase === 'waiting' ? <Text dimColor>{spin} Waiting for checks to be reported…</Text> : null,
        pr.phase === 'no-ci' ? <Text dimColor>○ No checks were reported for this PR.</Text> : null,
        pr.error ? <Text color="error" wrap="truncate-end">⚠ {pr.error}</Text> : null,
      ].filter(n => n !== null)
      const lines = checkLines(pr.checks, layout.checkRows - notes.length)
      // The number, the draft tag and the badge keep their cells: only the title gives way.
      const badgeWidth = BADGE[pr.phase].label.length + 2 + (pr.phase === 'running' ? 2 : 0)
      const titleRoom = inner - 1 - String(pr.number).length - 1 - (pr.isDraft ? 6 : 0) - 1 - badgeWidth
      const timing = ` ${pr.checks.length > 0 ? `${done}/${pr.checks.length} · ` : ''}⏱ ${elapsed}`
      const branchRoom = inner - cellWidth(timing) - cellWidth(pr.repo)
      return block(
        'focus',
        isPinned ? 'warning' : BADGE[pr.phase].color,
        layout.focusRows,
        <Box flexDirection="column">
          <Box flexDirection="row" height={1}>
            <Box flexShrink={0}>
              <Text bold color="claude">#{pr.number}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold wrap="truncate-end">{` ${clip(pr.title || pr.repo, titleRoom)}`}</Text>
            </Box>
            <Box flexShrink={0}>
              {pr.isDraft ? <Text color="inactive">{' DRAFT'}</Text> : ''}
              <Text> </Text>
              {badge(pr.phase)}
            </Box>
          </Box>
          <Box flexDirection="row" height={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                <Link href={pr.url}>{pr.repo}</Link>
                {pr.branch ? clip(` ⎇ ${pr.branch}`, branchRoom) : ''}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>{timing}</Text>
            </Box>
          </Box>
          <Box flexDirection="row" height={1}>
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              {bar(pr, Math.max(4, inner - tallyWidth(pr) - 1))}
            </Box>
            <Box flexShrink={0}>
              <Text> </Text>
              {tally(pr)}
            </Box>
          </Box>
          {notes}
          {lines.map(checkRow)}
        </Box>,
      )
    }

    const idleBlock = () =>
      block(
        'idle',
        'claude',
        layout.focusRows,
        <Box flexDirection="column">
          <Text bold color="claude">◉ No pull requests watched yet.</Text>
          <Text dimColor wrap="wrap">They show up here when Claude runs gh pr create or gh pr ready, or with /ci watch owner/repo#123.</Text>
          <Box marginTop={1} flexDirection="row" gap={1}>
            {(['running', 'passed', 'failed'] as const).map(phase => (
              <Text key={`k:${phase}`} bold color="inverseText" backgroundColor={BADGE[phase].color}>{` ${BADGE[phase].label} `}</Text>
            ))}
            <Text dimColor>where CI stands</Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            {(['pass', 'fail', 'pending', 'skipping'] as const).map(b => (
              <Text key={`g:${b}`} color={COLOR[b]}>{GLYPH[b]}</Text>
            ))}
            <Text dimColor>each check</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text color="success">━━</Text>
              <Text color="error">━</Text>
              <Text color="warning">╍╍</Text>
              <Text dimColor> the checks so far   </Text>
              <Text bold backgroundColor="diffAddedWord">{' ✓N '}</Text>
              <Text bold backgroundColor="diffRemovedWord">{' ✗M '}</Text>
            </Text>
            <Text dimColor wrap="wrap">click a PR to pin it · f follow live · u refresh · /ci clear</Text>
          </Box>
        </Box>,
      )

    const prRow = (pr: WatchedPr) => {
      const isFocus = pr.url === focus?.url
      const age = ciElapsed(pr, t)
      const tallyText = pr.checks.length > 0 ? ` ✓${count(pr.checks, 'pass')}${fails(pr) > 0 ? ` ✗${fails(pr)}` : ''}` : ''
      // ▸, the phase glyph and a space, `#N` and a space; the tally, a space and the age on the right.
      const room = inner - 3 - String(pr.number).length - 2 - tallyText.length - 1 - age.length
      return (
        // The whole row lights under the pointer, not only its text.
        <Box key={`p:${pr.url}`} flexDirection="row" height={1} hover={{ backgroundColor: hover }}>
          <Box flexGrow={1} flexShrink={1}>
            <Button key={`pr:${pr.url}`} plain onPress={() => update($, pinned, () => pr.url)}>
              <Text color={isFocus ? 'claude' : 'subtle'}>{isFocus ? '▸' : ' '}</Text>
              <Text color={BADGE[pr.phase].color}>{pr.phase === 'running' ? spin : pr.phase === 'passed' ? '✓' : pr.phase === 'failed' ? '✗' : pr.phase === 'error' ? '⚠' : '○'}</Text>{' '}
              <Text bold color={isFocus ? 'claude' : undefined}>#{pr.number}</Text>{' '}
              <Text dimColor={!isFocus && !isActive(pr)} bold={isFocus}>{clip(pr.title || pr.repo, room)}</Text>
            </Button>
          </Box>
          <Box flexShrink={0}>
            {pr.checks.length > 0 ? (
              <Text>
                {' '}
                <Text color="success">✓{count(pr.checks, 'pass')}</Text>
                {fails(pr) > 0 ? <Text color="error"> ✗{fails(pr)}</Text> : ''}
              </Text>
            ) : (
              ''
            )}
            <Text dimColor>{` ${age}`}</Text>
          </Box>
        </Box>
      )
    }

    const canRerun = focus !== undefined && fails(focus) > 0 && focus.phase !== 'running'

    return (
      <Box flexDirection="column" paddingX={1} height={rows} overflow="hidden">
        <Box flexDirection="row" height={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              <Text bold color="claude">CI watch</Text>
              <Text dimColor>  {who}</Text>
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Text bold color={chip.color}>{chip.text}</Text>
            {isPinned ? <Button key="live" label="⟲ follow live" variant="primary" hotkey="f" onPress={() => update($, pinned, () => null)} /> : ''}
          </Box>
        </Box>

        {focus ? focusBlock(focus) : idleBlock()}

        {block(
          'prs',
          'subtle',
          layout.listRows + 1,
          <Box flexDirection="column">
            {heading('Pull requests', list.length > layout.listRows ? `${layout.listRows} of ${list.length}` : String(list.length))}
            {isIdle ? <Text dimColor>○ none yet</Text> : ''}
            {list.slice(0, layout.listRows).map(prRow)}
          </Box>,
        )}

        <Box flexDirection="row" height={1} gap={1}>
          {focus && canRerun ? (
            <Button key={`rerun:${focus.url}`} label="re-run failed" variant="primary" onPress={() => rerunFailed($, focus)} />
          ) : (
            ''
          )}
          {focus ? (
            <Button
              key={`refresh:${focus.url}`}
              label="refresh"
              hotkey="u"
              onPress={() => patch($, focus.url, { phase: isActive(focus) ? focus.phase : 'running', finishedAt: null, settleKey: null, polledAt: null })}
            />
          ) : (
            ''
          )}
          {focus ? (
            <Button
              key={`unwatch:${focus.url}`}
              label="unwatch"
              dimColor
              onPress={() => update($, prs, all => all.filter(p => p.url !== focus.url))}
            />
          ) : (
            ''
          )}
          {list.some(pr => !isActive(pr)) ? (
            <Button key="clear" label="clear settled" dimColor onPress={() => update($, prs, all => all.filter(isActive))} />
          ) : (
            ''
          )}
        </Box>
      </Box>
    )
  })

  // A one-line band for when the pane waits undrawn (a narrow terminal it opened on unasked).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, prs)
    const pr = list.find(isActive)
    if (!pr || e.props.hasSurvey || (await read($, paneShown))) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const t = Math.max(await read($, now), await $.clock.now())
    const fails = count(pr.checks, 'fail')
    const spin = SPINNER[Math.floor(t / TICK_MS) % SPINNER.length] ?? '●'
    const done = pr.checks.filter(c => c.bucket !== 'pending').length

    return (
      <Box flexDirection="row" gap={1}>
        <Text bold color="inverseText" backgroundColor={BADGE[pr.phase].color}>
          {` ${pr.phase === 'running' ? `${spin} ` : ''}${BADGE[pr.phase].label} `}
        </Text>
        <Text bold color="claude">CI #{pr.number}</Text>
        {pr.checks.length > 0 && <Text dimColor>{done}/{pr.checks.length}</Text>}
        <Text dimColor wrap="truncate-end">{pr.title}</Text>
        {fails > 0 && <Text bold backgroundColor="diffRemovedWord">{` ✗${fails} `}</Text>}
        <Button key="ci-open" label="details" plain hotkey="c" onPress={() => openPane($)} />
      </Box>
    )
  })
}
