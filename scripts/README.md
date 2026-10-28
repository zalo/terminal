# Scripts

Supporting assets installed by `install.sh` at the repo root.

## `hooks/terminal-meta.py`

Claude Code hook that writes per-tmux-session metadata (status / task / cwd /
preview URL / Claude session id) to `$CLAUDE_META_DIR/<session>.json` (default
`/tmp/claude-terminal-meta`). Fires on `UserPromptSubmit`, `Stop`,
`SessionStart`, `SessionEnd`. The terminal server reads these files to populate
the session list and the per-session header in the UI.

Installed to `~/.claude/hooks/terminal-meta.py` and registered in
`~/.claude/settings.json`.

## `bin/tm-meta`

CLI agents use from inside a tmux session to write fields the hook doesn't
derive automatically — mainly `preview_url`:

```sh
tm-meta preview http://localhost:5173   # register a dev-server URL
tm-meta clear preview_url               # remove it
tm-meta set task "..."                  # override auto-derived task
tm-meta get                             # dump current metadata
```

Installed to `~/.claude/bin/tm-meta`. `install.sh` adds a one-line hint
reminding you to put `~/.claude/bin` on your `PATH` if it isn't already.

## `terminal-server.service.template`

Systemd user-unit template. `install.sh` substitutes `__REPO_DIR__`,
`__NODE_BIN__`, `__TMUX_SOCKET__`, `__PORT__` and writes the result to
`~/.config/systemd/user/terminal-server.service`.

## `persist/` — tmux sessions that survive reboots and crashes

`tm-snapshot` records every context's tmux sessions (windows, pane cwds) and
the Claude Code session running in each pane, matched through Claude's own
registry (`~/.claude/sessions/<pid>.json`, which names the tmux target of each
live interactive session). Peer contexts are read via `sudo -u <user>`, same
as the server does. Output under `~/.local/state/terminal/`: `sessions.json`,
ten per-tick backups, `hourly/` (48 h) and `sessions.last-good.json` (newest
snapshot with at least one Claude session). It will not write while
`terminal-server.service` is down or was restarted less than two minutes ago,
so a crash can't get recorded as "no sessions" before restore has run.

`tm-restore` recreates missing sessions on each context's socket (existing
ones are skipped), seeds `CLAUDE_META_DIR`/`TMUX_SOCKET` like the server, and
sends `claude --resume <id> <original flags>` to panes that had Claude in them.
Session-selection flags (`--continue`, `--resume`, `--session-id`, prompts) are
stripped; the rest (`--dangerously-skip-permissions`, `--model …`) are kept.
A pane whose cwd no longer exists is created in the context default without
resuming. It runs from the server's `ExecStartPre`, so it covers boot and the
automatic relaunch after a crash or an `systemd-oomd` cgroup kill (all tmux
servers live in the server's cgroup, so an oomd kill wipes every context at
once — that is what happened on 2026-10-13, not a reboot). If `sessions.json`
has no Claude sessions and the server's last run ended abnormally, it restores
from `sessions.last-good.json` instead. `tm-restore --from FILE` restores any
saved snapshot by hand.

Units (installed by `scripts/persist/install.sh`, user systemd, no sudo):

- `terminal-server.service.d/persist.conf` — `ExecStartPre=tm-restore`,
  `ExecStop=tm-snapshot --force`, `ManagedOOMPreference=avoid` (oomd kills this
  cgroup only as a last resort).
- `terminal-snapshot.timer` → `.service` — every minute, starting 3 min after boot.

Knobs: `TERMINAL_RESTORE_AUTORUN=0` (type the resume command, don't run it),
`TERMINAL_RESTORE_DRY_RUN=1`, `tm-snapshot --stdout` to inspect without writing.
