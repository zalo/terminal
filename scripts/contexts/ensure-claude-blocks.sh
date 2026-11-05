#!/usr/bin/env bash
# Ensure the managed CLAUDE.md blocks (notifications, sharing) exist in each
# listed user's ~/.claude/CLAUDE.md. Idempotent: a block is appended only if
# its BEGIN marker is absent. Run as root (it chowns files to each user):
#
#   sudo scripts/contexts/ensure-claude-blocks.sh "$USER" agent-work agent-untrusted ...
#
# Called by setup.sh; safe to run on its own.
set -euo pipefail

log()  { printf '  \033[32m•\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }

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

# Public/private origins for the sharing block. Taken from the admin user's
# terminal-server drop-ins when not given in the environment.
admin_dropins="$(getent passwd "${1:-}" | cut -d: -f6)/.config/systemd/user/terminal-server.service.d"
SHARE_ORIGIN="${SHARE_ORIGIN:-$(cat "$admin_dropins"/*.conf 2>/dev/null | sed -n 's/^Environment=TERMINAL_SHARE_ORIGIN=//p' | tail -1)}"
SHARE_ORIGIN="${SHARE_ORIGIN:-https://share.example.com}"
TERMINAL_ORIGIN="${TERMINAL_ORIGIN:-$(cat "$admin_dropins"/*.conf 2>/dev/null | sed -n 's/^Environment=VAPID_CONTACT=\(https:[^ ]*\).*/\1/p' | tail -1)}"
TERMINAL_ORIGIN="${TERMINAL_ORIGIN:-https://terminal.example.com}"

SHARE_BEGIN='<!-- BEGIN: terminal-share (managed by scripts/contexts/ensure-claude-blocks.sh) -->'
SHARE_END='<!-- END: terminal-share -->'
SHARE_BODY="$SHARE_BEGIN
## Sharing a local port publicly

\`tm-share\` (\`/usr/local/bin/tm-share\`) exposes a localhost port at a public
URL ($SHARE_ORIGIN/lp/<port>/) with no login, for a limited time
(default 60 min, max 24 h). Use it only when the user asks for a link that
works from another device or that they can send to someone.

- From the admin account it shares immediately. From any other account it
  files a *request* that the user approves in the Terminal UI (\"Ports &
  shares\" on the sessions screen); they get a push notification.
- Always pass a label so the user knows what they are approving, and ask for
  the shortest duration that fits. Start the server first, then request.

\`\`\`bash
tm-share 5173 --label \"docs preview\" --minutes 60 --wait   # waits for approval, prints the URL
tm-share status 5173                                          # pending / approved (+URL) / denied
tm-share off 5173                                             # cancel a request (admin: stop the share)
tm-share name 5173 \"docs preview\"                           # label the port in the panel
tm-share ls                                                   # active public shares
\`\`\`

Never share a port the user did not ask to expose, and tell them the URL and
when it expires. The private, login-protected equivalent of any local port is
$TERMINAL_ORIGIN/lp/<port>/ — mention that when a public link is not
actually needed.
$SHARE_END"

ensure_block_for_user() {
  local u="$1" begin="$2" body="$3" what="$4"
  local home
  home="$(getent passwd "$u" | cut -d: -f6)"
  if [[ -z "$home" || ! -d "$home" ]]; then
    warn "no home dir for $u; skipping CLAUDE.md $what block"
    return
  fi
  local cdir="$home/.claude" cfile="$home/.claude/CLAUDE.md"
  [[ -d "$cdir" ]] || install -d -o "$u" -g "$u" -m 0750 "$cdir"
  if [[ -f "$cfile" ]] && grep -qF "$begin" "$cfile"; then
    log "CLAUDE.md for $u already has $what block"
    return
  fi
  if [[ -s "$cfile" ]]; then
    { printf '\n\n'; printf '%s\n' "$body"; } >> "$cfile"
  else
    printf '%s\n' "$body" > "$cfile"
  fi
  chown "$u":"$u" "$cfile"
  chmod 0640 "$cfile"
  log "wrote $what block to $cfile"
}

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <user> [user...]" >&2
  exit 2
fi
for u in "$@"; do
  ensure_block_for_user "$u" "$NOTIF_BEGIN" "$NOTIF_BODY" notifications
  ensure_block_for_user "$u" "$SHARE_BEGIN" "$SHARE_BODY" sharing
done
