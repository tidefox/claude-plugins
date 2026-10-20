import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderInput, UiScrollInput, UiScrollResult } from 'claude-code'

import type { Activity, ActivityKind } from '../types'
import { fileLines, mirror, relative } from './capture'
import { diffRows } from './diff'
import { ago, fitActivity } from './labels'
import type { CodeRow } from './layout'
import { autoTop, cellWidth, codeLayout, shortenPath, thumb, wrapRows } from './layout'
import { isScratchPath } from './parse'
import { ACTION, AGE, BADGE, CHIP, FILE_ROWS, HUNK_CONTEXT, LETTER, SCROLL_STEP, TRAIL_ROWS, settings } from './state'
import { oneLine } from './text'

// The engine reads a file's state by scanning it, so each file that reads or writes these declares them itself.
const activities = atom({ plugin: 'follow', key: 'activities' } as const, [])
const pinned = atom({ plugin: 'follow', key: 'pinned' } as const, null)
const scroll = atom({ plugin: 'follow', key: 'scroll' } as const, null)
/** How far the person scrolled the Files and Trail lists, in rows from the newest. */
const lists = atom({ plugin: 'follow', key: 'lists' } as const, { files: 0, trail: 0 })

type PaneRender = Extract<RenderInput, { component: 'Pane' }>
type PaneScroll = UiScrollInput

async function theme($: EngineInterface): Promise<string> {
  settings.theme ??= String((await $.config.list().catch(() => [])).find(row => row.key === 'theme')?.value ?? '')
  return settings.theme
}

