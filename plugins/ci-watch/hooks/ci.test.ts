import { expect, mock, test } from 'claude-code/testing'

import { STRIP_FADE_MS, UNFOCUSED_SLOWDOWN, checkLines, ciState, findPr, focusOf, paneLayout, parseChecks, parseRuns, phaseOf, stripOf, wrapCells } from './register'
import type { WatchedPr } from '../types'

const URL = 'https://github.com/acme/app/pull/42'

const checks = (buckets: string[]) =>
  JSON.stringify(
    buckets.map((bucket, i) => ({
      bucket,
      name: `job-${i}`,
      workflow: 'ci',
      link: `https://github.com/acme/app/actions/runs/9${i}/job/1`,
      startedAt: '2026-10-09T10:00:00Z',
      completedAt: bucket === 'pending' ? '0001-01-01T00:00:00Z' : '2026-10-09T10:01:05Z',
    })),
  )

test('finds the PR in gh output', async () => {
  expect(findPr(`Creating draft pull request\n${URL}\n`)?.number).toBe(42)
  expect(findPr('✓ Pull request acme/app#7 is marked as "ready for review"')?.url).toBe(
    'https://github.com/acme/app/pull/7',
  )
  expect(findPr('nothing here')).toBe(null)
})

test('wraps a title at spaces, cutting only a word wider than a row', async () => {
  expect(wrapCells('feat(engine-bin): one binary for every engine', 20)).toEqual(['feat(engine-bin):', 'one binary for every', 'engine'])
  expect(wrapCells('short', 20)).toEqual(['short'])
  expect(wrapCells('a reallyreallylongword', 8)).toEqual(['a', 'reallyr…'])
  expect(wrapCells('', 8)).toEqual([])
})

test('reads check buckets into a phase', async () => {
  expect(phaseOf(parseChecks(checks(['pass', 'pending'])))).toBe('running')
  expect(phaseOf(parseChecks(checks(['pass', 'fail'])))).toBe('failed')
  expect(phaseOf(parseChecks(checks(['pass', 'skipping'])))).toBe('passed')
  expect(parseChecks(checks(['pending']))[0]?.completedAt).toBe(null)
})

test('fits the checks list to its rows: failures first, passed and skipped collapsed', async () => {
  const list = parseChecks(checks(['pass', 'pass', 'fail', 'pending', 'skipping', 'pass']))
  const text = (room: number) => checkLines(list, room).map(l => ('check' in l ? `${l.check.bucket}:${l.check.name}` : l.text))
  expect(text(10)).toEqual(['fail:job-2', 'pending:job-3', 'pass:job-0', 'pass:job-1', 'pass:job-5', '1 skipped'])
  expect(text(4)).toEqual(['fail:job-2', 'pending:job-3', '3 passed', '1 skipped'])
  // The counts give way before a failure's name does.
  expect(text(3)).toEqual(['fail:job-2', 'pending:job-3', '3 passed'])
  expect(text(2)).toEqual(['fail:job-2', 'pending:job-3'])
  expect(text(1)).toEqual(['2 more'])
  // The layout keeps the header, the PR list and the buttons: the checks get the rest.
  expect(paneLayout(30)).toEqual({ listRows: 6, cardRows: 13 })
  expect(paneLayout(40)).toEqual({ listRows: 6, cardRows: 23 })
})

test('focuses the pinned PR, else the newest running one', async () => {
  const pr = (number: number, phase: 'running' | 'passed') =>
    ({ url: `u${number}`, number, phase }) as Parameters<typeof focusOf>[0][number]
  const list = [pr(3, 'passed'), pr(2, 'running'), pr(1, 'running')]
  expect(focusOf(list, null)?.number).toBe(2)
  expect(focusOf(list, 'u1')?.number).toBe(1)
  expect(focusOf(list, 'gone')?.number).toBe(2)
  expect(focusOf([pr(3, 'passed')], null)?.number).toBe(3)
})

test('draws the whole layout blank before any PR is watched', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-09T10:00:00Z') })
  on('config.list', () => ({ value: [{ key: 'theme', value: 'dark' }] }) as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'ci-watch',
      surface,
      component: 'Pane',
      requestId: 'ci-watch',
      props: { title: 'CI', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as never,
    })
    expect(await ui.find({ type: 'Text', text: /○ IDLE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No pull requests watched yet/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Pull requests$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /none yet/ })).toBeDefined()
    await ui.unmount()
  }
})

