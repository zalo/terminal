#!/usr/bin/env bash
# Terminal — one-shot installer for new machines.
#
# Installs npm deps, builds server+frontend, wires up the Claude Code metadata
# hooks (idempotently), and optionally installs a systemd user service.
#
# Flags:
#   --no-service    skip installing the systemd user service
#   --no-hooks      skip wiring up Claude Code hooks / tm-meta
#   --no-start      install the service but do not enable/start it
#   --dev           install for development only (deps + hooks, no build/service)
#
# Env overrides (also honored by the service template):
#   PORT                  default 3000
#   TMUX_SOCKET           default /tmp/orchestrator-tmux.sock
#   CLAUDE_META_DIR       default /tmp/claude-terminal-meta
#   NODE_BIN              default $(command -v node)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

INSTALL_SERVICE=1
INSTALL_HOOKS=1
START_SERVICE=1
DEV_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --no-service) INSTALL_SERVICE=0 ;;
    --no-hooks)   INSTALL_HOOKS=0 ;;
    --no-start)   START_SERVICE=0 ;;
    --dev)        DEV_ONLY=1; INSTALL_SERVICE=0 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

PORT="${PORT:-3000}"
TMUX_SOCKET="${TMUX_SOCKET:-/tmp/orchestrator-tmux.sock}"
CLAUDE_META_DIR="${CLAUDE_META_DIR:-/tmp/claude-terminal-meta}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

# --- dependency checks ---------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || { warn "missing dependency: $1"; return 1; }; }
missing=0
need node || missing=1
need npm  || missing=1
need tmux || missing=1
need python3 || missing=1
[[ "$missing" -eq 1 ]] && { warn "install the missing dependencies above and re-run."; exit 1; }

if [[ -z "$NODE_BIN" ]]; then
  warn "could not resolve NODE_BIN — set it explicitly (e.g. NODE_BIN=\$(command -v node) ./install.sh)"
  exit 1
fi

# --- .env ----------------------------------------------------------------------
if [[ ! -f "$REPO_DIR/.env" ]]; then
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  log "created .env from .env.example (edit it to customize)"
fi

# --- npm install ---------------------------------------------------------------
log "installing server deps"
(cd "$REPO_DIR/server" && npm install --no-audit --no-fund)
log "installing frontend deps"
(cd "$REPO_DIR/frontend" && npm install --no-audit --no-fund)

# --- build (skip in --dev) -----------------------------------------------------
if [[ "$DEV_ONLY" -eq 0 ]]; then
  log "building server (tsc)"
  (cd "$REPO_DIR/server" && npx tsc)
  log "building frontend (vite)"
  (cd "$REPO_DIR/frontend" && npm run build)
fi

# --- Claude Code hooks + tm-meta ----------------------------------------------
if [[ "$INSTALL_HOOKS" -eq 1 ]]; then
  CLAUDE_DIR="${HOME}/.claude"
  HOOKS_DIR="${CLAUDE_DIR}/hooks"
  BIN_DIR="${CLAUDE_DIR}/bin"
  SETTINGS="${CLAUDE_DIR}/settings.json"

  mkdir -p "$HOOKS_DIR" "$BIN_DIR"
  install -m 0755 "$REPO_DIR/scripts/hooks/terminal-meta.py" "$HOOKS_DIR/terminal-meta.py"
  install -m 0755 "$REPO_DIR/scripts/bin/tm-meta"             "$BIN_DIR/tm-meta"
  install -m 0755 "$REPO_DIR/scripts/bin/tm-notify"           "$BIN_DIR/tm-notify"
  log "installed terminal-meta.py → $HOOKS_DIR and tm-meta / tm-notify → $BIN_DIR"

  # Idempotently merge hook entries into settings.json via Python.
  HOOK_CMD="$HOOKS_DIR/terminal-meta.py" python3 - "$SETTINGS" <<'PY'
import json, os, sys
from pathlib import Path

path = Path(sys.argv[1])
cmd = os.environ["HOOK_CMD"]
hook_entry = {"type": "command", "command": cmd, "timeout": 5}

cfg = {}
if path.exists():
    try:
        cfg = json.loads(path.read_text())
    except Exception:
        print(f"warning: {path} is not valid JSON — leaving it alone", file=sys.stderr)
        sys.exit(0)

hooks = cfg.setdefault("hooks", {})

def ensure(event, matcher=None):
    """Add our hook entry to `event`, creating the matcher group if missing.
    Never duplicates: keyed on the command path."""
    groups = hooks.setdefault(event, [])
    group = None
    for g in groups:
        if matcher is None or g.get("matcher", "") == matcher:
            group = g
            break
    if group is None:
        group = {"hooks": []}
        if matcher is not None:
            group["matcher"] = matcher
        groups.append(group)
    group.setdefault("hooks", [])
    if not any(h.get("command") == cmd for h in group["hooks"]):
        group["hooks"].append(hook_entry)

ensure("UserPromptSubmit")
ensure("Stop")
ensure("SessionStart", matcher="")
ensure("SessionEnd", matcher="")

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(cfg, indent=2) + "\n")
print(f"merged hooks into {path}")
PY

  # Friendly PATH reminder.
  case ":$PATH:" in
    *":$BIN_DIR:"*) : ;;
    *) warn "add \"$BIN_DIR\" to your PATH so agents can run tm-meta"; warn "  e.g. echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc" ;;
  esac
fi

# --- systemd user service -----------------------------------------------------
if [[ "$INSTALL_SERVICE" -eq 1 ]]; then
  UNIT_DIR="${HOME}/.config/systemd/user"
  UNIT="${UNIT_DIR}/terminal-server.service"
  mkdir -p "$UNIT_DIR"

  sed \
    -e "s|__REPO_DIR__|${REPO_DIR}|g" \
    -e "s|__NODE_BIN__|${NODE_BIN}|g" \
    -e "s|__TMUX_SOCKET__|${TMUX_SOCKET}|g" \
    -e "s|__PORT__|${PORT}|g" \
    "$REPO_DIR/scripts/terminal-server.service.template" > "$UNIT"
  log "installed systemd unit → $UNIT"

  systemctl --user daemon-reload
  if [[ "$START_SERVICE" -eq 1 ]]; then
    systemctl --user enable terminal-server >/dev/null
    systemctl --user restart terminal-server
    sleep 1
    systemctl --user --no-pager status terminal-server | head -5 || true
    log "service running on http://localhost:${PORT}"
  fi
fi

log "install complete"
[[ "$DEV_ONLY" -eq 1 ]] && log "dev mode: run ./dev.sh to start server+frontend with hot reload"
