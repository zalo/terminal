#!/usr/bin/env bash
# scripts/contexts/revert.sh — undo everything setup.sh did.
#
# Prompts before destructive operations (home directory deletion). Skip prompts
# with ASSUME_YES=1.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "revert.sh must be run with sudo." >&2
  exit 1
fi

ADMIN_USER="${ADMIN_USER:-$(logname 2>/dev/null || echo '')}"
read -r -a CONTEXTS <<< "${CONTEXTS:-agent-work agent-john agent-untrusted agent-tom}"
GROUP="${GROUP:-terminal-admin}"
ASSUME_YES="${ASSUME_YES:-0}"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

confirm() {
  [[ "$ASSUME_YES" == "1" ]] && return 0
  read -r -p "$1 [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

# 1. remove the sudoers drop-in first — we want this gone even if the rest
#    of the revert is interrupted
SUDOERS_FILE=/etc/sudoers.d/terminal-coordinator
if [[ -f "$SUDOERS_FILE" ]]; then
  rm -f "$SUDOERS_FILE"
  log "removed $SUDOERS_FILE"
fi

# 1b. remove the systemd user drop-in that enables coordinator mode, then
#     reload + restart so terminal-server drops back to single-context mode.
#     Gentle: only remove if it has our "Managed by" marker. Leave
#     config/contexts.json alone (user may have customized it).
if [[ -n "${ADMIN_USER:-}" ]] && id "$ADMIN_USER" >/dev/null 2>&1; then
  ADMIN_HOME="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
  if [[ -n "$ADMIN_HOME" && -d "$ADMIN_HOME" ]]; then
    DROPIN_DIR="$ADMIN_HOME/.config/systemd/user/terminal-server.service.d"
    DROPIN_FILE="$DROPIN_DIR/contexts.conf"

    if [[ -f "$DROPIN_FILE" ]]; then
      if grep -q '^# Managed by scripts/contexts/setup.sh' "$DROPIN_FILE" 2>/dev/null; then
        rm -f "$DROPIN_FILE"
        log "removed drop-in $DROPIN_FILE"
        # Best-effort cleanup of empty parent dir
        rmdir "$DROPIN_DIR" 2>/dev/null || true
      else
        warn "$DROPIN_FILE is not managed by setup.sh; leaving it alone"
      fi
    fi

    ADMIN_UID="$(id -u "$ADMIN_USER")"
    RUNTIME_DIR="/run/user/$ADMIN_UID"
    as_admin() { sudo -u "$ADMIN_USER" env XDG_RUNTIME_DIR="$RUNTIME_DIR" "$@"; }
    if [[ -d "$RUNTIME_DIR" ]]; then
      as_admin systemctl --user daemon-reload >/dev/null 2>&1 || true
      if as_admin systemctl --user is-active --quiet terminal-server 2>/dev/null; then
        if as_admin systemctl --user restart terminal-server >/dev/null 2>&1; then
          log "restarted terminal-server (single-context mode)"
        fi
      fi
    fi
  fi
fi

# 1c. remove tm-notify + per-user CLAUDE.md notifications block --------------
TM_NOTIFY_DEST=/usr/local/bin/tm-notify
if [[ -f "$TM_NOTIFY_DEST" ]]; then
  rm -f "$TM_NOTIFY_DEST"
  log "removed $TM_NOTIFY_DEST"
fi

NOTIF_BEGIN='<!-- BEGIN: terminal-notifications (managed by scripts/contexts/setup.sh) -->'
NOTIF_END='<!-- END: terminal-notifications -->'
strip_notif_block_for_user() {
  local u="$1"
  local home
  home="$(getent passwd "$u" 2>/dev/null | cut -d: -f6)"
  [[ -n "$home" ]] || return 0
  local cfile="$home/.claude/CLAUDE.md"
  [[ -f "$cfile" ]] || return 0
  if grep -qF "$NOTIF_BEGIN" "$cfile"; then
    # Delete the block (and any trailing blank line right after END) in place
    sed -i "/$(printf '%s' "$NOTIF_BEGIN" | sed 's/[][\/.^$*]/\\&/g')/,/$(printf '%s' "$NOTIF_END" | sed 's/[][\/.^$*]/\\&/g')/d" "$cfile"
    # Trim double blank lines that may be left behind
    sed -i '/^$/N;/^\n$/D' "$cfile"
    log "removed notifications block from $cfile"
  fi
}
for u in "${ADMIN_USER:-}" "${CONTEXTS[@]}"; do
  [[ -n "$u" ]] && id "$u" >/dev/null 2>&1 && strip_notif_block_for_user "$u"
done

# 2. stop any peer services that earlier iterations may have installed --------
for user in "${CONTEXTS[@]}"; do
  id "$user" >/dev/null 2>&1 || continue
  sudo -iu "$user" systemctl --user stop terminal-peer 2>/dev/null || true
  sudo -iu "$user" systemctl --user disable terminal-peer 2>/dev/null || true
done

# 2. disable linger ------------------------------------------------------------
for user in "${CONTEXTS[@]}"; do
  id "$user" >/dev/null 2>&1 || continue
  loginctl disable-linger "$user" 2>/dev/null && log "disabled linger for $user" || true
done

# 3. delete users (with confirmation) ------------------------------------------
for user in "${CONTEXTS[@]}"; do
  if ! id "$user" >/dev/null 2>&1; then
    log "user $user does not exist, skipping"
    continue
  fi
  if confirm "Delete user $user AND their home directory /home/$user?"; then
    # Kill any lingering processes first so userdel doesn't refuse
    pkill -9 -u "$user" 2>/dev/null || true
    sleep 1
    if userdel -r "$user" 2>/dev/null; then
      log "deleted user $user and their home"
    else
      warn "userdel -r failed for $user; falling back to userdel (home retained)"
      userdel "$user" || warn "  userdel also failed for $user"
    fi
  else
    log "kept user $user"
  fi
done

# 4. remove admin from group ---------------------------------------------------
if [[ -n "$ADMIN_USER" ]] && id "$ADMIN_USER" >/dev/null 2>&1; then
  if id -nG "$ADMIN_USER" | tr ' ' '\n' | grep -qx "$GROUP"; then
    gpasswd -d "$ADMIN_USER" "$GROUP" >/dev/null
    log "removed $ADMIN_USER from $GROUP"
  fi
fi

# 5. delete group --------------------------------------------------------------
if getent group "$GROUP" >/dev/null; then
  if confirm "Delete group $GROUP?"; then
    groupdel "$GROUP" && log "deleted group $GROUP" || warn "groupdel failed"
  else
    log "kept group $GROUP"
  fi
fi

log "revert complete. The existing terminal-server service was not touched."