test('keeps a narrow pane inside its cells: whole badge, tally and times, long names cut', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-09T10:00:00Z') })
  const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
  for (const event of ['command.register', 'ui.status', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }) as never)
  const long = 'x'.repeat(100)
  on('process.run', (_, e) =>
    e.argv[2] === 'view'
      ? ok(JSON.stringify({ title: `Retry ${long}`, isDraft: true, headRefName: `feat/${long}` }))
      : ok(
          JSON.stringify(
            ['pass', 'fail'].map((bucket, i) => ({
              bucket,
              name: `${bucket}-job-${long}`,
              workflow: `workflow-${long}`,
              link: `https://github.com/acme/app/actions/runs/9${i}/job/1`,
              startedAt: '2026-10-09T10:00:00Z',
              completedAt: '2026-10-09T10:01:05Z',
            })),
          ),
          1,
        ),
  )
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: URL, stderr: '' }, text: URL }) as never)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await clock.advance(1000)
  await clock.advance(10000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'ci-watch',
      surface,
      component: 'Pane',
      requestId: 'ci-watch',
      props: { title: 'CI', isFocused: false, bodyColumns: 30, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as never,
    })
    await ui.drawn()
    expect(await ui.find({ type: 'Text', text: ' FAILED ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' ✓1 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' ✗1 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 1m05s' })).toBeDefined()
    // The title wraps onto its own rows; a word wider than the row and a check's name are cut.
    expect(await ui.find({ type: 'Text', text: 'Retry' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '    xxxxxxx…' })).toBeDefined()
    // The PR's URL has a row of its own: an anchor on desktop, plain text a terminal links itself.
    expect(await ui.find({ type: surface === 'desktop' ? 'Link' : 'Text', text: URL })).toBeDefined()
    expect(await ui.find({ type: surface === 'desktop' ? 'Link' : 'Text', text: 'fail-jo…' })).toBeDefined()
    await ui.unmount()
  }
})

test('watches a PR the agent opens until CI settles', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-09T10:00:00Z') })
  const toasts: string[] = []
  const status: (string | undefined)[] = []
  let opened = 0
  let polls = 0
  const replies = [
    { exitCode: 1, stdout: '', stderr: 'no checks reported on the \'feat\' branch' },
    { exitCode: 8, stdout: checks(['pass', 'pending', 'pending']), stderr: '' },
    { exitCode: 1, stdout: checks(['pass', 'fail', 'pass']), stderr: '' },
    { exitCode: 1, stdout: checks(['pass', 'fail', 'pass']), stderr: '' },
  ]

  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => {
    opened += 1
    return { value: { isPlaced: true } } as never
  })
  on('ui.status', (_, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }) as never)
  on('process.run', (_, e) => {
    const argv = e.argv
    if (argv[1] === 'run') {
      return { value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    }
    if (argv[2] === 'view') {
      return { value: { exitCode: 0, stdout: JSON.stringify({ title: 'Add retries', isDraft: true, headRefName: 'feat' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    }
    polls += 1
    const reply = replies.shift() ?? replies[replies.length - 1]
    return { value: { ...reply, isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: `${URL}\n`, stderr: '' }, text: `${URL}\n` }) as never)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Bash', command: 'git push -u origin feat && gh pr create --draft --fill' })
  expect(ran.text).toContain(URL)
  await clock.settle()
  expect(opened).toBeGreaterThan(0)

  const pane = (surface: 'terminal' | 'desktop' = 'terminal') =>
    $.ui.mount({
      plugin: 'ci-watch',
      surface,
      component: 'Pane',
      requestId: 'ci-watch',
      props: {
        title: 'CI',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { top: 0, bodyRows: 30 },
        view: {},
      } as never,
    })
  const shows = async (text: RegExp) => {
    const ui = await pane()
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found !== undefined
  }

  // First poll: the title arrives, no checks yet.
  await clock.advance(1000)
  expect(await shows(/WAITING/)).toBe(true)
  expect(await shows(/Waiting for checks/)).toBe(true)

  // Second poll: running.
  await clock.advance(15000)
  expect(await shows(/RUNNING/)).toBe(true)

  // Third poll: all checks done, one failed; not settled until a poll confirms it.
  await clock.advance(15000)
  expect(await shows(/RUNNING/)).toBe(true)
  expect(toasts).toHaveLength(0)

  // Fourth poll, ten seconds on: the same set again, so it settles and says so.
  await clock.advance(10000)
  expect(await shows(/FAILED/)).toBe(true)
  expect(toasts.some(t => t.includes('CI failed on #42') && t.includes('job-1'))).toBe(true)

  // Settled PRs are no longer polled.
  expect(polls).toBe(4)
  await clock.advance(60000)
  expect(polls).toBe(4)

  // The pane draws on every surface that places panes; unwatch empties it.
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await pane(surface)
    await ui.drawn()
    expect(await ui.find({ key: `rerun:${URL}` })).toBeDefined()
    await ui.unmount()
  }
  // The PR's row pins it; follow live lets it go.
  const listed = await pane()
  expect(await listed.find({ type: 'Text', text: /^Pull requests$/ })).toBeDefined()
  expect(await listed.find({ type: 'Text', text: / FAILED / })).toBeDefined()
  await listed.press({ key: `pr:${URL}` })
  expect(await listed.find({ type: 'Text', text: /◎ PINNED/ })).toBeDefined()
  await listed.press({ key: 'live' })
  expect(await listed.find({ type: 'Text', text: /○ SETTLED/ })).toBeDefined()
  await listed.unmount()

  const ui = await pane()
  await ui.press({ key: `unwatch:${URL}` })
  expect(await ui.find({ type: 'Text', text: /No pull requests watched yet/ })).toBeDefined()
  await ui.unmount()
})

test('leaves other Bash commands alone', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: URL, stderr: '' }, text: URL }) as never)
  on('ui.open', () => {
    throw new Error('opened a pane for a non-PR command')
  })
  const ran = await $.tool.call({ tool: 'Bash', command: 'echo ' + URL })
  expect(ran.text).toBe(URL)
})

