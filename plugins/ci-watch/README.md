# ci-watch

A Claude Code mod that watches CI on pull requests the agent drafts or opens.

- **Detects** `gh pr create` (draft or not) and `gh pr ready` in any Bash call, plus GitHub MCP
  `create_pull_request` / ready-for-review tools, and reads the PR URL from the output.
- **Polls** `gh pr checks <url>` every 15s (configurable) until every check settles.
- **Pane:** the same OpenCode-style fixed layout as [follow](../follow), in Claude's orange: a
  header with a `● LIVE` / `◎ PINNED` / `○ SETTLED` chip, then a card for every watched PR,
  the focused one first, stacked and scrolling inside the pane (mouse wheel, `j` / `k`, a
  scrollbar on the right). Each card has an accent
  bar in its status color and a raised fill (`#N` and title, a status badge, a draft tag, repo,
  branch, `done/total` and elapsed CI time, a segmented pass/fail/running bar with `✓N ✗M ●K`
  chips, then per-check rows: failures first, clickable links, live durations; passed and
  skipped checks collapse to a count when one PR's checks would fill the window). Below it, a
  Pull requests block of six fixed rows lists the watched PRs (a whole row lights under the pointer); click one to pin it, `f` to follow the
  newest running PR again. Buttons along the bottom: **re-run failed**, **refresh** (`u`),
  **unwatch**, **clear settled**. Before any PR is watched the same layout draws blank, with
  an `○ IDLE` chip and a legend.
- **Block background:** a shade dimmer than the terminal (by theme). Set `blockBackground` in
  `/config` to `none`, or to any color such as `#1e1e2e`.
- **Sidebar:** like follow, it asks for a 64-column dock beside the transcript in Claude Code's
  fullscreen layout (`CLAUDE_CODE_NO_FLICKER=1 claude`, 110+ columns); otherwise it opens above
  the prompt.
- **Status line** summary (`CI #42 ◐ 5/8 ✗1`), and a one-line band above the prompt when the
  pane can't be placed (narrow terminal).
- **On finish**: a toast and a desktop notification. Optionally (`onFinish` in `/config`) it
  leaves Claude a note with the result (`tell-claude`), or starts a turn asking Claude to fix
  the failing checks (`fix-failures`).

## Commands

| Command | Does |
| --- | --- |
| `/ci` | open the pane |
| `/ci watch <url \| owner/repo#N>` | watch any PR by hand |
| `/ci clear` | drop finished PRs |
| `/ci stop` | stop watching everything |

## Install

Requires an authenticated [`gh`](https://cli.github.com) CLI. In a Claude Code terminal session:

```
/plugin install ci-watch --marketplace tidefox/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

## Develop

```
claude --plugin-dir plugins/ci-watch      # run it from a checkout
claude plugin validate plugins/ci-watch
claude plugin test plugins/ci-watch
```
