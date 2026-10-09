import { expect, mock, test } from 'claude-code/testing'

import { findPr, parseChecks, phaseOf } from './register'

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

test('reads check buckets into a phase', async () => {
  expect(phaseOf(parseChecks(checks(['pass', 'pending'])))).toBe('running')
  expect(phaseOf(parseChecks(checks(['pass', 'fail'])))).toBe('failed')
  expect(phaseOf(parseChecks(checks(['pass', 'skipping'])))).toBe('passed')
  expect(parseChecks(checks(['pending']))[0]?.completedAt).toBe(null)
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
  expect(status.some(s => s?.startsWith('CI #42'))).toBe(true)

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
