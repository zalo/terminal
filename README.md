# Mobile Terminal

A mobile-first web terminal application with tmux-backed session persistence. Built for running CLI tools remotely from your phone.

## Features

- **Terminal**: Full terminal emulation via xterm.js with WebSocket backend
- **Session Persistence**: tmux sessions survive disconnects - reconnect anytime
- **Multi-Session**: Create and switch between named sessions
- **File Browser**: Browse and view files (read-only) with syntax highlighting
- **Mobile Controls**: Touch-friendly control bar with modifier keys (Ctrl, Alt, Shift), arrows, Tab, Esc, and Paste
- **Agent metadata**: Claude Code hooks publish per-session status / task summary / cwd / preview URL back to the UI
- **Dark Mode**: Polished dark theme optimized for mobile

## Architecture

```
Browser (React + xterm.js)
    |
    | WebSocket + REST API
    v
Node.js Server (Express + node-pty)
    |
    v
tmux sessions
```

## Prerequisites

- Node.js 18+
- tmux
- Python 3 (for the Claude Code metadata hook)
- systemd user session (for the production service) — optional

## Quick Install

For a new machine, `install.sh` handles everything — npm install, build,
Claude Code hook wiring, and systemd user service.

```bash
git clone https://github.com/zalo/terminal.git
cd terminal
./install.sh
```

What it does:

1. Installs npm deps for both `server/` and `frontend/` and builds both.
2. Creates `.env` from `.env.example` on first run (edit to customize).
3. Copies `scripts/hooks/terminal-meta.py` → `~/.claude/hooks/` and
   `scripts/bin/tm-meta` → `~/.claude/bin/`, and merges hook entries into
   `~/.claude/settings.json` idempotently.
4. Renders `scripts/terminal-server.service.template` with this repo's path and
   your `node` binary, installs it to `~/.config/systemd/user/`, and starts it.

Useful flags:

```bash
./install.sh --dev         # deps + hooks only, no build, no service
./install.sh --no-service  # skip systemd install (just hooks + build)
./install.sh --no-hooks    # skip Claude Code integration
./install.sh --no-start    # install service but don't enable/start it
```

Overrides (env):

```bash
PORT=3001 TMUX_SOCKET=/tmp/my-sock ./install.sh
```

## Manual Installation

If you'd rather not run `install.sh`:

```bash
# Clone the repo
git clone https://github.com/zalo/terminal.git
cd terminal

# Install dependencies
cd server && npm install && cd ..
cd frontend && npm install && cd ..

# Build for production
cd server && npm run build && cd ..
cd frontend && npm run build && cd ..
```

## Development

Run both frontend and backend with hot reload:

```bash
chmod +x dev.sh
./dev.sh
```

This starts:
- Backend server on port 3002 (with tsx watch)
- Frontend dev server on port 3000 (proxies API to 3002)

Or run them separately:

```bash
# Terminal 1 - Server
cd server
PORT=3002 npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev -- --host 0.0.0.0 --port 3000
```

## Production Deployment

### Manual Start

```bash
# Build first (see Installation)

# Start the server
cd server
PORT=3000 npm start
```

The server serves both the API and the built frontend from `frontend/dist`.

### Systemd Service (User Mode)

The service runs as a **user-level systemd service** (no sudo needed for management).
`install.sh` renders and installs it automatically; the template lives at
[`scripts/terminal-server.service.template`](scripts/terminal-server.service.template).

```bash
# Service config lives at:
# ~/.config/systemd/user/terminal-server.service

# Manage the service (no sudo needed)
systemctl --user start terminal-server
systemctl --user stop terminal-server
systemctl --user restart terminal-server
systemctl --user status terminal-server

# View logs
journalctl --user -u terminal-server -f

# After editing the service file
systemctl --user daemon-reload
```

Key service features:
- `KillMode=process` - only kills Node on restart, tmux sessions survive
- `ExecStartPre` - ensures tmux server is running before Node starts
- Shared tmux socket at `/tmp/orchestrator-tmux.sock` (configurable via `TMUX_SOCKET`)

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `NODE_ENV` | development | Environment mode |
| `WORKSPACE_ROOT` | `$HOME/Desktop` | Default directory shown in the file browser |
| `TMUX_USER` | current user | User that owns tmux sessions |
| `TMUX_SOCKET` | `/tmp/orchestrator-tmux.sock` | Shared tmux socket path |
| `MAX_FILE_SIZE` | `6291456` (6MB) | Max size the file viewer will load |
| `CLAUDE_META_DIR` | `/tmp/claude-terminal-meta` | Where the Claude hook writes per-session metadata |
| `VITE_ALLOWED_HOSTS` | — | Comma-separated extra hosts Vite accepts in dev (e.g. a tunnel domain) |

