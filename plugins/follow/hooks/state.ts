import type { ActivityKind } from '../types'

export const PANE = 'follow'
/** The dock width asked for beside a fullscreen transcript; the person's own drag wins. */
export const SIDEBAR_COLUMNS = 64
/** Docking is the surface's call: only the fullscreen layout from this width docks a pane. */
export const DOCK_MIN_COLUMNS = 110
export const MAX_ACTIVITIES = 80
/** Only the newest few keep their file excerpt, so the state stays small. */
export const MAX_VIEWS = 12
export const READ_WINDOW = 120
export const EDIT_CONTEXT = 12
export const HUNK_CONTEXT = 3
export const HUNK_CAP = 400
export const OUTPUT_LINES = 400
/** The age column: `12s`, `3m`, `held`, padded so a row's chips never move as it ticks. */
export const AGE = 4
/** The header's chip (`◎ SCROLLED`) and action (`⟲ follow live`) slots, each as wide as its widest content. */
export const CHIP = 10
export const ACTION = 17
export const MAX_FILE_CHARS = 4_000_000
export const TRAIL_ROWS = 6
export const FILE_ROWS = 6
/** Rows a wheel tick or j/k moves the code window. */
export const SCROLL_STEP = 3


export const BADGE: Record<ActivityKind, { label: string; color: string }> = {
  read: { label: 'READ', color: 'suggestion' },
  edit: { label: 'EDIT', color: 'warning' },
  write: { label: 'WRITE', color: 'success' },
  search: { label: 'SEARCH', color: 'ide' },
  shell: { label: 'SHELL', color: 'bashBorder' },
  plan: { label: 'PLAN', color: 'planMode' },
  web: { label: 'WEB', color: 'permission' },
  agent: { label: 'AGENT', color: 'claude' },
  other: { label: 'TOOL', color: 'inactive' },
}
/** How long a finished call stays in the footer. */
export const LINGER_MS = 8000
export const LETTER: Partial<Record<ActivityKind, string>> = { read: 'R', edit: 'E', write: 'W' }

/** What the session start learned and the options set; the modules read them from here, since an import cannot be assigned. */
export const env = {
  /** The project root paths are shown against; a shell `cd` does not move it. */
  root: '',
  home: '',
}

export const settings: { nvimServer: string; codeBackground: string; theme: string | null } = {
  nvimServer: '',
  codeBackground: 'auto',
  theme: null,
}
