# Per-context Linux users for the terminal

This directory contains the setup for running each "context" (work / john /
untrusted / tom) as its own Linux user, so that tokens and credentials in
one context are kernel-enforced-unreachable from another.

The design is laid out in the chat history that led to this folder; the short
version:

- Each context is a Linux user. File ownership + mode bits are the isolation
  boundary — not application-level convention.
- A shared group `terminal-admin` contains the admin user (selstad). Peer
  backends (milestone 2) expose Unix sockets readable only by this group.
- Each agent user's `~/Desktop` **is** their project workspace (clone repos
  straight into it).
- The existing `terminal-server` service running as selstad is **never
  modified** by milestone 1. If you don't like how this lands, run
  `revert.sh` and you're back to where you started.

## Milestones

| # | Contents                                                                | Reversible via              |
|---|-------------------------------------------------------------------------|-----------------------------|
| 1 | sudo user/group/workspace setup                                         | `sudo revert.sh`            |
| 2 | sudoers drop-in + coordinator code + context-aware UI                   | unset `CONTEXTS_CONFIG`, or `sudo revert.sh` |

Both milestones are now in the codebase. Milestone 2 is **opt-in** per server:
absent `CONTEXTS_CONFIG`, the server runs exactly as it did before — single
context, no UI changes, no sudo calls. Activate coordinator mode by pointing
`CONTEXTS_CONFIG` at a valid JSON file.

## Running milestone 1

```bash
# From the repo root:
sudo ./scripts/contexts/setup.sh
```

What happens:

1. Creates group `terminal-admin` if missing.
2. Adds `selstad` (or `$ADMIN_USER`) to that group.
3. Creates users `agent-work`, `agent-john`, `agent-untrusted`, `agent-tom`
   with homes in `/home/`.
4. Sets each home to mode `0710 <user>:terminal-admin` — admin can traverse
   in to reach the peer socket later, other non-root users can't see anything.
5. Creates `~/Desktop/` in each user's home (mode `0750`) as the workspace
   directory for that context.
6. Enables `systemd --user` linger for each agent user.

Overrides via env var if you want a different list:

```bash
sudo ADMIN_USER=selstad \
     CONTEXTS='agent-work agent-john' \
     GROUP=terminal-admin \
     ./scripts/contexts/setup.sh
```

## After running

Open a new shell or run `newgrp terminal-admin` so your current shell picks
up the group membership.

Verify:

```bash
getent group terminal-admin
ls -ld /home/agent-*
sudo loginctl list-users
sudo cat /etc/sudoers.d/terminal-coordinator   # milestone-2 sudoers drop-in
```

You should see the four new agent users, homes owned by `<user>:terminal-admin`
mode `drwx--x---`, linger=true in `loginctl`, and a sudoers drop-in granting
the admin user passwordless sudo to each context.

## Enabling coordinator mode

Already handled by `setup.sh`. Running it:

- copies `config/contexts.example.json` → `config/contexts.json` **only if
  absent** (never clobbers a customized config),
- installs a systemd user drop-in at
  `~/.config/systemd/user/terminal-server.service.d/contexts.conf` pointing
  `CONTEXTS_CONFIG` at the config file **only if that drop-in doesn't
  already exist, or already matches what we'd write**,
- runs `systemctl --user daemon-reload && restart terminal-server` as the
  admin user so the drop-in takes effect immediately.

Re-running `setup.sh` is safe: it skips anything already in place and warns
instead of overwriting if it finds a customized drop-in or config file.

Verify after running:

```bash
curl -s http://localhost:3000/api/contexts
# → {"contexts": [{"name": "admin", ...}, {"name": "work", ...}, ...]}
```

Then open the UI. The "New Session" dialog should show context chips (Admin
/ Work / John / Untrusted / Tom). Create a session in "Work" — inside the
shell, `whoami` should print `agent-work`.

## Disabling coordinator mode (temporary revert)

Fastest — keep the Linux users, just turn coordinator off:

```bash
rm ~/.config/systemd/user/terminal-server.service.d/contexts.conf
systemctl --user daemon-reload && systemctl --user restart terminal-server
```

The server goes back to single-context behavior. `config/contexts.json`
stays on disk (useful if you want to re-enable later).

Full reversal (removes users, group, sudoers, drop-in, reloads service):

```bash
sudo ./scripts/contexts/revert.sh
```

`revert.sh` is gentle by the same rules setup.sh is: it only removes the
drop-in if it has the "Managed by scripts/contexts/setup.sh" marker, never
deletes `config/contexts.json` (it's your customized config), and prompts
before deleting users and homes.

## How the coordinator dispatches to contexts

No long-lived peer backend runs in each user. Instead, the admin's existing
`terminal-server` is both the coordinator and the admin context's backend:

- `/api/sessions` fans out by calling `sudo -u <ctx.user> tmux ...` once per
  context and tagging each row with its context name.
- `POST /api/sessions {name, context}` creates the tmux session via
  `sudo -u <ctx.user>` so the session is owned by that user.
- `/ws/terminal?session=X&context=Y` spawns a PTY running
  `sudo -u <ctx.user> tmux attach-session -t X`, which means every command
  in that shell runs as `<ctx.user>` with its own filesystem view, tokens,
  and environment.

The sudoers drop-in that milestone-2 `setup.sh` installs
(`/etc/sudoers.d/terminal-coordinator`) is the only thing granting this
privilege, and it's scoped to the admin user only — other agent users can
not sudo into each other.

## Reverting

```bash
sudo ./scripts/contexts/revert.sh
```

This will:

1. Stop + disable any `terminal-peer` user services (if milestone 2 ever
   installed them).
2. Disable linger for each agent user.
3. **Prompt** before deleting each user + home. Answer `y` to delete.
4. Remove the admin user from `terminal-admin`.
5. **Prompt** before deleting the `terminal-admin` group.

Pass `ASSUME_YES=1` to skip prompts (not recommended unless you're scripting
a CI teardown).

The existing `terminal-server` systemd user service running as selstad is
not touched by either script.

## Adding a new context later

To add, say, a `agent-sandbox` context:

```bash
sudo CONTEXTS='agent-sandbox' ./scripts/contexts/setup.sh
```

The script is idempotent: re-running it with a different `CONTEXTS` list
adds any missing users without disturbing existing ones. The group/admin
membership steps no-op when already satisfied.

## Threat model notes

What this layer protects against:

- A prompt-injected agent running as `agent-untrusted` **cannot** `read()` a
  file owned by `agent-work` — enforced by the kernel, regardless of what
  the agent decides to do.
- `ptrace` across users is blocked by default YAMA policy, so one agent
  can't attach a debugger to another's processes.

What this layer does NOT protect against:

- An agent misusing credentials it **legitimately has** inside its own
  context. That's why the GitHub token scoping + org-side PAT allowlist
  (see chat history) is a separate, necessary layer.
- A kernel exploit. Same kernel = same blast radius. If that matters, VMs.
- A compromise of selstad's own account. The admin user is the root of the
  whole system; guard it accordingly.
