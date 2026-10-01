# herdr-resource-manager

A [Herdr](https://herdr.dev) plugin that gives you a live CPU/memory board for
every workspace, pane, and agent — inspired by Orca's resource manager.

```text
Resource manager · local · every 2s
CPU 23.1%  MEM 639.5 MB                          12 panes · 7 agents · 4 orphans · herdr app 69.1 MB
NAME                                                                                       CPU      MEM
▾ my-dropplets                                                                      8.8% 267.2 MB   3/3
  ▾ my-dropplets (3.4 MB) main                                                      8.8% 267.2 MB   2/3
    ● [pi] working π - my-dropplets                                                 8.7%  90.3 MB ▁▁▁▁▁▁▁▁▁█▁
    ○ [pi] idle π - my-dropplets                                                    0.1%  14.2 MB ▁▁▁▁▁▁▁▁▁▁█
    □ orphan shell · instant-spaces                                                 0.0%  704 KB ▁▁▁▁▁▁▁▁▁▁▁▁
```

## What it does

- **Repo → workspace → pane tree** with per-row CPU and memory, aggregated
  from the pane's shell plus its foreground process group (via
  `herdr pane process-info` and a shared `ps` snapshot).
- **Agent lifecycle at a glance**: working ●, blocked ◆, done ✓, idle ○,
  with sparklines of each pane's memory history.
- **Cleanup actions** with confirmation: close orphan shells (idle panes
  sitting at their prompt with no agent), close finished (`done`) agent
  panes, close workspaces, remove worktree checkouts.
- **Worktree disk usage**: background `du` scans cached in the plugin state
  dir, shown next to workspace rows.
- **Sidebar memory tokens**: optionally reports a `$MEM` token per pane so
  Herdr's sidebar shows memory while the board is open.
- **Remote machines**: scope the whole board to a saved SSH machine.

## Install

```shell
herdr plugin install <you>/herdr-resource-manager
```

Or while developing:

```shell
./link.sh
# or: herdr plugin link /path/to/herdr-resource-manager
```

Requires Node ≥ 20 on PATH. Platforms: macOS and Linux (`ps`/`du` based).

## Use

Open the board (or press `cmd+r`, if you added the keybinding below):

```shell
herdr plugin action invoke herdr.resource-manager.open
# or directly:
herdr plugin pane open --plugin herdr.resource-manager --entrypoint manager
```

Bind a key in your Herdr config:

```toml
[[keys.command]]
key = "cmd+r"
type = "plugin_action"
command = "herdr.resource-manager.open"
description = "resource manager"
```

Keys: `↑↓/j k` move · `⏎/f` focus pane · `x` close pane · `K` close finished
agents · `c` cleanup modal · `w` close workspace · `D` remove worktree ·
`s` sort (name → cpu → mem) · `h l` collapse/expand · `g G` top/bottom ·
`m` switch machine · `a` toggle sidebar tokens · `d` rescan disk · `r` refresh ·
`?` help · `q` quit.

Get a machine-readable snapshot for scripts:

```shell
herdr plugin action invoke herdr.resource-manager.snapshot
```

## Configuration

`HERDR_PLUGIN_CONFIG_DIR/config.env` (see `herdr plugin config-dir herdr.resource-manager`):

```ini
INTERVAL_MS=2000      # refresh interval, min 500
MACHINE=              # scope to a saved machine label/id; empty = local
ANNOTATE=false        # report $MEM sidebar tokens while the board is open
SORT=mem              # initial sort: name | cpu | mem
```

Any value can be passed per-open instead:

```shell
herdr plugin pane open --plugin herdr.resource-manager --entrypoint manager \
  --env HERDR_RESOURCE_MANAGER_MACHINE=build-box
```

The `open` action forwards `MACHINE` from config automatically.

Remote boards show topology and agent state, but CPU/memory read `—`:
pane PIDs belong to the remote host, so local `ps` cannot measure them
(disk scans are local-only for the same reason).

## Notes

- "Orphan" means a pane whose only process is an idle shell at its prompt —
  no agent, no foreground command. Herdr's analog of Orca's orphan terminals.
  Closing one ends that shell and any jobs inside it, so cleanup is always
  behind an explicit confirmation.
- Memory is RSS summed over the pane's shell and foreground process group;
  CPU is `ps`'s decaying-average utilization, so values are indicative.
- The board's own pane is excluded from orphan cleanup, and the snapshot
  excludes transient `herdr` CLI children from the "herdr app" figure.

## Development

```shell
npm test        # node:test unit tests, no Herdr needed
```

Layout: `bin/manager.js` (TUI), `bin/snapshot.js`, `bin/action-open.js`,
`link.sh`, `lib/herdr.js` (CLI wrapper), `lib/model.js` (collection + tree),
`lib/metrics.js` (`ps` parsing, formatting, sparklines), `lib/render.js`
(frame, rows, modals), `lib/du.js` (disk cache), `lib/keys.js` (input
tokenizing), `lib/config.js`.