/** The code window's fill: a shade dimmer than the terminal's, by theme, unless set in /config. */
async function codeBackground($: EngineInterface): Promise<string | undefined> {
  if (settings.codeBackground === 'none') return undefined
  if (settings.codeBackground !== 'auto') return settings.codeBackground
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

/** The last wrap, kept while its lines and width hold: a redraw would wrap the whole file again. */
let wrapped: { of: unknown; room: number; rows: CodeRow[] } | null = null
function wrapOnce(of: unknown, room: number, lines: () => Parameters<typeof wrapRows>[0]): CodeRow[] {
  if (wrapped && wrapped.of === of && wrapped.room === room) return wrapped.rows
  const rows = wrapRows(lines(), room)
  wrapped = { of, room, rows }
  return rows
}

export async function renderPane($: EngineInterface, e: PaneRender) {
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
  const age = (a: Activity) => (mark(a) || ago(t - a.at)).padStart(AGE)

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
  } else if (focus?.view?.mode === 'output') {
    const view = focus.view
    // The tail is what a command's output is usually read for: start at the end.
    const room = fit([{ old: 0, new: view.lines.length }], 2)
    codeRows = wrapOnce(view.lines, room, () => view.lines.map((text, i) => ({ text, t: ' ' as const, old: i + 1, new: i + 1 })))
    codeAuto = Math.max(0, codeRows.length - layout.codeRows)
    place = (from, to) => `output lines ${from.new}–${to.new} of ${view.lines.length}${view.isCut ? ' (cut)' : ''}${view.isFailed ? ' · interrupted' : ''}`
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
    // A row with no number still draws a dot: a gutter row of blanks alone can be dropped or misplaced by the renderer,
    // which sets every number after a wrapped line a row out of step with its code.
    const cont = () => '·'.padStart(digits)
    // Runs of one tone share a Code, so a diff's rows take their background and a file stays one highlight.
    const runs: CodeRow[][] = []
    for (const row of shown) {
      const last = runs[runs.length - 1]
      if (last && last[0]!.t === row.t && !last[0]!.isGap && !row.isGap && last[0]!.whole === undefined && row.whole === undefined) last.push(row)
      else runs.push([row])
    }
    return (
      <Box flexDirection="row">
        <Box flexDirection="column" flexShrink={0} width={gutter}>
          {shown.map((row, i) => {
            const isFirst = row.part === 0 && !row.isGap
            if (isDiff) {
              return (
                <Text key={`g:${top + i}`} dimColor={row.t === ' '} backgroundColor={TONE[row.t]}>
                  {`${num(row.old, isFirst && row.t !== '+')} ${num(row.new, isFirst && row.t !== '-')} ${isFirst ? row.t : '·'} `}
                </Text>
              )
            }
            const isFocus = isFocusLine(row)
            return (
              <Text key={`g:${top + i}`} dimColor={!isFocus} bold={isFocus} color={isFocus ? markColor : undefined}>
                {`${isFocus ? mark : ' '}${isFirst ? num(row.new, true) : cont()} `}
              </Text>
            )
          })}
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {runs.map((run, i) => (
            <Box key={`run:${i}`} height={run.length} backgroundColor={TONE[run[0]!.t]}>
              {run[0]!.isGap ? (
                <Text dimColor>⋯</Text>
              ) : run[0]!.whole !== undefined ? (
                // Highlighted as the whole line, then cut to this piece: a string or comment that wraps keeps its colour.
                <Box overflow="hidden" flexGrow={1} height={1}>
                  <Box flexShrink={0} width={cellWidth(run[0]!.whole)} marginLeft={-(run[0]!.offset ?? 0)}>
                    <Code source={run[0]!.whole || ' '} path={focus?.path ?? ''} wrap="truncate-end" />
                  </Box>
                </Box>
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
        <Text bold dimColor wrap="truncate-end">{title}</Text>
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
  const focusAge = focus ? age(focus) : ''
  const focusRoom = focus
    ? inner - cellWidth(kindName) - (focus.isScratch ? 8 : 0) - 1 - statWidth(focus.added, focus.removed) - 1 - AGE
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
        {/* Both slots keep their width whatever they hold, so the header never shifts. */}
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Box width={CHIP} flexShrink={0}>
            <Text bold color={chip.color}>{chip.text}</Text>
          </Box>
          <Box width={ACTION} flexShrink={0} justifyContent="flex-end">
            {isLive ? (
              focus ? <Button key="pin" label="pin" hotkey="p" onPress={() => update($, pinned, () => focus.id)} /> : ''
            ) : (
              <Button key="live" label="⟲ follow live" variant="primary" hotkey="f" onPress={followLive} />
            )}
          </Box>
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
                <Text wrap="truncate-start" bold dimColor>{` ${fitActivity(focus, focusRoom)}`}</Text>
              </Box>
              <Box flexShrink={0}>
                {stat(focus.added, focus.removed)}
                <Text dimColor>{` ${focusAge}`}</Text>
              </Box>
            </Box>
            <Box flexDirection="row" height={1}>
              <Box flexGrow={1} flexShrink={1}>
                <Text dimColor wrap="truncate-end">
                  {focus.isHeld ? 'held for review: the file is unchanged' : focus.tool === 'Bash' && focus.view?.mode !== 'output' ? `$ ${oneLine(focus.label)}` : where}
                </Text>
              </Box>
              <Box flexShrink={0} width={5} justifyContent="flex-end">
                <Text dimColor>{maxTop > 0 ? `${Math.round((top / maxTop) * 100)}%` : ''}</Text>
              </Box>
            </Box>
            <Box key="code" flexDirection="row" height={layout.codeRows} overflow="hidden">
              <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
                {drawCode() as never}
              </Box>
              {/* The scrollbar's column stays, blank when nothing scrolls: the code never changes width. */}
              <Box flexDirection="column" flexShrink={0} width={1}>
                {Array.from({ length: layout.codeRows }, (_, i) => {
                  const isThumb = i >= grip.from && i < grip.from + grip.size
                  return (
                    <Text key={`bar:${i}`} color={isThumb ? 'claude' : 'subtle'}>
                      {maxTop === 0 ? ' ' : isThumb ? '┃' : '│'}
                    </Text>
                  )
                })}
              </Box>
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
            const isFocus = a.id === focus?.id
            const isQuiet = !isChange(a.kind) && !isFocus
            // ▸, the kind padded to six and a space; the chips, a space and the age on the right.
            const room = inner - 8 - statWidth(a.added, a.removed) - 1 - AGE
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
                  <Text dimColor>{` ${age(a)}`}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>,
      )}

      <Box flexDirection="row" height={1} gap={1} marginTop={0}>
        <Button key="up" label="↑" hotkey="k" onPress={() => scrollCode($, -SCROLL_STEP)} />
        <Button key="down" label="↓" hotkey="j" onPress={() => scrollCode($, SCROLL_STEP)} />
        <Button key="top" label="top" hotkey="t" onPress={() => scrollCode($, -codeTotal)} />
        <Button key="end" label="end" hotkey="e" onPress={() => scrollCode($, codeTotal)} />
        {settings.nvimServer ? <Button key="nvim" label="nvim" hotkey="n" onPress={() => (focus ? mirror($, focus) : undefined)} /> : ''}
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
}

export async function scrollPane($: EngineInterface, e: PaneScroll, next: (e: PaneScroll) => Promise<UiScrollResult>) {
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
}
