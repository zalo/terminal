# Mobile Terminal

A mobile-first web terminal application with tmux-backed session persistence. Built for running CLI tools remotely from your phone.

## Features

- **Terminal**: Full terminal emulation via xterm.js with WebSocket backend
- **Session Persistence**: tmux sessions survive disconnects - reconnect anytime
- **Multi-Session**: Create and switch between named sessions
- **File Browser**: Browse and view files (read-only) with syntax highlighting
- **VNC Desktop**: Browser-based remote desktop access to the server's Wayland/X11 session
- **Mobile Controls**: Touch-friendly control bar with modifier keys (Ctrl, Alt, Shift), arrows, Tab, Esc, and Paste
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

### VNC Desktop Architecture

```
Browser (noVNC)
    |
    | WebSocket (WSS)
    v
Cloudflare Tunnel (vnc.example.com)
    |
    v
noVNC Proxy (port 6901)
    |
    | TCP
    v
wayvnc (port 5900)
    |
    v
Wayland Compositor (labwc) + Xwayland
```

## Prerequisites

- Node.js 18+
- tmux
- wayvnc (for VNC desktop feature)
- novnc (for VNC web interface)
- A dedicated user for running terminal sessions (optional but recommended)

## Installation

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
- Shared tmux socket at `/tmp/orchestrator-tmux.sock`

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `NODE_ENV` | development | Environment mode |

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

### VNC Desktop Setup

The VNC tab provides browser-based access to the server's actual desktop. See [VNC.md](VNC.md) for detailed setup instructions.

**Quick setup:**
```bash
# Run the automated setup script (requires root)
sudo ./setup-vnc.sh

# Configure VNC URL in terminal server
# Add to /etc/systemd/system/terminal-server.service:
Environment=VNC_URL=https://vnc.yourdomain.com

# Restart terminal server
sudo systemctl restart terminal-server
```

**Requirements:**
- Wayland compositor (tested with labwc)
- wayvnc package
- Cloudflare Tunnel (or similar) for HTTPS/WebSocket routing

## Usage

1. Open `http://localhost:3000` (or your deployed URL)
2. Create a new session or select an existing one
3. Use the terminal as normal
4. Switch to Files tab to browse and view files
5. Switch to VNC tab to access the server's desktop remotely
6. Sessions persist - close the browser and reconnect anytime

### Mobile Controls

The control bar at the top provides touch-friendly keys:

- **Ctrl / Alt / Shift**: Toggle modifiers, auto-release after chord
- **Tab / Esc**: Send immediately
- **Arrow keys**: Navigation
- **Paste**: Paste from clipboard

Example: To send `Ctrl+C`, tap Ctrl (highlights), then tap C in the terminal.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List active tmux sessions |
| POST | `/api/sessions` | Create new session |
| DELETE | `/api/sessions/:id` | Delete session |
| GET | `/api/files?path=...` | List directory contents |
| GET | `/api/files/content?path=...` | Get file content |
| WS | `/ws/terminal?session=...` | Terminal WebSocket |

## Tech Stack

- **Frontend**: React, TypeScript, Vite, Tailwind CSS, xterm.js
- **Backend**: Node.js, Express, node-pty, WebSocket
- **Session Management**: tmux

## License

MIT
