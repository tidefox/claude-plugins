# ci-watch

A Claude Code mod that watches CI on pull requests the agent drafts or opens.

- **Detects** `gh pr create` (draft or not) and `gh pr ready` in any Bash call, plus GitHub MCP
  `create_pull_request` / ready-for-review tools, and reads the PR URL from the output.
- **Polls** `gh pr checks <url>` every 15s (configurable) until every check settles.
- **Live pane**: one card per PR with a status badge, a draft tag, the branch, elapsed CI time,
  a segmented pass/fail/running bar, and per-check rows (failures first, clickable links,
  live durations), plus **re-run failed**, **refresh** and **unwatch** buttons.
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
