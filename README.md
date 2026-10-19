# claude-plugins

Claude Code plugins by tidefox. This repository is a plugin marketplace.

| Plugin | What it does |
| --- | --- |
| [ci-watch](plugins/ci-watch) | Watches CI on PRs Claude drafts or opens: a live TUI pane with per-check status, the status line, and a notification when CI settles |
| [follow](plugins/follow) | Follows the agent like Zed's follow mode: a live sidebar showing the file and lines it is reading, editing or writing, with diffs, a trail and an optional Neovim mirror |

## Install

In a Claude Code terminal session:

```
/plugin install ci-watch --marketplace tidefox/claude-plugins
/plugin install follow --marketplace tidefox/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope.
