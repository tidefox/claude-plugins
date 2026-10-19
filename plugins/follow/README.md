# follow

A Claude Code mod that follows the agent, like Zed's "follow" mode: a live sidebar showing the file and lines the agent is reading, editing or writing right now.

- **Captures** every tool call: `Read` (the line range it read), `Edit` (the exact lines: found before the edit runs, then the diff once it lands), `Write` (diff against the old file, or the head of a new one), and shell reads and writes (`cat`, `head`, `tail`, `sed -n A,Bp`, `>`, `tee`; a leading `cd <dir> &&` is followed). Any other command (a `python3 - <<EOF` script, `sed -i`, a formatter) is checked against the files it names: each one it changed shows as an edit with its diff. Edit and Write diffs are against the file as the tool found it, and a change held for review says so. It also logs searches, plan updates, web requests and subagents.
- **Scratchpad** files are tagged `scratch` (and `✎` in Files) so you can tell them apart from project files.
- **Pane:** an OpenCode-style fixed layout in Claude's orange: a header with a `● LIVE` / `◎ SCROLLED` / `◎ PINNED` chip, the focused file as a block with an orange accent bar and a raised fill (kind, `path:line`, `+N −M`, then the code), Files and Trail as blocks with the same fill, right-aligned `+N −M` chips and ages (long paths shortened from the middle, the file name kept; a whole row lights under the pointer), changes bold and reads dim, and buttons along the bottom. Before anything happens the same layout draws blank, with an `○ IDLE` chip and a legend of what each block will show.
- **Scrollable code view:** the code window shows the whole file for a read (the lines it read marked `│`, a change's `▌`) or the whole diff for a change, old and new line numbers beside it. The gutter is as wide as the file's largest line number, so the code never shifts as you scroll, and long lines wrap at the pane's edge instead of being cut. Scroll it with the mouse wheel over it, `j` / `k`, or `t` / `e` for top and end; the header shows `◎ SCROLLED` with a `[ ⟲ follow live ]` button. It follows the agent again on its next move, or press `f`.
- **Follow:** tracks whichever agent's transcript is in view. Open a subagent from the tasks list and the pane follows it. Press `p` (or click a file or trail row) to pin a view, and `f` to follow live again.
- **Code view background:** a shade dimmer than the terminal (by theme) so the code window stands apart. Set `codeBackground` in `/config` to `none`, or to any color such as `#1e1e2e`.
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
| `/follow clear` | clear the trail (a `/clear` does too) |

## Install

In a Claude Code terminal session:

```
/plugin install follow --marketplace tidefox/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope.
