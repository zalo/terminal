# VNC Server Setup

This document describes how to set up a VNC server using noVNC and wayvnc for the Mobile Terminal application.

## Overview

The VNC feature allows you to access your server's actual desktop (Wayland compositor) through the browser via the VNC tab in the terminal application.

## Architecture

```
Browser (noVNC.js)
    |
    | WebSocket (WSS)
    v
Cloudflare Tunnel (vnc.selst.uk)
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

- Wayland compositor (tested with labwc)
- wayvnc (VNC server for wlroots-based Wayland compositors)
- noVNC and websockify
- Node.js (for the noVNC proxy)

## Installation

Run the automated setup script:

```bash
./setup-vnc.sh
```

Or manually install components as described below.

## Manual Installation

### 1. Install Dependencies

```bash
# Install wayvnc (for Wayland) and novnc
sudo apt install wayvnc novnc

# Install Node.js WebSocket library (if not present)
sudo npm install -g ws
```

### 2. Create noVNC Proxy

Create `/tmp/novnc-server.js`:

```javascript
#!/usr/bin/env node
// Combined noVNC HTTP + WebSocket-to-TCP proxy server
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const net = require('net');
const WebSocket = require('ws');

const NOVNC_DIR = '/usr/share/novnc';
const VNC_HOST = 'localhost';
const VNC_PORT = 5900;
const PORT = 6901;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

function serveStatic(req, res) {
  let filePath = path.join(NOVNC_DIR, req.url.pathname === '/' ? '/vnc.html' : req.url.pathname);
  if (!filePath.startsWith(NOVNC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found: ' + req.url.pathname);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  req.url = parsed;
  serveStatic(req, res);
});

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
  console.log('WebSocket connection opened');
  const vnc = net.createConnection(VNC_PORT, VNC_HOST);
  
  ws.on('message', (data) => {
    if (vnc.writable) vnc.write(data);
  });
  ws.on('close', () => { vnc.end(); });
  ws.on('error', () => vnc.end());
  
  vnc.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
  vnc.on('close', () => ws.close());
  vnc.on('error', (e) => { console.log('VNC error:', e.message); ws.close(); });
});

server.on('upgrade', (req, socket, head) => {
  const pathname = url.parse(req.url).pathname;
  // Handle multiple WebSocket paths: /, /proxy, /websockify
  if (pathname === '/' || pathname === '/proxy' || pathname === '/websockify') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`noVNC server listening on ${PORT} (HTTP + WebSocket proxy)`);
});
```

### 3. Configure noVNC Defaults

Create `/usr/share/novnc/mandatory.json`:

```json
{
  "host": "vnc.yourdomain.com",
  "port": 443,
  "encrypt": true,
  "autoconnect": true
}
```

### 4. Create Startup Script

Create `/tmp/start-vnc-novnc.sh`:

```bash
#!/bin/bash
export WAYLAND_DISPLAY=wayland-0
export XDG_RUNTIME_DIR=/run/user/1000

pkill -f "wayvnc" 2>/dev/null || true
pkill -f "node.*novnc-server" 2>/dev/null || true
sleep 1

wayvnc 127.0.0.1 5900 &
node /tmp/novnc-server.js &

echo "VNC stack started"
```

### 5. Create Systemd Service

Create `/etc/systemd/system/vnc-novnc.service`:

```ini
[Unit]
Description=noVNC Web Terminal Bridge
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash /tmp/start-vnc-novnc.sh
ExecStop=/bin/bash -c 'pkill -f "wayvnc"; pkill -f "node.*novnc-server"'
User=YOUR_USERNAME
WorkingDirectory=/tmp

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable vnc-novnc
sudo systemctl start vnc-novnc
```

## Cloudflare Tunnel Setup

### 1. Create Tunnel Credentials

```bash
cloudflared tunnel create vnc-tunnel
cloudflared tunnel route dns vnc-tunnel vnc.yourdomain.com
```

### 2. Create Tunnel Config

Create `/etc/cloudflared/vnc-tunnel.yml`:

```yaml
tunnel: YOUR-TUNNEL-ID
credentials-file: /home/YOUR_USER/.cloudflared/YOUR-TUNNEL-ID.json

ingress:
  - hostname: vnc.yourdomain.com
    service: http://localhost:6901
  - service: http_status:404
```

### 3. Create Systemd Service

Create `/etc/systemd/system/cloudflared-vnc.service`:

```ini
[Unit]
Description=cloudflared VNC Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/local/bin/cloudflared --no-autoupdate --config /etc/cloudflared/vnc-tunnel.yml tunnel run
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable cloudflared-vnc
sudo systemctl start cloudflared-vnc
```

## Terminal Server Integration

To enable the VNC tab in the terminal application, set the `VNC_URL` environment variable:

```bash
# In /etc/systemd/system/terminal-server.service, add:
Environment=VNC_URL=https://vnc.yourdomain.com
```

Then restart the terminal server:

```bash
sudo systemctl restart terminal-server
```

## Troubleshooting

### Black Screen in noVNC

If you see a black screen, ensure:

1. wayvnc is running on the correct Wayland socket:
   ```bash
   ps aux | grep wayvnc
   ls -la /run/user/1000/wayland-*
   ```

2. The Wayland compositor is running:
   ```bash
   ps aux | grep labwc  # or your compositor
   ```

### Connection Refused

1. Check wayvnc is listening:
   ```bash
   ss -tlnp | grep 5900
   ```

2. Check noVNC proxy:
   ```bash
   ss -tlnp | grep 6901
   curl http://localhost:6901/
   ```

### WebSocket Connection Issues

1. Test direct WebSocket:
   ```bash
   node -e "
   const WebSocket = require('ws');
   const ws = new WebSocket('ws://localhost:6901/websockify');
   ws.on('open', () => { console.log('OK'); ws.close(); });
   ws.on('error', (e) => console.log('Error:', e.message));
   "
   ```

2. Test through Cloudflare tunnel:
   ```bash
   node -e "
   const WebSocket = require('ws');
   const ws = new WebSocket('wss://vnc.yourdomain.com/websockify');
   ws.on('open', () => { console.log('OK'); ws.close(); });
   ws.on('error', (e) => console.log('Error:', e.message));
   "
   ```

## Security Considerations

- wayvnc binds to `127.0.0.1:5900` (localhost only)
- noVNC proxy binds to `0.0.0.0:6901` but should only be accessed through Cloudflare Tunnel
- The VNC password is not set by default - consider adding authentication
- Cloudflare Tunnel provides encryption and access control
