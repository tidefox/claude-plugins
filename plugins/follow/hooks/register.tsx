import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { Activity } from '../types'
import { plan, trim, mirror } from './capture'
import type { Plan } from './capture'
import { ago, footerWhat, shortPath } from './labels'
import { clip, shortenPath } from './layout'
import { renderPane, scrollPane } from './pane'
import { BADGE, DOCK_MIN_COLUMNS, LINGER_MS, PANE, SIDEBAR_COLUMNS, env, settings } from './state'

// The engine reads a file's state by scanning it, so each file that reads or writes these declares them itself.
const activities = atom({ plugin: 'follow', key: 'activities' } as const, [])
const pinned = atom({ plugin: 'follow', key: 'pinned' } as const, null)
const scroll = atom({ plugin: 'follow', key: 'scroll' } as const, null)
/** How far the person scrolled the Files and Trail lists, in rows from the newest. */
const lists = atom({ plugin: 'follow', key: 'lists' } as const, { files: 0, trail: 0 })

async function reset($: EngineInterface) {
  await update($, activities, () => [])
  await update($, pinned, () => null)
  await update($, scroll, () => null)
  await update($, lists, () => ({ files: 0, trail: 0 }))
  $.ui.status(undefined)
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Follow', columns: SIDEBAR_COLUMNS, rows: 30 })

export const register: Register = (on, options) => {
  settings.nvimServer = String(options.nvimServer ?? '').trim()
  settings.codeBackground = String(options.codeBackground ?? 'auto').trim() || 'auto'
  settings.theme = null

  on('session.start', async ($, e, next) => {
    env.root = await $.session.root().catch(() => $.session.cwd())
    env.home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    await $.command.register({
      name: 'follow',
      description: 'Follow the agent: open the live file pane, or `live`, `clear`',
      argumentHint: '[live | clear]',
      immediate: true,
    })
    void openPane($)

    return next(e)
  })

  // A /clear starts a new conversation with no session.start: its trail goes too.
  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await reset($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The status line names what the agent is doing; once the turn ends it is doing nothing.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // Redraw the footer now, and again once the finished call's linger has run out.
      $.ui.invalidate('ui.render')
      $.clock.after(LINGER_MS + 500, () => $.ui.invalidate('ui.render'))
    }
    return next(e)
  })

  on('command.run', { command: 'follow' }, async ($, e) => {
    const verb = e.args.trim()
    if (verb === 'clear') {
      await reset($)
      return { text: 'Follow trail cleared.' }
    }
    if (verb === 'live') {
      await update($, pinned, () => null)
      await update($, scroll, () => null)
    }
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
      // The calling loop's directory: a subagent's own, a worktree's after a move.
      const here = await $.session.cwd()
      // /cd and a worktree move take the root along.
      if (e.agentId === undefined) env.root = await $.session.root().catch(() => env.root || here)
      p = await plan($, e, here)
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

    const settle = (extra: Partial<Activity>, phase: Activity['phase']) =>
      update($, activities, list => list.map((a): Activity => (a.id === activity.id ? { ...a, ...extra, phase } : a)))

    let ran: ToolCallResult
    try {
      ran = await next(e)
    } catch (error) {
      // Interrupted or thrown: the row would otherwise read `…` for good.
      await settle({}, 'error').catch(() => {})
      throw error
    }
    const isError = ran.deny !== undefined || ran.isError === true
    type After = Awaited<ReturnType<NonNullable<Plan['after']>>>
    const { more = [], ...extra }: After = p.after && !isError ? await p.after(ran).catch(() => ({})) : {}
    await settle(extra, isError ? 'error' : 'done')
    if (more.length > 0) {
      const also = more.map((m, i): Activity => ({ ...activity, ...m, id: `${activity.id}#${i + 1}`, phase: 'done' }))
      const keep = await read($, pinned)
      await update($, activities, list => {
        const at = list.findIndex(a => a.id === activity.id)
        return trim([...list.slice(0, at + 1), ...also, ...list.slice(at + 1)], keep)
      })
    }

    return ran
  }).catch(($, e, next) => next(e))

  // The footer's right side, beside the statusline: what the main agent is doing now, so it shows with the pane closed.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const main = (await read($, activities)).filter(a => a.agentId === null)
    const a = main.find(x => x.phase === 'running') ?? main[0]
    const t = await $.clock.now()
    const isRunning = a?.phase === 'running'
    // A finished call lingers a few seconds, then the label goes quiet.
    const doing = a && (isRunning || t - a.at <= LINGER_MS) ? a : null
    // Subagents at work, by type: `2 agents Explore + general-purpose`, like the model and effort chip.
    const working = (await $.agent.list().catch(() => [])).filter(g => g.status === 'running')
    if (!doing && working.length === 0 && e.props.modes.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const types = [...new Set(working.map(g => g.type))]
    const what = !doing ? '' : doing.path === null ? footerWhat(doing.label) : `${shortenPath(shortPath(doing), 28)}${doing.line ? `:${doing.line}` : ''}`
    const modes = e.props.modes.join(' & ')
    // Two rows, right-aligned: the labels (CI, subagents) over what the agent is doing.
    return (
      <Box flexDirection="column" flexGrow={1} alignItems="flex-end">
        {modes || working.length > 0 ? (
          <Box flexDirection="row" gap={1} justifyContent="flex-end">
            {modes ? <Text dimColor>{modes}</Text> : ''}
            {working.length > 0 ? (
              <Text>
                <Text bold color="claude">{`${working.length} ${working.length === 1 ? 'agent' : 'agents'}`}</Text>
                <Text dimColor>{` ${clip(types.join(' + '), 28)}`}</Text>
              </Text>
            ) : (
              ''
            )}
          </Box>
        ) : (
          <Text> </Text>
        )}
        {doing ? (
          <Box flexDirection="row" gap={1} justifyContent="flex-end">
            <Text bold color={BADGE[doing.kind].color}>{BADGE[doing.kind].label.toLowerCase()}</Text>
            <Text dimColor={!isRunning} wrap="truncate-end">{what}</Text>
            {isRunning ? <Text dimColor>{ago(t - doing.at)}</Text> : ''}
          </Box>
        ) : (
          <Text> </Text>
        )}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, renderPane)

  // The wheel over the code window scrolls the code, not the pane: the layout is fixed.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, scrollPane).catch(($, e, next) => next(e))
}
