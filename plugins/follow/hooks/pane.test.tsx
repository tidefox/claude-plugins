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
    expect(await ui.find({ type: 'Text', text: / READ / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /main\.ts:10-14/ })).toBeDefined()
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.startLine).toBe(10)
    await ui.unmount()
  }

  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'const line20 = 20', new_string: 'const line20 = 2000\nconst extra = 1' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'follow', surface, component: 'Pane', requestId: 'follow', props: props() })
    await ui.drawn()
    expect(await ui.find({ type: 'Text', text: / EDIT / })).toBeDefined()
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
    expect(await ui.find({ type: 'Text', text: / WRITE / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / SCRATCH / })).toBeDefined()
    expect(await ui.findAll({ type: 'Button', text: /main\.ts/ })).not.toHaveLength(0)

    // Pinning an older trail row holds the view there.
    const rows = await ui.findAll({ type: 'Button' })
    const readRow = rows.find(r => /^trail:/.test(r.key ?? '') && /10-14/.test(r.text))
    expect(readRow).toBeDefined()
    await ui.press({ key: readRow?.key ?? '' })
    expect(await ui.find({ type: 'Text', text: /Pinned/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / READ / })).toBeDefined()
    await ui.press({ key: 'live' })
    expect(await ui.find({ type: 'Text', text: /Following/ })).toBeDefined()
    await ui.unmount()
  }
})
