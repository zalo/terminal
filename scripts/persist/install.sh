#!/usr/bin/env bash
# Install the tmux-session persistence units into the current user's systemd.
# No sudo needed. Re-run after moving the repo. `./install.sh --uninstall` removes them.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DROPIN_DIR="$UNIT_DIR/terminal-server.service.d"

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now terminal-snapshot.timer 2>/dev/null || true
  systemctl --user disable --now terminal-restore.service 2>/dev/null || true   # legacy unit
  rm -f "$UNIT_DIR"/terminal-{restore,snapshot}.service "$UNIT_DIR"/terminal-snapshot.timer "$DROPIN_DIR/persist.conf"
  systemctl --user daemon-reload
  echo "removed persistence units (snapshots in ~/.local/state/terminal left in place)"
  exit 0
fi

mkdir -p "$UNIT_DIR" "$DROPIN_DIR"
# Legacy once-per-boot restore unit from the first version: restore now runs
# from the server's ExecStartPre instead.
if [[ -e "$UNIT_DIR/terminal-restore.service" ]]; then
  systemctl --user disable terminal-restore.service >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/terminal-restore.service"
fi
for f in terminal-snapshot.service terminal-snapshot.timer; do
  sed "s|__REPO_DIR__|$REPO_DIR|g" "$REPO_DIR/scripts/persist/$f" > "$UNIT_DIR/$f"
done
sed "s|__REPO_DIR__|$REPO_DIR|g" "$REPO_DIR/scripts/persist/terminal-server-persist.conf" > "$DROPIN_DIR/persist.conf"
systemctl --user daemon-reload
systemctl --user enable terminal-snapshot.timer >/dev/null
# Running restore once now is safe (existing sessions are skipped) and writes
# the per-boot marker that lets the snapshot timer start writing.
"$REPO_DIR/scripts/persist/tm-restore"
systemctl --user start terminal-snapshot.timer
TERMINAL_SNAPSHOT_FORCE=1 "$REPO_DIR/scripts/persist/tm-snapshot"
echo "installed. snapshot: ~/.local/state/terminal/sessions.json"
echo "note: the ExecStartPre/ExecStop/oomd changes to terminal-server.service take effect on its next"
echo "      restart (systemctl --user restart terminal-server is tmux-safe: KillMode=process)."