Copy `.env.example` to `.env` for a template you can edit.

### Running as Non-Root User (Recommended)

For security, terminal sessions can run as a dedicated user with sudo access:

```bash
# Create terminal user
sudo useradd -m -s /bin/bash terminal

# Grant passwordless sudo
echo "terminal ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/terminal
sudo chmod 440 /etc/sudoers.d/terminal

# Grant workspace access (adjust path as needed)
sudo setfacl -R -m u:terminal:rwx /path/to/workspace
sudo setfacl -R -d -m u:terminal:rwx /path/to/workspace
```

## Usage

1. Open `http://localhost:3000` (or your deployed URL)
2. Create a new session or select an existing one
3. Use the terminal as normal
4. Switch to Files tab to browse and view files
5. Sessions persist - close the browser and reconnect anytime

### Mobile Controls

The control bar at the top provides touch-friendly keys:

- **Ctrl / Alt / Shift**: Toggle modifiers, auto-release after chord
- **Tab / Esc**: Send immediately
- **Arrow keys**: Navigation
- **Paste**: Paste from clipboard

Example: To send `Ctrl+C`, tap Ctrl (highlights), then tap C in the terminal.

## Agent Metadata (Claude Code integration)

Each tmux session shown in the UI can be enriched with live metadata from the
Claude Code session running inside it: a status badge (working / waiting /
finished), a one-line task summary, the current working directory, and an
optional dev-server preview URL. When a preview URL is registered a **Preview**
tab appears next to Terminal and Files and iframes the URL.

The plumbing:

- [`scripts/hooks/terminal-meta.py`](scripts/hooks/terminal-meta.py) — Claude
  Code hook that fires on `UserPromptSubmit` / `Stop` / `SessionStart` /
  `SessionEnd` and writes `$CLAUDE_META_DIR/<tmux-session>.json`. Installed to
  `~/.claude/hooks/`.
- [`scripts/bin/tm-meta`](scripts/bin/tm-meta) — CLI for agents to register the
  preview URL (or any field the hook doesn't derive). Installed to
  `~/.claude/bin/`; add that dir to your `PATH`.
- Server reads the JSON files and merges them into `GET /api/sessions` plus
  `GET /api/sessions/:name/meta` (polled by the frontend every ~2s).

Agent usage:

```sh
tm-meta preview http://localhost:5173    # after `npm run dev`
tm-meta clear preview_url                # when the server stops
tm-meta get                              # dump current metadata
```

The global `~/.claude/CLAUDE.md` installed by `install.sh` reminds agents to
call `tm-meta preview` whenever they launch a dev server.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List active tmux sessions (with agent metadata when present) |
| POST | `/api/sessions` | Create new session |
| DELETE | `/api/sessions/:id` | Delete session |
| GET | `/api/sessions/:name/meta` | Current Claude Code metadata for one session |
| GET | `/api/files?path=...` | List directory contents |
| GET | `/api/files/content?path=...` | Get file content |
| WS | `/ws/terminal?session=...` | Terminal WebSocket |

## Tech Stack

- **Frontend**: React, TypeScript, Vite, Tailwind CSS, xterm.js
- **Backend**: Node.js, Express, node-pty, WebSocket
- **Session Management**: tmux

## License

MIT

## Canvas homepage (voice-controlled)

An alternate homepage at `/canvas` (switchable via the Sessions/Canvas tabs; choice remembered per device). Every live tmux session appears as a live tile on a pannable/zoomable canvas:

- **Live tiles** stream `tmux capture-pane` snapshots over `/ws/canvas` — no PTY attach, so tiles never resize the real window. Double-click or the expand button opens a real attached terminal overlay.
- **Callsigns**: each session gets a persistent friendly name (e.g. `casper`) for concise voice addressing, stored in `config/canvas-layout.json` along with tile/preview layout and theme (all server-persisted and multiplayer-synced).
- **Previews**: sessions with a `tm-meta preview` URL can open an iframe tile next to their terminal.
- **Multiplayer**: cursors, layout edits, theme changes, and voice activity broadcast to all connected clients.
- **Voice**: requires `GROK_API_KEY` in the repo `.env`. The browser connects directly to xAI's realtime API (`grok-voice-latest`) with an ephemeral token minted by `POST /api/voice/token`. The agent can read any session (`tmux capture-pane`, secret-redacted before leaving the machine — see `server/src/redact.ts`), type into sessions, create/kill sessions, move the camera, arrange tiles, open previews, change theme/background, and goes to sleep on request.

Extra endpoints: `GET /api/canvas/layout`, `GET /api/sessions/:name/screen?lines=N` (redacted unless `raw=1`), `POST /api/sessions/:name/keys` (`{text, keys[], enter}`), `POST /api/voice/token`, `WS /ws/canvas`.
