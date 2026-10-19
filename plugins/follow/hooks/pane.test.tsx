import { expect, mock, test } from 'claude-code/testing'

const FILE = '/work/app/src/main.ts'
const SCRATCH = '/tmp/claude-501/proj/session/scratchpad/notes.md'

const props = (bodyRows = 40) => ({
  title: 'Follow',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows },
  view: {},
})

test('follows a read, an edit and a scratchpad write into the pane', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  const files = new Map<string, string>([
    [FILE, Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n') + '\n'],
  ])

  on('fs.read', (_, e) => {
    const text = files.get((e as { path: string }).path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('session.cwd', () => ({ value: '/work/app' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit') {
      const text = files.get(e.file_path) ?? ''
      files.set(e.file_path, text.replace(e.old_string, e.new_string))
    }
    if (e.tool === 'Write') files.set(e.file_path, e.content)
    return { result: {} as never, text: 'ok' }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'follow', surface, component: 'Pane', requestId: 'follow', props: props() })
    expect(await ui.find({ type: 'Text', text: /Nothing yet/ })).toBeDefined()
    await ui.unmount()
  }

  await $.tool.call({ tool: 'Read', file_path: FILE, offset: 10, limit: 5 })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'follow', surface, component: 'Pane', requestId: 'follow', props: props() })
    await ui.drawn()
    expect(await ui.find({ type: 'Text', text: /^Read$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /main\.ts:10-14/ })).toBeDefined()
    const code = await ui.find({ type: 'Code' })
    // The whole file, the read's first line a third of the way down the window.
    expect(code?.props.startLine).toBe(4)
    await ui.unmount()
  }

  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'const line20 = 20', new_string: 'const line20 = 2000\nconst extra = 1' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'follow', surface, component: 'Pane', requestId: 'follow', props: props() })
    await ui.drawn()
    expect(await ui.find({ type: 'Text', text: /^Edit$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /main\.ts:20/ })).toBeDefined()
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.format).toBe('diff')
    expect(String(code?.props.source)).toContain('@@ -17,7 +17,8 @@')
    expect(String(code?.props.source)).toContain('+const extra = 1')
    expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '−1' })).toBeDefined()
    await ui.unmount()
  }

  await $.tool.call({ tool: 'Write', file_path: SCRATCH, content: '# plan\n- one\n' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'follow', surface, component: 'Pane', requestId: 'follow', props: props() })
    await ui.drawn()
    expect(await ui.find({ type: 'Text', text: /^Write$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /scratch/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Button', text: /main\.ts/ })).not.toHaveLength(0)

    // Pinning an older trail row holds the view there.
    const rows = await ui.findAll({ type: 'Button' })
    const readRow = rows.find(r => /^trail:/.test(r.key ?? '') && /10-14/.test(r.text))
    expect(readRow).toBeDefined()
    await ui.press({ key: readRow?.key ?? '' })
    expect(await ui.find({ type: 'Text', text: /PINNED/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Read$/ })).toBeDefined()
    // The code window scrolls inside the fixed layout over the whole file.
    expect(await ui.find({ type: 'Text', text: 'lines 4–23 of 31' })).toBeDefined()
    await ui.press({ key: 'down' })
    expect(await ui.find({ type: 'Text', text: 'lines 7–26 of 31' })).toBeDefined()
    await ui.press({ key: 'up' })
    await ui.press({ key: 'up' })
    expect(await ui.find({ type: 'Text', text: 'lines 1–20 of 31' })).toBeDefined()
    await ui.press({ key: 'end' })
    expect(await ui.find({ type: 'Text', text: 'lines 12–31 of 31' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /PINNED/ })).toBeDefined()
    // The snap-back button sits beside the chip.
    expect(await ui.find({ type: 'Button', key: 'live' })).toBeDefined()
    expect(await ui.find({ type: 'Box', key: 'code' })).toMatchObject({ props: { height: 20 } })
    await ui.press({ key: 'live' })
    expect(await ui.find({ type: 'Text', text: /LIVE/ })).toBeDefined()
    await ui.unmount()
  }
})

test('follows a cd, trusts the tool over its snapshot, and starts over on /clear', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  const DEEP = '/work/app/src/deep/util.ts'
  const files = new Map<string, string>([
    [FILE, 'a\nb\nc\n'],
    [DEEP, Array.from({ length: 10 }, (_, i) => `export const u${i + 1} = ${i + 1}`).join('\n') + '\n'],
  ])
  const statuses: (string | undefined)[] = []

  on('fs.read', (_, e) => {
    const text = files.get((e as { path: string }).path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('session.cwd', () => ({ value: '/work/app' }) as never)
  on('session.root', () => ({ value: '/work/app' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', (_, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('session.end', () => ({ sessionId: 's1' }) as never)
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit' && e.new_string === 'HELD') return { result: { staged: true } as never, text: 'held' }
    if (e.tool === 'Edit') {
      // Someone else changed the file while the permission prompt was up: the tool saw `B`.
      const seen = files.get(e.file_path)!.replace('b', 'B')
      files.set(e.file_path, seen.replace(e.old_string, e.new_string))
      return { result: { originalFile: seen } as never, text: 'ok' }
    }
    if (e.tool === 'Bash' && e.command === 'sleep 99') throw new Error('interrupted')
    return { result: {} as never, text: 'ok' }
  })

  const mount = (surface: 'terminal' | 'desktop') =>
    $.ui.mount({ plugin: 'follow', surface, component: 'Pane', requestId: 'follow', props: props() })

  await $.tool.call({ tool: 'Bash', command: 'cd src/deep && sed -n 4,6p util.ts' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount(surface)
    await ui.drawn()
    expect(await ui.find({ type: 'Text', text: /deep\/util\.ts:4-6/ })).toBeDefined()
    expect(String((await ui.find({ type: 'Code' }))?.props.source)).toContain('export const u4 = 4')
    await ui.unmount()
  }

  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'c', new_string: 'C' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount(surface)
    await ui.drawn()
    const source = String((await ui.find({ type: 'Code' }))?.props.source)
    expect(source).toContain('-c')
    // The diff is against what the tool saw, so the other change is no part of it.
    expect(source).not.toContain('-b')
    await ui.unmount()
  }

  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'HELD' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount(surface)
    await ui.drawn()
    expect(await ui.find({ type: 'Text', text: /held for review/ })).toBeDefined()
    await ui.unmount()
  }

  await $.tool.call({ tool: 'Bash', command: 'sleep 99' }).catch(() => {})
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount(surface)
    await ui.drawn()
    expect(await ui.find({ type: 'Text', text: /✗/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ …$/ })).toBeUndefined()
    await ui.unmount()
  }

  expect(statuses.some(text => /◉ edit/.test(text ?? ''))).toBe(true)
  const shown = statuses.length
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', category: null, explanation: null } as never)
  expect(statuses.length).toBeGreaterThan(shown)
  expect(statuses[statuses.length - 1]).toBeUndefined()

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount(surface)
    expect(await ui.find({ type: 'Text', text: /Nothing yet/ })).toBeDefined()
    await ui.unmount()
  }
})
