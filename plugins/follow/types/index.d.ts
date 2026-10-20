export type ActivityKind = 'read' | 'edit' | 'write' | 'search' | 'shell' | 'plan' | 'web' | 'agent' | 'other'

/** A window of a file's lines, `focusFrom..focusTo` (1-based, inclusive) marked in the gutter. */
export type SourceView = {
  mode: 'source'
  path: string
  startLine: number
  lines: string[]
  focusFrom: number
  focusTo: number
}

/** One unified-diff hunk (header included) of what an edit or write changed. */
export type DiffView = { mode: 'diff'; path: string; hunk: string; line: number; isCut: boolean; added: number; removed: number }

/** What a shell command printed: stdout, then stderr, `isCut` when only the first lines are kept. */
export type OutputView = { mode: 'output'; command: string; lines: string[]; isCut: boolean; isFailed: boolean }

export type FileView = SourceView | DiffView | OutputView

export type Activity = {
  /** The tool_use_id. */
  id: string
  /** The loop it ran in: null for the main conversation. */
  agentId: string | null
  tool: string
  kind: ActivityKind
  /** Under a Claude scratchpad (or /tmp/claude-*) rather than the project. */
  isScratch: boolean
  path: string | null
  line: number | null
  endLine: number | null
  /** One line saying what it does: a command, a pattern, a URL. */
  label: string
  /** Lines an edit or write added and removed, whole (not cut to what the hunk shows). */
  added: number | null
  removed: number | null
  phase: 'running' | 'done' | 'error'
  /** The edit or write was held for the machine owner to review: the file is unchanged. */
  isHeld?: boolean
  at: number
  view: FileView | null
}

declare module 'claude-code' {
  interface PluginState {
    follow: {
      activities: Activity[]
      /** The activity the person pinned the pane to; null follows live. */
      pinned: string | null
      /** Where the person scrolled the code window, for the activity it showed; another activity follows again. */
      scroll: { id: string; top: number } | null
    }
  }
}
