# follow

A Claude Code mod that follows the agent, like Zed's "follow" mode: a live sidebar showing the file and lines the agent is reading, editing or writing right now.

- **Captures** every tool call: `Read` (the line range it read), `Edit` (the exact lines: found before the edit runs, then the diff once it lands), `Write` (diff against the old file, or the head of a new one), and shell reads and writes (`cat`, `head`, `tail`, `sed -n A,Bp`, `>`, `tee`). It also logs searches, plan updates, web requests and subagents.
- **Scratchpad** files are tagged `SCRATCH` so you can tell them apart from project files.
- **Pane:** a badge (`READ` / `EDIT` / `WRITE` / …) with `path:line`, a highlighted code window or a diff, the files touched (R/E/W), and a clickable trail.
- **Follow:** tracks whichever agent's transcript is in view. Open a subagent from the tasks list and the pane follows it. Press `p` (or click a file or trail row) to pin a view, and `f` to follow live again.
- **Neovim mirror (optional):** set `nvimServer` in `/config` to a `nvim --listen` address, and each focus change opens the file at that line in your Neovim too.

## Sidebar

The pane docks as a sidebar beside the transcript only in Claude Code's fullscreen layout, in a terminal at least 110 columns wide. It asks for a 64-column dock; drag the edge to resize it. On the main screen (the default inside tmux) it opens above the prompt instead. To get the sidebar:

```sh
CLAUDE_CODE_NO_FLICKER=1 claude
```

## Commands

| Command | Does |
| --- | --- |
| `/follow` | open the pane |
| `/follow live` | unpin and follow live |
| `/follow clear` | clear the trail |

## Install

In a Claude Code terminal session:

```
/plugin install follow --marketplace tidefox/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope.
