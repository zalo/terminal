#!/usr/bin/env bash
# scripts/contexts/setup.sh — sudo setup for the per-context Linux users.
#
# See scripts/contexts/README.md for the full design.
#
# Idempotent. Safe to re-run. Does NOT touch the existing terminal-server
# service or any files in selstad's home. Revert with revert.sh.
#
# What it does:
#   - creates group `terminal-admin` (shared-access group for coordinator)
#   - adds $ADMIN_USER to that group
#   - creates users: agent-work, agent-john, agent-untrusted, agent-tom
#   - sets each home to mode 0710 $user:terminal-admin
#       (admin can traverse, nobody else can see inside)
#   - creates ~/Desktop for each agent user (their project workspace; 0750)
#   - enables systemd linger for each user so peer services can run unattended
#   - installs /etc/sudoers.d/terminal-coordinator so the admin user can run
#     commands as each agent user without a password (how the coordinator
#     dispatches to contexts)
#   - copies config/contexts.example.json → config/contexts.json ONLY if the
#     target doesn't already exist (gentle: never clobbers customized config)
#   - installs a systemd user drop-in at
#     ~$ADMIN_USER/.config/systemd/user/terminal-server.service.d/contexts.conf
#     that sets CONTEXTS_CONFIG to the JSON above (only writes if absent, or
#     already exactly what we'd write; warns if differing)
#   - daemon-reload + restart terminal-server so the drop-in takes effect
#
# Env overrides:
#   ADMIN_USER   default: output of `logname` (the user who invoked sudo)
#   CONTEXTS     default: "agent-work agent-john agent-untrusted agent-tom"
#   GROUP        default: terminal-admin

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "setup.sh must be run with sudo." >&2
  exit 1
fi

ADMIN_USER="${ADMIN_USER:-$(logname 2>/dev/null || echo '')}"
if [[ -z "$ADMIN_USER" ]]; then
  echo "could not determine admin user; set ADMIN_USER=<name> and re-run" >&2
  exit 1
fi
if ! id "$ADMIN_USER" >/dev/null 2>&1; then
  echo "admin user '$ADMIN_USER' does not exist" >&2
  exit 1
fi

read -r -a CONTEXTS <<< "${CONTEXTS:-agent-work agent-john agent-untrusted agent-tom}"
GROUP="${GROUP:-terminal-admin}"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

# 1. admin group ---------------------------------------------------------------
if getent group "$GROUP" >/dev/null; then
  log "group $GROUP already exists"
else
  groupadd "$GROUP"
  log "created group $GROUP"
fi

# 2. add admin to group --------------------------------------------------------
if id -nG "$ADMIN_USER" | tr ' ' '\n' | grep -qx "$GROUP"; then
  log "$ADMIN_USER is already in $GROUP"
else
  usermod -aG "$GROUP" "$ADMIN_USER"
  log "added $ADMIN_USER to $GROUP (new shells need 'newgrp $GROUP' or re-login)"
fi

# 3. per-context users + workspace dirs + linger -------------------------------
for user in "${CONTEXTS[@]}"; do
  if id "$user" >/dev/null 2>&1; then
    log "user $user exists"
  else
    useradd -m -s /bin/bash "$user"
    log "created user $user"
  fi

  # Home mode 0710 $user:terminal-admin
  #   owner:  rwx  (user themselves)
  #   group:  --x  (admin can traverse into here to reach the peer socket)
  #   other:  ---
  chown "$user":"$GROUP" "/home/$user"
  chmod 0710 "/home/$user"

  # Desktop is the project workspace for this context
  install -d -o "$user" -g "$user" -m 0750 "/home/$user/Desktop"

  # Drop a README on the desktop so it's obvious what it's for
  readme="/home/$user/Desktop/README.md"
  if [[ ! -e "$readme" ]]; then
    cat > "$readme" <<EOF
# $user workspace

