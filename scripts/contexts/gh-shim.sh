#!/usr/bin/env bash
# scripts/contexts/gh-shim.sh — install / uninstall / inspect the system-wide
# gh shim that polices the restricted per-context users.
#
#   sudo ./scripts/contexts/gh-shim.sh install      # idempotent, re-run after edits
#   sudo ./scripts/contexts/gh-shim.sh uninstall    # removes the wrapper, keeps policy
#   sudo ./scripts/contexts/gh-shim.sh uninstall --purge   # also removes /etc/terminal/gh-shim.conf
#        ./scripts/contexts/gh-shim.sh status       # no root needed
#
# What install does (Arch / Omarchy):
#   - `pacman -S --needed github-cli` if /usr/bin/gh is missing, so the real
#     binary exists system-wide for every context user (they can't see the
#     admin's mise-managed gh inside the admin home).
#   - copies scripts/bin/gh -> /usr/local/bin/gh (root:root 0755). /usr/local/bin
#     precedes /usr/bin on every user's PATH, so `gh` resolves to the shim and
#     pacman upgrades of github-cli never touch it.
#   - writes /etc/terminal/gh-shim.conf from gh-shim.conf.example if absent.
#     The policy (restricted users, blocked orgs) lives there; edit it directly.
#
# See scripts/contexts/README.md ("GitHub CLI shim") for the design.

set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
REPO_DIR="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"

SHIM_SRC="$REPO_DIR/scripts/bin/gh"
SHIM_DEST=/usr/local/bin/gh
REAL_GH=/usr/bin/gh
CONF_EXAMPLE="$REPO_DIR/scripts/contexts/gh-shim.conf.example"
CONF_DIR=/etc/terminal
CONF="$CONF_DIR/gh-shim.conf"
SHIM_MARKER='terminal-gh-shim'

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { warn "$@"; exit 1; }

need_root() { [[ $EUID -eq 0 ]] || die "gh-shim.sh $1 must be run with sudo."; }

# BLOCKED_ORGS / ALLOWED_OWNER ship as `your-…` placeholders in the example.
warn_placeholders() {
  [[ -f "$CONF" ]] || return 0
  if grep -qE '^[^#]*\byour-(blocked-org|github-account)\b' "$CONF"; then
    warn "$CONF still has placeholder values — set BLOCKED_ORGS and ALLOWED_OWNER there"
  fi
}

# First BLOCKED_ORGS entry from the policy, for the verify hint.
first_blocked_org() {
  [[ -f "$CONF" ]] || return 0
  bash -c "source '$CONF' && echo \"\${BLOCKED_ORGS[0]:-}\"" 2>/dev/null
}

is_our_shim() { [[ -f "$1" ]] && grep -qF "$SHIM_MARKER" "$1"; }

cmd_install() {
  need_root install
  [[ -f "$SHIM_SRC" ]] || die "shim source $SHIM_SRC is missing"
  bash -n "$SHIM_SRC" || die "shim source failed syntax check"

  # 1. real gh ---------------------------------------------------------------
  if [[ -x "$REAL_GH" ]]; then
    if is_our_shim "$REAL_GH"; then
      die "$REAL_GH is the shim itself — remove it and reinstall github-cli first"
    fi
    log "real gh present: $("$REAL_GH" --version | head -1)"
  elif command -v pacman >/dev/null 2>&1; then
    log "installing github-cli via pacman"
    pacman -S --needed --noconfirm github-cli
  else
    die "$REAL_GH is missing and pacman is unavailable; install GitHub CLI there first"
  fi

  # 2. wrapper ---------------------------------------------------------------
  if [[ -e "$SHIM_DEST" ]] && ! is_our_shim "$SHIM_DEST"; then
    die "$SHIM_DEST exists and is not the terminal shim — refusing to overwrite"
  fi
  install -m 0755 -o root -g root "$SHIM_SRC" "$SHIM_DEST"
  log "installed $SHIM_DEST"

  # 3. policy file -------------------------------------------------------------
  install -d -o root -g root -m 0755 "$CONF_DIR"
  if [[ -f "$CONF" ]]; then
    log "$CONF already exists — leaving it alone"
  elif [[ -f "$CONF_EXAMPLE" ]]; then
    install -m 0644 -o root -g root "$CONF_EXAMPLE" "$CONF"
    log "wrote $CONF from example"
  else
    warn "$CONF_EXAMPLE missing; shim will use its built-in defaults"
  fi
  warn_placeholders

  local org
  org="$(first_blocked_org)"
  cat <<EOF

Done. Verify:
  gh --version                                   # admin: passes through
  sudo -u agent-untrusted gh auth status         # restricted: still authed
  sudo -u agent-untrusted gh repo view ${org:-<blocked-org>}/foo    # -> gh-restricted: refusing
  sudo -u agent-untrusted gh auth login          # -> disabled for this user
  gh shim-help                                   # FGPAT rotation procedure
  ./scripts/contexts/gh-shim.sh status
EOF
}