test('tells Claude the result when onFinish is tell-claude', { options: { onFinish: 'tell-claude' } }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-09T10:00:00Z') })
  const session = mock.session(on)
  const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
  for (const event of ['command.register', 'ui.status', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }) as never)
  on('process.run', (_, e) =>
    e.argv[2] === 'view'
      ? ok(JSON.stringify({ title: 'Add retries', isDraft: false, headRefName: 'feat' }))
      : ok(checks(['pass', 'fail']), 1),
  )
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: URL, stderr: '' }, text: URL }) as never)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'gh pr ready 42' })
  await clock.advance(1000)
  await clock.advance(10000)

  const notes = session.appended().filter(row => row.origin.kind === 'plugin')
  expect(notes).toHaveLength(1)
  const text = JSON.stringify(notes[0]?.message.content)
  expect(text).toContain('CI failed on #42')
  expect(text).toContain('actions/runs/91')

  // Settled and told once: later ticks do not tell it again.
  await clock.advance(60000)
  expect(session.appended().filter(row => row.origin.kind === 'plugin')).toHaveLength(1)
})

test('stacks a card per PR and scrolls them inside their rows', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-09T10:00:00Z') })
  const other = 'https://github.com/acme/app/pull/43'
  for (const event of ['command.register', 'ui.status', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no checks reported', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const urls = [URL, other]
  on('tool.call', { tool: 'Bash' }, () => {
    const url = urls.shift() ?? other
    return { result: { stdout: url, stderr: '' }, text: url } as never
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await clock.advance(1000)

  const ui = await $.ui.mount({
    plugin: 'ci-watch',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'ci-watch',
    props: { title: 'CI', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 16 }, view: {} } as never,
  })
  // The newest PR's card fills the four rows; the older one waits below.
  expect(await ui.find({ key: `${other}:0` })).toBeDefined()
  expect(await ui.find({ key: `${URL}:0` })).toBeUndefined()
  await ui.press({ key: 'down' })
  await ui.press({ key: 'down' })
  expect(await ui.find({ key: `${URL}:0` })).toBeDefined()
  expect(await ui.find({ key: `${other}:0` })).toBeUndefined()
  await ui.unmount()
})

test('reads in-progress runs from gh run list', () => {
  const [run] = parseRuns(JSON.stringify([{ url: 'u', workflowName: 'ci', displayTitle: 't', headBranch: 'main', event: 'push', startedAt: '2026-10-09T10:00:00Z' }]))
  expect(run).toMatchObject({ url: 'u', name: 'ci', branch: 'main' })
  expect(run?.startedAt).toBe(Date.parse('2026-10-09T10:00:00Z'))
})

test('says the CI state in a few cells, and lights the edge strip by it', async () => {
  const check = (bucket: string) => ({ name: bucket, workflow: 'ci', bucket, link: '', startedAt: null, completedAt: null }) as WatchedPr['checks'][number]
  const pr = (phase: WatchedPr['phase'], buckets: string[], finishedAt: number | null = null) =>
    ({ number: 42, phase, checks: buckets.map(check), finishedAt }) as WatchedPr
  expect(ciState(pr('running', ['pass', 'pending', 'fail', 'pending']))).toBe('CI #42 2/4 ✗1')
  expect(ciState(pr('passed', ['pass']))).toBe('CI #42 ✓')
  expect(ciState(pr('no-ci', []))).toBeNull()

  // Running: lit bottom-up by the share done, red once anything failed.
  expect(stripOf(pr('running', ['pass', 'pending', 'pending', 'pending']), 0)).toEqual({ lit: 0.25, color: '#8a6410' })
  expect(stripOf(pr('running', ['fail', 'pending']), 0)).toEqual({ lit: 0.5, color: '#8a1c1c' })
  expect(stripOf(pr('failed', ['fail']), 0)).toEqual({ lit: 1, color: '#8a1c1c' })
  // A pass shows green a while, then goes out.
  expect(stripOf(pr('passed', ['pass'], 1000), 1000 + STRIP_FADE_MS - 1)).toEqual({ lit: 1, color: '#1f6e2a' })
  expect(stripOf(pr('passed', ['pass'], 1000), 1000 + STRIP_FADE_MS)).toBeNull()
  expect(stripOf(pr('no-ci', []), 0)).toBeNull()
})

test('a chip beside the prompt and a strip behind the transcript follow a running PR; polling rests while the window is away', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-09T10:00:00Z') })
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
  for (const event of ['command.register', 'ui.status', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.message', () => ({}) as never)
  let polls = 0
  on('process.run', (_, e) => {
    if (e.argv[2] === 'view') return ok(JSON.stringify({ title: 'Add drift', isDraft: false, headRefName: 'feat/drift' }))
    if (e.argv[2] === 'checks') polls++
    return ok(e.argv[1] === 'run' ? '[]' : checks(['pass', 'pending', 'pending', 'pending']))
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: URL, stderr: '' }, text: URL }) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await clock.advance(1000)

  const chip = await $.ui.mount({ plugin: 'ci-watch', surface: 'terminal', component: 'BesidePrompt', props: { maxColumns: 30, floatRows: 0, floatColumns: 0 } as never })
  expect((await chip.find({ type: 'Client' }))?.props).toMatchObject({ key: 'ci-chip', props: { text: 'CI #42 1/4', color: 'warning' } })

  const strip = await $.ui.mount({ plugin: 'ci-watch', surface: 'terminal', component: 'Underlay', props: { columns: 80, rows: 20, isWorking: false, view: { kind: 'main' }, plugins: ['ci-watch'] } as never })
  // A quarter done: 5 of 20 rows lit at the bottom, the rest dim.
  expect(await strip.find({ type: 'Box', key: 'lit' })).toMatchObject({ props: { height: 5, backgroundColor: '#8a6410' } })
  expect(await strip.find({ type: 'Box', key: 'rest' })).toMatchObject({ props: { height: 15 } })

  // Focused, a 15 s poll interval: four polls in a minute. With the window away, one.
  polls = 0
  await clock.advance(60_000)
  const focused = polls
  await chip.setWindowFocused(false)
  polls = 0
  await clock.advance(60_000)
  expect(focused).toBeGreaterThanOrEqual(4)
  expect(polls).toBeLessThanOrEqual(Math.ceil(focused / UNFOCUSED_SLOWDOWN))
  await chip.setWindowFocused(true)
  polls = 0
  await clock.advance(60_000)
  expect(polls).toBeGreaterThanOrEqual(4)

  // No room beside the prompt: no chip.
  const narrow = await $.ui.mount({ plugin: 'ci-watch', surface: 'terminal', component: 'BesidePrompt', props: { maxColumns: 4, floatRows: 0, floatColumns: 0 } as never })
  expect(await narrow.find({ type: 'Client' })).toBeUndefined()
  for (const ui of [chip, strip, narrow]) await ui.unmount()
})