This desktop directory is the project workspace for the \`$user\` terminal
context. Clone repos / create project directories here. Only this user and
root can read its contents.
EOF
    chown "$user":"$user" "$readme"
    chmod 0640 "$readme"
  fi

  # Enable linger so systemctl --user services survive without a login
  if loginctl show-user "$user" 2>/dev/null | grep -q '^Linger=yes'; then
    log "linger already enabled for $user"
  else
    loginctl enable-linger "$user"
    log "enabled linger for $user"
  fi
done

# 4. sudoers drop-in ----------------------------------------------------------
# Grants the admin user passwordless sudo -u to each agent user. This is the
# mechanism the coordinator uses to dispatch terminal sessions into their
# respective contexts without running a long-lived backend inside each user.
SUDOERS_FILE=/etc/sudoers.d/terminal-coordinator
SUDOERS_TMP="$(mktemp)"
trap 'rm -f "$SUDOERS_TMP"' EXIT

{
  echo "# Installed by scripts/contexts/setup.sh — do not edit by hand."
  echo "# Revert by running scripts/contexts/revert.sh."
  echo "#"
  echo "# Grants $ADMIN_USER passwordless sudo into each context user."
  echo "# Only the admin user is granted this; other users can NOT cross contexts."
  for user in "${CONTEXTS[@]}"; do
    printf '%s ALL=(%s) NOPASSWD: ALL\n' "$ADMIN_USER" "$user"
  done
} > "$SUDOERS_TMP"
chmod 0440 "$SUDOERS_TMP"
chown root:root "$SUDOERS_TMP"

if visudo -cf "$SUDOERS_TMP" >/dev/null; then
  mv "$SUDOERS_TMP" "$SUDOERS_FILE"
  trap - EXIT
  log "installed $SUDOERS_FILE"
else
  warn "sudoers file failed visudo validation; not installing"
  cat "$SUDOERS_TMP" >&2
  exit 1
fi

# 5. contexts.json config file -------------------------------------------------
# Copy from example if the target doesn't exist. Never clobber an existing one.
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
REPO_DIR="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"
CONFIG_EXAMPLE="$REPO_DIR/config/contexts.example.json"
CONFIG_TARGET="$REPO_DIR/config/contexts.json"

if [[ ! -f "$CONFIG_EXAMPLE" ]]; then
  warn "config template $CONFIG_EXAMPLE is missing; skipping contexts.json install"
elif [[ -f "$CONFIG_TARGET" ]]; then
  log "$CONFIG_TARGET already exists — leaving it alone"
else
  install -o "$ADMIN_USER" -g "$ADMIN_USER" -m 0644 "$CONFIG_EXAMPLE" "$CONFIG_TARGET"
  log "wrote $CONFIG_TARGET from example"
fi

# 6. systemd user drop-in for terminal-server ----------------------------------
# Gentle install: ensure a drop-in file exists that sets CONTEXTS_CONFIG. If
# the file is already there and already points at the same path, no-op. If it
# points elsewhere, warn and leave alone (respect whatever the user wrote).
ADMIN_HOME="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
if [[ -z "$ADMIN_HOME" || ! -d "$ADMIN_HOME" ]]; then
  warn "could not resolve home dir for $ADMIN_USER; skipping systemd drop-in"
else
  DROPIN_DIR="$ADMIN_HOME/.config/systemd/user/terminal-server.service.d"
  DROPIN_FILE="$DROPIN_DIR/contexts.conf"
  WANT_LINE="Environment=CONTEXTS_CONFIG=$CONFIG_TARGET"

  install -d -o "$ADMIN_USER" -g "$ADMIN_USER" -m 0755 "$DROPIN_DIR"

  if [[ -f "$DROPIN_FILE" ]]; then
    existing="$(grep -E '^Environment=CONTEXTS_CONFIG=' "$DROPIN_FILE" 2>/dev/null || true)"
    if [[ -z "$existing" ]]; then
      warn "drop-in $DROPIN_FILE exists but has no CONTEXTS_CONFIG line; leaving it alone"
    elif [[ "$existing" == "$WANT_LINE" ]]; then
      log "drop-in already points at $CONFIG_TARGET"
    else
      warn "drop-in already sets CONTEXTS_CONFIG to: ${existing#Environment=CONTEXTS_CONFIG=}"
      warn "  leaving it alone; edit $DROPIN_FILE by hand to change"
    fi
  else
    cat > "$DROPIN_FILE" <<EOF
# Managed by scripts/contexts/setup.sh — safe to delete to disable coordinator
# mode, or run scripts/contexts/revert.sh to undo setup.
[Service]
$WANT_LINE
EOF
    chown "$ADMIN_USER":"$ADMIN_USER" "$DROPIN_FILE"
    chmod 0644 "$DROPIN_FILE"
    log "wrote drop-in $DROPIN_FILE"
  fi
fi

# 7. tm-notify system-wide + per-user CLAUDE.md notification block ------------
# Installs /usr/local/bin/tm-notify so every user (admin + agent-*) has it on
# their PATH, then appends a Notifications block to each user's
# ~/.claude/CLAUDE.md so Claude Code sessions running as that user know
# when to call it. Gentle: never clobbers a customized CLAUDE.md — uses
# BEGIN/END markers so re-running this script is a no-op when the block is
# already present, and revert.sh can strip it cleanly.

TM_NOTIFY_SRC="$REPO_DIR/scripts/bin/tm-notify"
TM_NOTIFY_DEST=/usr/local/bin/tm-notify
if [[ -f "$TM_NOTIFY_SRC" ]]; then
  install -m 0755 -o root -g root "$TM_NOTIFY_SRC" "$TM_NOTIFY_DEST"
  log "installed $TM_NOTIFY_DEST"
else
  warn "$TM_NOTIFY_SRC missing; skipping system-wide install"
fi

NOTIF_BEGIN='<!-- BEGIN: terminal-notifications (managed by scripts/contexts/setup.sh) -->'
NOTIF_END='<!-- END: terminal-notifications -->'
NOTIF_BODY="$NOTIF_BEGIN
## Notifications

This machine has \`tm-notify\` at \`/usr/local/bin/tm-notify\`. It sends a push
notification to the user's subscribed device(s) (typically their phone) via
the local terminal-server. Use it to alert the user when:

- A long-running task (build, test suite, large operation) finishes —
  successfully or with an error.
- You hit a question that blocks progress and they may not be watching the
  screen.
- A background process the user expects to be monitoring changes state
  meaningfully (deploy done, dev server up, long-running script crashed).

Skip for: routine actions, short ops, every step of normal work — the
user can read the terminal.

Usage:

\`\`\`bash
tm-notify \"Build done\"
tm-notify \"Tests passed\" \"All 234 green\"
tm-notify \"Heads up\" \"Long task complete\" --tag long-task
tm-notify \"Needs input\" \"Question pending\" --url /?session=my-session
\`\`\`

Flags: \`--tag\` (notifications sharing a tag replace one another — use a
stable tag for anything that fires repeatedly), \`--url\` (where to navigate
when the notification is tapped, defaults to \`/\`), \`--icon\` (override icon).

The endpoint is loopback-only — works from any shell on this machine.
$NOTIF_END"

ensure_notif_block_for_user() {
  local u="$1"
  local home
  home="$(getent passwd "$u" | cut -d: -f6)"
  if [[ -z "$home" || ! -d "$home" ]]; then
    warn "no home dir for $u; skipping CLAUDE.md notification block"
    return
  fi
  local cdir="$home/.claude"
  local cfile="$cdir/CLAUDE.md"

  # Create ~/.claude if absent, owned by the user.
  if [[ ! -d "$cdir" ]]; then
    install -d -o "$u" -g "$u" -m 0750 "$cdir"
  fi

  if [[ -f "$cfile" ]] && grep -qF "$NOTIF_BEGIN" "$cfile"; then
    log "CLAUDE.md for $u already has notifications block"
    return
  fi

  # Append (or create) with a leading blank line separator.
  if [[ -s "$cfile" ]]; then
    {
      printf '\n\n'
      printf '%s\n' "$NOTIF_BODY"
    } >> "$cfile"
  else
    printf '%s\n' "$NOTIF_BODY" > "$cfile"
  fi
  chown "$u":"$u" "$cfile"
  chmod 0640 "$cfile"
  log "wrote notifications block to $cfile"
}

for u in "$ADMIN_USER" "${CONTEXTS[@]}"; do
  ensure_notif_block_for_user "$u"
done

# 8. daemon-reload + restart terminal-server for the admin user ---------------
ADMIN_UID="$(id -u "$ADMIN_USER")"
RUNTIME_DIR="/run/user/$ADMIN_UID"
as_admin() { sudo -u "$ADMIN_USER" env XDG_RUNTIME_DIR="$RUNTIME_DIR" "$@"; }

if [[ -d "$RUNTIME_DIR" ]]; then
  if as_admin systemctl --user daemon-reload >/dev/null 2>&1; then
    log "daemon-reload (user=$ADMIN_USER)"
  else
    warn "systemctl --user daemon-reload failed; continuing"
  fi
  if as_admin systemctl --user is-enabled --quiet terminal-server 2>/dev/null \
     || as_admin systemctl --user is-active --quiet terminal-server 2>/dev/null; then
    if as_admin systemctl --user restart terminal-server >/dev/null 2>&1; then
      log "restarted terminal-server"
    else
      warn "systemctl --user restart terminal-server failed; check logs"
    fi
  else
    log "terminal-server not yet installed for $ADMIN_USER — drop-in will apply on first start"
  fi
else
  warn "no user runtime dir at $RUNTIME_DIR — systemctl skipped"
  warn "  run these by hand as $ADMIN_USER:"
  warn "    systemctl --user daemon-reload && systemctl --user restart terminal-server"
fi

log "setup complete."

cat <<EOF

Next steps:

  1. Activate the new group for your current shell:
       newgrp $GROUP
     (or just log out and back in)

  2. Verify:
       getent group $GROUP
       ls -ld /home/agent-*
       loginctl list-users
       sudo cat /etc/sudoers.d/terminal-coordinator
       curl -s http://localhost:3000/api/contexts

If terminal-server was already running, coordinator mode is now ENABLED. The
UI "New Session" dialog should show a context picker. Create a session in
one of the contexts and check \`whoami\` in the shell — it should be the
agent user for that context.

To disable coordinator mode without removing users:
  rm '$DROPIN_FILE' 2>/dev/null
  systemctl --user daemon-reload && systemctl --user restart terminal-server

To undo everything this script did:
  sudo $(dirname "$0")/revert.sh
EOF
