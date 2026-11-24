import type { PromptDecoration } from 'claude-code'

import type { Activity } from '../types'
import { relative } from './capture'
import { BADGE } from './state'

/** A path ends at whitespace, a quote or a bracket; `:12` or a full stop after it still counts. */
const BEFORE = /[\w./~-]/
const AFTER = /[\w/-]/

/**
 * Runs over the draft for each path the agent touched: the absolute path, the
 * project-relative one, and the bare file name where it has an extension.
 * Colored as the trail colors that move, the newest one winning.
 */
export function pathRuns(text: string, list: readonly Activity[]): PromptDecoration[] {
  const kinds = new Map<string, Activity['kind']>()
  for (const a of list) {
    if (a.path === null) continue
    const name = a.path.slice(a.path.lastIndexOf('/') + 1)
    for (const form of [a.path, relative(a.path), /\.\w+$/.test(name) ? name : '']) {
      if (form.length >= 3 && !kinds.has(form)) kinds.set(form, a.kind)
    }
  }
  const runs: PromptDecoration[] = []
  const taken: [number, number][] = []
  // Longest first, so `src/main.ts` is painted whole and `main.ts` inside it is not painted again.
  for (const [form, kind] of [...kinds].sort((x, y) => y[0].length - x[0].length)) {
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
      const end = at + form.length
      if (BEFORE.test(text[at - 1] ?? '') || AFTER.test(text[end] ?? '')) continue
      if (taken.some(([s, e]) => at < e && end > s)) continue
      taken.push([at, end])
      runs.push({ start: at, end, underline: true, color: BADGE[kind].color })
    }
  }
  return runs.sort((x, y) => x.start - y.start)
}
