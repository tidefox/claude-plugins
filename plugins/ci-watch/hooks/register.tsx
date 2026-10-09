import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Check, CheckBucket, Phase, WatchedPr } from '../types'

const PANE = 'ci-watch'
const TICK_MS = 1000
const NO_CI_GRACE_MS = 5 * 60 * 1000
const CONFIRM_MS = 10 * 1000
const RERUN_HOLD_MS = 60 * 1000
const MAX_PASSED_ROWS = 4
const MAX_FAILED_ROWS = 8
const MAX_RUNNING_ROWS = 5

const prs = atom({ plugin: 'ci-watch', key: 'prs' } as const, [])
const now = atom({ plugin: 'ci-watch', key: 'now' } as const, 0)
const paneShown = atom({ plugin: 'ci-watch', key: 'paneShown' } as const, false)

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

let pollMs = 15000
let onFinish = 'notify'
const inFlight = new Set<string>()
let lastStatus: string | undefined

function patch($: EngineInterface, url: string, fields: Partial<WatchedPr>) {
  return update($, prs, list => list.map(pr => (pr.url === url ? { ...pr, ...fields } : pr)))
}

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: 'CI' })
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
    const t = Math.max(await read($, now), await $.clock.now())
    const width = Math.max(24, e.props.bodyColumns)

    if (list.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="claude">CI watch</Text>
          <Text dimColor>No pull requests watched yet.</Text>
          <Text dimColor>They show up here when Claude runs gh pr create or gh pr ready,</Text>
          <Text dimColor>or with /ci watch owner/repo#123.</Text>
        </Box>
      )
    }

    const spin = SPINNER[Math.floor(t / TICK_MS) % SPINNER.length] ?? '●'
    const inner = width - 4

    const bar = (pr: WatchedPr) => {
      const room = Math.max(8, inner - 22)
      const total = pr.checks.length
      if (total === 0) return <Text dimColor>{'─'.repeat(room)}</Text>
      const segments: [CheckBucket, number][] = (['pass', 'fail', 'cancel', 'pending', 'skipping'] as const).map(b => [b, count(pr.checks, b)])
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

    const clip = (text: string, room: number) =>
      text.length <= room ? text : room <= 1 ? '…' : `${text.slice(0, room - 1)}…`

    const row = (pr: WatchedPr, c: Check, i: number) => {
      const time = checkTime(c, t)
      const room = Math.max(6, inner - 3 - time.length)
      const flow = c.workflow && c.workflow !== c.name ? clip(c.workflow, Math.floor(room / 3)) : ''
      const name = clip(c.name, room - (flow ? flow.length + 3 : 0))
      return (
        <Box key={`${pr.number}-${i}`} flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end" dimColor={c.bucket === 'skipping'}>
              <Text color={COLOR[c.bucket]}>{c.bucket === 'pending' ? spin : GLYPH[c.bucket]} </Text>
              {flow ? <Text dimColor>{flow} › </Text> : ''}
              {c.link ? <Link href={c.link}>{name}</Link> : name}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor> {time}</Text>
          </Box>
        </Box>
      )
    }

    const more = (glyph: string, color: string, n: number, what: string) =>
      n > 0 ? (
        <Text>
          <Text color={color}>{glyph}</Text> <Text dimColor>{n} more {what}</Text>
        </Text>
      ) : (
        ''
      )

    const card = (pr: WatchedPr) => {
      const badge = BADGE[pr.phase]
      const sorted = [...pr.checks].sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket] || a.name.localeCompare(b.name))
      const failing = sorted.filter(c => c.bucket === 'fail' || c.bucket === 'cancel')
      const running = sorted.filter(c => c.bucket === 'pending')
      const passed = sorted.filter(c => c.bucket === 'pass')
      const shownFailing = failing.slice(0, MAX_FAILED_ROWS)
      const shownRunning = running.slice(0, MAX_RUNNING_ROWS)
      const shownPassed = passed.length <= MAX_PASSED_ROWS ? passed : []
      const shown = [...shownFailing, ...shownRunning, ...shownPassed]
      const skipped = count(pr.checks, 'skipping')
      const pending = count(pr.checks, 'pending')
      const hasFailures = count(pr.checks, 'fail') + count(pr.checks, 'cancel') > 0
      const elapsed = ciElapsed(pr, t)

      return (
        <Box key={pr.url} flexDirection="column" borderStyle="round" borderColor={badge.color} paddingX={1}>
          <Box flexDirection="row">
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                <Text bold color="claude">#{pr.number}</Text>{' '}
                <Link href={pr.url}>{pr.title || pr.repo}</Link>
              </Text>
            </Box>
            {pr.isDraft ? <Text color="inactive"> DRAFT </Text> : ''}
            <Text> </Text>
            <Text bold color="inverseText" backgroundColor={badge.color}>
              {' '}{pr.phase === 'running' ? `${spin} ` : ''}{badge.label}{' '}
            </Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {pr.repo}{pr.branch ? ` ⎇ ${pr.branch}` : ''} · ⏱ {elapsed}
          </Text>
          <Box flexDirection="row" marginTop={1}>
            {bar(pr)}
            <Text>
              {'  '}
              <Text color="success">✓{count(pr.checks, 'pass')}</Text>{' '}
              <Text color="error">✗{count(pr.checks, 'fail') + count(pr.checks, 'cancel')}</Text>{' '}
              <Text color="warning">●{pending}</Text>
            </Text>
          </Box>

          {pr.phase === 'waiting' && (
            <Text dimColor>{spin} Waiting for checks to be reported…</Text>
          )}
          {pr.phase === 'no-ci' && <Text dimColor>No checks were reported for this PR.</Text>}
          {pr.error && <Text color="error" wrap="truncate-end">⚠ {pr.error}</Text>}

          {shown.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {shownFailing.map((c, i) => row(pr, c, i))}
              {more('✗', 'error', failing.length - shownFailing.length, 'failed')}
              {shownRunning.map((c, i) => row(pr, c, MAX_FAILED_ROWS + i))}
              {more(spin, 'warning', running.length - shownRunning.length, 'running')}
              {shownPassed.map((c, i) => row(pr, c, MAX_FAILED_ROWS + MAX_RUNNING_ROWS + i))}
            </Box>
          )}
          {passed.length > MAX_PASSED_ROWS && (
            <Text>
              <Text color="success">✓</Text> <Text dimColor>{passed.length} checks passed</Text>
            </Text>
          )}
          {skipped > 0 && <Text dimColor>○ {skipped} skipped</Text>}

          <Box flexDirection="row" gap={2} marginTop={1}>
            {hasFailures && pr.phase !== 'running' && (
              <Button key={`rerun:${pr.url}`} label="re-run failed" variant="primary" onPress={() => rerunFailed($, pr)} />
            )}
            <Button
              key={`refresh:${pr.url}`}
              label="refresh"
              onPress={() => patch($, pr.url, { phase: isActive(pr) ? pr.phase : 'running', finishedAt: null, settleKey: null, polledAt: null })}
            />
            <Button
              key={`unwatch:${pr.url}`}
              label="unwatch"
              dimColor
              onPress={() => update($, prs, all => all.filter(p => p.url !== pr.url))}
            />
          </Box>
        </Box>
      )
    }

    const active = list.filter(isActive).length

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" paddingX={1}>
          <Box flexGrow={1}>
            <Text bold color="claude">⬡ CI watch</Text>
          </Box>
          <Text dimColor>
            {active > 0 ? `${active} running · every ${pollMs / 1000}s` : 'all settled'}
          </Text>
        </Box>
        {list.map(card)}
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

    return (
      <Box flexDirection="row" gap={1}>
        <Text color={BADGE[pr.phase].color}>{summary(pr, t)}</Text>
        <Text dimColor wrap="truncate-end">{pr.title}</Text>
        {fails > 0 && <Text color="error">{fails} failing</Text>}
        <Button key="ci-open" label="details" plain hotkey="c" onPress={() => openPane($)} />
      </Box>
    )
  })
}