cmd_uninstall() {
  need_root uninstall
  local purge=0
  [[ "${1:-}" == "--purge" ]] && purge=1

  if is_our_shim "$SHIM_DEST"; then
    rm -f "$SHIM_DEST"
    log "removed $SHIM_DEST"
  elif [[ -e "$SHIM_DEST" ]]; then
    warn "$SHIM_DEST is not the terminal shim; leaving it alone"
  else
    log "$SHIM_DEST not present"
  fi

  if [[ $purge -eq 1 ]]; then
    if [[ -f "$CONF" ]]; then
      rm -f "$CONF"
      log "removed $CONF"
    fi
    rmdir "$CONF_DIR" 2>/dev/null && log "removed empty $CONF_DIR" || true
  else
    [[ -f "$CONF" ]] && log "kept $CONF (pass --purge to remove)"
  fi
  log "github-cli package left installed; 'sudo pacman -Rs github-cli' if unwanted"
}

cmd_status() {
  if is_our_shim "$SHIM_DEST"; then
    log "shim installed at $SHIM_DEST"
    if ! cmp -s "$SHIM_SRC" "$SHIM_DEST"; then
      warn "installed shim differs from $SHIM_SRC — re-run 'sudo gh-shim.sh install'"
    fi
  else
    warn "shim NOT installed at $SHIM_DEST"
  fi

  if [[ -x "$REAL_GH" ]]; then
    log "real gh: $("$REAL_GH" --version | head -1)"
  else
    warn "real gh missing at $REAL_GH (sudo pacman -S github-cli)"
  fi

  if [[ -f "$CONF" ]]; then
    log "policy $CONF:"
    grep -vE '^\s*(#|$)' "$CONF" | sed 's/^/    /'
    warn_placeholders
  else
    warn "no $CONF — shim uses built-in defaults"
  fi

  # Per-user auth probe (works when the caller can sudo -u into the contexts,
  # i.e. the admin user set up by setup.sh).
  local users=()
  if [[ -f "$CONF" ]]; then
    # shellcheck disable=SC1090
    users=("$(bash -c "source '$CONF' && echo \"\${RESTRICTED_USERS[*]}\"")")
    read -r -a users <<< "${users[0]}"
  fi
  [[ ${#users[@]} -gt 0 ]] || users=(agent-untrusted agent-john)
  local gh_bin="$SHIM_DEST"
  [[ -x "$gh_bin" ]] || gh_bin="$REAL_GH"
  [[ -x "$gh_bin" ]] || return 0
  for u in "${users[@]}"; do
    id "$u" >/dev/null 2>&1 || { warn "$u: no such user"; continue; }
    if out="$(sudo -n -u "$u" "$gh_bin" auth status 2>&1)"; then
      log "$u: $(grep -m1 'Logged in' <<<"$out" | sed 's/^ *//')"
    else
      warn "$u: auth probe failed"
      sed 's/^/    /' <<<"$out" | head -5 >&2
    fi
  done
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) shift; cmd_uninstall "$@" ;;
  status)    cmd_status ;;
  *)
    sed -n '2,10p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
