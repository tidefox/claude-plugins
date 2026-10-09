export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'

export type Check = {
  name: string
  workflow: string
  bucket: CheckBucket
  link: string
  startedAt: number | null
  completedAt: number | null
}

export type Phase = 'waiting' | 'running' | 'passed' | 'failed' | 'no-ci' | 'error'

export type WatchedPr = {
  url: string
  repo: string
  number: number
  title: string
  isDraft: boolean
  branch: string
  phase: Phase
  checks: Check[]
  addedAt: number
  polledAt: number | null
  finishedAt: number | null
  error: string | null
  /** The check set of the last all-settled poll: CI settles when the next poll repeats it. */
  settleKey: string | null
  /** When failed runs were re-run: no settling until a check is seen pending, or a minute passes. */
  rerunAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'ci-watch': { prs: WatchedPr[]; now: number; paneShown: boolean }
  }
}
