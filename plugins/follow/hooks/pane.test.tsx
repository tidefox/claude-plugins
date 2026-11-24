import { expect, mock, test } from 'claude-code/testing'

import { LIFE_TICKS, RISE_TICKS, SPAWN_TICKS, TICK_MS } from './drift'

const FILE = '/work/app/src/main.ts'
const SCRATCH = '/tmp/claude-501/proj/session/scratchpad/notes.md'

type Mounted = { findAll: (q: { type: string }) => Promise<{ key?: string; props: Record<string, unknown>; children: unknown[] }[]> }

/** The code window as unified-diff lines: each run of rows under its sign, read off the run's background. */
async function diffLines(ui: Mounted): Promise<string> {
  const sign: Record<string, string> = { diffAdded: '+', diffRemoved: '-' }
  const runs = (await ui.findAll({ type: 'Box' })).filter(b => /^run:/.test(b.key ?? ''))
  return runs
    .flatMap(run => {
      const code = run.children.find((c): c is { props: { source: string } } => typeof c === 'object' && c !== null && 'props' in c)
      const mark = sign[String(run.props.backgroundColor)] ?? ' '
      return String(code?.props.source ?? '').split('\n').map(line => `${mark}${line}`)
    })
    .join('\n')
}

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
    // The whole layout draws before anything happens, blank.
    expect(await ui.find({ type: 'Text', text: /○ IDLE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Files$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /waiting for the first tool call/ })).toBeDefined()
    await ui.unmount()
  }

  await $.tool.call({ tool: 'Read', file_path: FILE, offset: 10, limit: 5 })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'follow', surface, component: 'Pane', requestId: 'follow', props: props() })
    await ui.drawn()
    expect(await ui.find({ type: 'Text', text: /^Read$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /main\.ts:10-14/ })).toBeDefined()
    const code = await ui.find({ type: 'Code' })
    // The whole file, the read's first line a third of the way down the window, numbered by the pane's own gutter.
    expect(code?.props.startLine).toBeUndefined()
    expect(String(code?.props.source).split('\n')[0]).toBe('const line4 = 4')
    expect(await ui.find({ type: 'Text', text: ' 4 ' })).toBeDefined()
    // The lines read are marked, every number padded to the file's widest.
    expect(await ui.find({ type: 'Text', text: '│10 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '│14 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 15 ' })).toBeDefined()
    await ui.unmount()
  }

  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'const line20 = 20', new_string: 'const line20 = 2000\nconst extra = 1' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'follow', surface, component: 'Pane', requestId: 'follow', props: props() })
    await ui.drawn()
    expect(await ui.find({ type: 'Text', text: /^Edit$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /main\.ts:20/ })).toBeDefined()
    const diff = await diffLines(ui)
    // The code column carries the lines alone: the +/- marks are the gutter's.
    expect(diff).toContain(' const line20 = 20\n const line20 = 2000\n const extra = 1')
    // Both sides' numbers in a gutter as wide as the largest: old 20 removed, new 21 added.
    expect(await ui.find({ type: 'Text', text: '20    - ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '   21 + ' })).toBeDefined()
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
    expect(await ui.find({ type: 'Text', text: 'lines 4–22 of 31' })).toBeDefined()
    await ui.press({ key: 'down' })
    expect(await ui.find({ type: 'Text', text: 'lines 7–25 of 31' })).toBeDefined()
    await ui.press({ key: 'up' })
    await ui.press({ key: 'up' })
    expect(await ui.find({ type: 'Text', text: 'lines 1–19 of 31' })).toBeDefined()
    await ui.press({ key: 'end' })
    expect(await ui.find({ type: 'Text', text: 'lines 13–31 of 31' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /PINNED/ })).toBeDefined()
    // The snap-back button sits beside the chip.
    expect(await ui.find({ type: 'Button', key: 'live' })).toBeDefined()
    expect(await ui.find({ type: 'Box', key: 'code' })).toMatchObject({ props: { height: 19 } })
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

  on('fs.read', (_, e) => {
    const text = files.get((e as { path: string }).path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('session.cwd', () => ({ value: '/work/app' }) as never)
  on('session.root', () => ({ value: '/work/app' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
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
    const source = await diffLines(ui)
    expect(source).toContain(' c\n C')
    // The diff is against what the tool saw, so the other change is no part of it.
    expect(source).not.toContain(' b')
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

  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', category: null, explanation: null } as never)

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount(surface)
    expect(await ui.find({ type: 'Text', text: /Nothing yet/ })).toBeDefined()
    await ui.unmount()
  }
})

test('shows what a script changed as edits, one per file', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  const NOTES = '/work/app/notes.md'
  const files = new Map<string, string>([
    [FILE, Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'],
    [NOTES, 'one\n'],
  ])
  on('fs.read', (_, e) => {
    const text = files.get((e as { path: string }).path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('session.cwd', () => ({ value: '/work/app' }) as never)
  on('session.root', () => ({ value: '/work/app' }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash' && e.command.includes('python3')) {
      files.set(FILE, files.get(FILE)!.replace('line 7', 'line seven'))
      files.set(NOTES, 'one\ntwo\n')
    }
    return { result: {} as never, text: 'ok' }
  })

  await $.tool.call({
    tool: 'Bash',
    command: "cd src && python3 - <<'EOF'\np = 'main.ts'\ns = open(p).read().replace('line 7', 'line seven')\nopen('../notes.md', 'a').write('two')\nEOF",
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'follow', surface, component: 'Pane', requestId: 'follow', props: props() })
    await ui.drawn()
    expect(await ui.find({ type: 'Text', text: /^Edit$/ })).toBeDefined()
    const source = await diffLines(ui)
    expect(source).toContain(' line 7\n line seven')
    // Both files the script changed are in Files.
    expect(await ui.find({ type: 'Text', text: 'src/main.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'notes.md' })).toBeDefined()
    await ui.unmount()
  }
})

test('keeps a narrow pane inside its cells: whole kind, short path, wrapped code', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  const DEEP = '/work/app/packages/server/src/handlers/very/deep/requestHandler.ts'
  const long = `export const message = "${'x'.repeat(70)}"`
  const files = new Map<string, string>([[DEEP, ['const a = 1', long, 'const b = 2'].join('\n') + '\n']])
  on('fs.read', (_, e) => {
    const text = files.get((e as { path: string }).path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('session.cwd', () => ({ value: '/work/app' }) as never)
  on('session.root', () => ({ value: '/work/app' }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: {} as never, text: 'ok' }))

  await $.tool.call({ tool: 'Read', file_path: DEEP })

  const ui = await $.ui.mount({ plugin: 'follow', surface: 'terminal', component: 'Pane', requestId: 'follow', props: { ...props(), bodyColumns: 40 } })
  await ui.drawn()
  // The kind keeps its cells; the path gives way from the middle, its file name kept.
  expect(await ui.find({ type: 'Text', text: 'Read' })).toBeDefined()
  const path = await ui.find({ type: 'Text', text: /requestHandler\.ts/ })
  expect(path?.text).toBe(" …/requestHandler.ts:1-3")
  // 40 columns: 35 inside a block, the kind and age (`Read`, ` 0s`) and a space leave 27.
  expect(path!.text.length - 1).toBeLessThanOrEqual(27)

  // 35 inside, a scrollbar's column and a 3-cell gutter leave 31 for the code: the long line wraps there.
  // Each row of a wrapped line is the whole line, highlighted, shifted left to its piece.
  const pieces = (await ui.findAll({ type: 'Box' })).filter(b => typeof b.props.marginLeft === 'number')
  const offsets = pieces.map(b => Math.abs(b.props.marginLeft as number))
  expect(offsets).toEqual([0, 31, 62, 93])
  for (const b of pieces) expect(b.props.width).toBe(long.length)
  expect(offsets.map(o => long.slice(o, o + 31)).join('')).toBe(long)
  // The unwrapped lines are drawn as they are.
  const codes = (await ui.findAll({ type: 'Code' })).map(c => c.props.source)
  expect(codes).toEqual(['const a = 1', long, long, long, long, 'const b = 2'])
  // A wrapped line's further rows carry a dot in place of a number.
  expect(await ui.find({ type: 'Text', text: '│2 ' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: '│· ' })).length).toBe(pieces.length - 1)

  // Files and Trail rows light whole under the pointer: the drawn tree carries each row Box's hover.
  type Node = { props?: { key?: unknown }; hover?: unknown; children?: unknown[] }
  const lit: unknown[] = []
  const walk = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return
    const n = node as Node
    if (/^[ft]:/.test(String(n.props?.key ?? ''))) lit.push(n.hover)
    n.children?.forEach(walk)
  }
  walk(await ui.drawn())
  expect(lit).toEqual([{ backgroundColor: '#303030' }, { backgroundColor: '#303030' }])
  await ui.unmount()
})

test('shows what a command printed in the code window', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('session.cwd', () => ({ value: '/work/app' }) as never)
  on('session.root', () => ({ value: '/work/app' }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: { stdout: 'On branch main\nnothing to commit\n', stderr: 'warning: x\n', interrupted: false } as never, text: 'ok' }))

  await $.tool.call({ tool: 'Bash', command: 'git status' })

  const ui = await $.ui.mount({ plugin: 'follow', surface: 'terminal', component: 'Pane', requestId: 'follow', props: props() })
  await ui.drawn()
  expect(await ui.find({ type: 'Text', text: /On branch main/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /git status/ })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /output lines 1–3 of 3/ })).toBeDefined()
  await ui.unmount()
})

test("follows a subagent's move too, and names the agent it shows", async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  on('fs.read', () => ({ value: 'one\ntwo\n' }) as never)
  on('session.cwd', () => ({ value: '/work/app' }) as never)
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', description: 'find the parser', status: 'running', model: 'claude-haiku-5-5', cost: { usd: 0.042 } }] }) as never)
  const read = (id: string, agentId: string | null, path: string, at: number) => ({
    id, agentId, tool: 'Read', kind: 'read', isScratch: false, path, line: 1, endLine: 1,
    label: path, added: null, removed: null, phase: 'done', at, view: null,
  })
  // The subagent's read is the newest: the pane shows it, though the main agent's transcript is in view.
  on('state.get', (_, e, next) =>
    (e as { key: string }).key === 'activities'
      ? ({ value: { value: [read('t2', 'a1', '/work/app/src/parse.ts', 2), read('t1', null, FILE, 1)], version: 1 } }) as never
      : next(e),
  )
  const ui = await $.ui.mount({ plugin: 'follow', surface: 'terminal', component: 'Pane', requestId: 'follow', props: props() })
  expect(await ui.find({ type: 'Text', text: /Explore: find the parser · haiku-5-5 · \$0\.04/ })).toBeDefined()
  // Pinned to the main agent's read: the header says so, and the subagent's row is marked.
  await ui.press({ key: 'trail:t1' })
  expect(await ui.find({ type: 'Text', text: /main agent/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '↳' })).toBeDefined()
  await ui.unmount()
})

test("shows a subagent's report in the trail, and hands the report on unchanged", async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  on('session.cwd', () => ({ value: '/work/app' }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  // The agent has finished: the list no longer names it, so the row's own type does.
  on('agent.list', () => ({ value: [] }) as never)
  on('agent.report', (_, e) => ({ text: e.text }))

  const text = 'Found the parser.\n\nIt lives in src/parse.ts:12.'
  const result = await $.agent.report({ agentId: 'a1', subagentType: 'Explore', provider: { kind: 'core' }, status: 'completed', text } as never)
  expect(result).toEqual({ text })
  await $.agent.report({ agentId: 'a2', subagentType: 'Plan', provider: { kind: 'core' }, status: 'stopped', text: '' } as never)

  const ui = await $.ui.mount({ plugin: 'follow', surface: 'terminal', component: 'Pane', requestId: 'follow', props: props() })
  await ui.drawn()
  expect(await ui.find({ type: 'Button', key: 'trail:report:a1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Plan: stopped/ })).toBeDefined()
  await ui.press({ key: 'trail:report:a1' })
  expect(await ui.find({ type: 'Text', text: /Explore report/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Found the parser.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'It lives in src/parse.ts:12.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'report lines 1–3 of 3' })).toBeDefined()
  // No shell prompt around a report.
  expect(await ui.find({ type: 'Text', text: /^\$/ })).toBeUndefined()
  await ui.unmount()
})

test('underlines a touched path as the person types it', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  on('fs.read', () => ({ value: 'a\n' }) as never)
  on('session.cwd', () => ({ value: '/work/app' }) as never)
  on('session.root', () => ({ value: '/work/app' }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: {} as never, text: 'ok' }))
  // The editor's own answer: the splice applied.
  on('prompt.edit', (_, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }) as never)

  await $.tool.call({ tool: 'Read', file_path: FILE })
  // The engine alone raises prompt.edit, so a test's typed `$` leaves it out; the kit raises it all the same.
  const edit = ($.prompt as unknown as { edit: (e: unknown) => Promise<{ text: string; decorations?: unknown[] }> }).edit
  const box = await edit({ origin: { kind: 'composer' }, text: 'look at ', cursor: 8, start: 8, end: 8, inputText: 'src/main.ts' })
  expect(box.text).toBe('look at src/main.ts')
  expect(box.decorations).toEqual([{ start: 8, end: 19, underline: true, color: 'suggestion' }])
})

test('shows the whole file against the last commit on g, or says why it cannot', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  const OTHER = '/elsewhere/notes.ts'
  on('fs.read', () => ({ value: 'a\nb\nc\n' }) as never)
  on('fs.stat', () => ({ value: { size: 6, mtimeMs: 1 } }) as never)
  on('session.cwd', () => ({ value: '/work/app' }) as never)
  on('session.root', () => ({ value: '/work/app' }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: {} as never, text: 'ok' }))
  const asked: unknown[] = []
  on('vcs.detect', (_, e) => (e.path.startsWith('/work/app') ? { vcs: 'git', root: '/work/app', mainRoot: null, revision: 'abc', branch: 'main', defaultBranch: 'main', remote: null } : null))
  on('vcs.diff', (_, e) => {
    asked.push(e)
    return { base: 'abc', files: [{ path: 'src/main.ts', renamedFrom: null, added: 1, removed: 1, isBinary: false, isUntracked: false, patch: '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -40,2 +40,2 @@\n x\n-y\n+Y' }] }
  })

  await $.tool.call({ tool: 'Read', file_path: FILE })
  const ui = await $.ui.mount({ plugin: 'follow', surface: 'terminal', component: 'Pane', requestId: 'follow', props: props() })
  await ui.drawn()
  expect(asked).toHaveLength(0)
  await ui.press({ key: 'git' })
  expect(asked).toEqual([{ path: '/work/app', vcs: 'git', base: 'head', paths: ['src/main.ts'] }])
  expect(await ui.find({ type: 'Text', text: /^git diff vs HEAD, lines/ })).toBeDefined()
  // Both hunks, a gap between them, the signs in the gutter.
  expect(await diffLines(ui)).toBe(' a\n b\n B\n c\n \n x\n y\n Y')
  expect((await ui.findAll({ type: 'Text', text: /- $/ })).length).toBe(2)
  expect((await ui.findAll({ type: 'Text', text: /\+ $/ })).length).toBe(2)
  expect(await ui.find({ type: 'Button', key: 'git', text: 'file' })).toBeDefined()

  // A file outside any working copy says so in place of the code.
  await $.tool.call({ tool: 'Read', file_path: OTHER })
  expect(await ui.find({ type: 'Text', text: 'git: not in a Git working copy' })).toBeDefined()

  // g again: back to the file itself.
  await ui.press({ key: 'git' })
  expect(await ui.find({ type: 'Text', text: /^lines 1–3 of 3/ })).toBeDefined()
  await ui.unmount()
})

test('drifts the latest change up the blank cells behind the transcript while Claude works', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  const files = new Map<string, string>([['/work/app/src/new.ts', 'export const drifted = false\n']])
  on('fs.read', (_, e) => {
    const text = files.get((e as { path: string }).path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('session.cwd', () => ({ value: '/work/app' }) as never)
  on('session.root', () => ({ value: '/work/app' }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit') files.set(e.file_path, (files.get(e.file_path) ?? '').replace(e.old_string, e.new_string))
    return { result: {} as never, text: 'ok' }
  })
  const blits: { cells: string; columns: number; rows: number }[] = []
  on('ui.blit', (_, e) => (blits.push(e as never), { value: {} }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/new.ts', old_string: 'false', new_string: 'true' })

  const COLUMNS = 40
  const ROWS = 6
  // The cells as text rows: what each cell's code point draws.
  const text = (cells: string) => {
    const bytes = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
    const words = new Uint32Array(bytes.buffer)
    return Array.from({ length: ROWS }, (_, y) =>
      Array.from({ length: COLUMNS }, (_, x) => String.fromCharCode(words[(y * COLUMNS + x) * 3]!)).join('').trimEnd())
  }

  const props = { columns: COLUMNS, rows: ROWS, isWorking: true, view: { kind: 'main' }, plugins: ['follow'] }
  const ui = await $.ui.mount({ plugin: 'follow', surface: 'terminal', component: 'Underlay', props: props as never })
  const raster = await ui.find({ type: 'Raster' })
  expect(raster?.props).toMatchObject({ key: 'drift', columns: COLUMNS, rows: ROWS })
  // Nothing yet: every cell blank, so nothing is painted over the transcript.
  expect(text(String(raster?.props.cells)).every(r => r === '')).toBe(true)

  // A line of the write starts on the bottom row...
  await clock.advance(TICK_MS * SPAWN_TICKS)
  expect(blits).toHaveLength(1)
  const first = text(blits[0]!.cells)
  expect(first[ROWS - 1]!.trim()).toBe('export const drifted = true')
  // ...and rises a row at a time.
  await clock.advance(TICK_MS * RISE_TICKS)
  expect(text(blits.at(-1)!.cells)[ROWS - 2]!.trim()).toBe('export const drifted = true')

  // The turn ends: no new lines, and once the last has risen off, no more repaints.
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  await clock.advance(TICK_MS * LIFE_TICKS)
  expect(text(blits.at(-1)!.cells).every(r => r === '')).toBe(true)
  const settled = blits.length
  await clock.advance(TICK_MS * LIFE_TICKS)
  expect(blits).toHaveLength(settled)

  // The next tool call starts it again.
  await $.tool.call({ tool: 'Read', file_path: '/work/app/src/new.ts' })
  await clock.advance(TICK_MS * SPAWN_TICKS)
  expect(blits.length).toBeGreaterThan(settled)
  await ui.unmount()
})

test('draws the drift layer at a real window size and at the largest a Raster takes', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-20T10:00:00Z') })
  for (const [columns, rows] of [[220, 60], [512, 256], [900, 400]] as const) {
    const ui = await $.ui.mount({ plugin: 'follow', surface: 'terminal', component: 'Underlay', props: { columns, rows, isWorking: true, view: { kind: 'main' }, plugins: ['follow'] } as never })
    // Past a Raster's limits the layer is cut to them, not refused.
    expect((await ui.find({ type: 'Raster' }))?.props).toMatchObject({ columns: Math.min(512, columns), rows: Math.min(256, rows) })
    await ui.unmount()
  }
})
