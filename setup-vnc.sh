#!/bin/bash
# VNC Setup Script for Mobile Terminal
# This script installs and configures VNC with noVNC and wayvnc

set -e

echo "=== VNC Setup for Mobile Terminal ==="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo $0)"
  exit 1
fi

# Get the user to run services
SERVICE_USER=${SUDO_USER:-$(whoami)}
USER_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)

echo "Installing for user: $SERVICE_USER"
echo "Home directory: $USER_HOME"
echo ""

# Install system dependencies
echo "1. Installing system dependencies..."
apt update
apt install -y wayvnc novnc

# Install Node.js ws module if needed
echo "2. Setting up Node.js WebSocket module..."
if [ ! -d "/tmp/node_modules/ws" ]; then
  cd /tmp
  npm init -y > /dev/null 2>&1
  npm install ws > /dev/null 2>&1
fi

# Create noVNC proxy server
echo "3. Creating noVNC proxy server..."
cat > /tmp/novnc-server.js << 'NOVNC_EOF'
#!/usr/bin/env node
// Combined noVNC HTTP + WebSocket-to-TCP proxy server
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const net = require('net');
const WebSocket = require('/tmp/node_modules/ws');

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
NOVNC_EOF

chmod 644 /tmp/novnc-server.js

# Configure noVNC defaults
echo "4. Configuring noVNC defaults..."
VNC_HOSTNAME="vnc.${DOMAIN:-selst.uk}"
cat > /usr/share/novnc/mandatory.json << EOF
{
  "host": "${VNC_HOSTNAME}",
  "port": 443,
  "encrypt": true,
  "autoconnect": true
}
EOF

# Create startup script
echo "5. Creating startup script..."
cat > /tmp/start-vnc-novnc.sh << 'STARTUP_EOF'
#!/bin/bash
export WAYLAND_DISPLAY=wayland-0
export XDG_RUNTIME_DIR=/run/user/1000

pkill -f "wayvnc" 2>/dev/null || true
pkill -f "node.*novnc-server" 2>/dev/null || true
sleep 1

wayvnc 127.0.0.1 5900 &
node /tmp/novnc-server.js &

echo "VNC stack started on wayland-0"
STARTUP_EOF

chmod +x /tmp/start-vnc-novnc.sh

# Create systemd service
echo "6. Creating systemd service..."
cat > /etc/systemd/system/vnc-novnc.service << EOF
[Unit]
Description=noVNC Web Terminal Bridge
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash /tmp/start-vnc-novnc.sh
ExecStop=/bin/bash -c 'pkill -f "wayvnc"; pkill -f "node.*novnc-server"'
User=${SERVICE_USER}
WorkingDirectory=/tmp

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and enable service
echo "7. Enabling VNC service..."
systemctl daemon-reload
systemctl enable vnc-novnc
systemctl start vnc-novnc

echo ""
echo "=== VNC Stack Installation Complete ==="
echo ""
echo "Services installed:"
echo "  - wayvnc (VNC server for Wayland)"
echo "  - novnc proxy (WebSocket bridge)"
echo ""
echo "Ports:"
echo "  - 5900: wayvnc (VNC server)"
echo "  - 6901: noVNC proxy (HTTP + WebSocket)"
echo ""
echo "Next steps:"
echo "  1. Set up Cloudflare tunnel for VNC (see VNC.md)"
echo "  2. Add VNC_URL to terminal-server.service:"
echo "     Environment=VNC_URL=https://vnc.yourdomain.com"
echo "  3. Restart terminal: sudo systemctl restart terminal-server"
echo ""
echo "Useful commands:"
echo "  systemctl status vnc-novnc    # Check VNC status"
echo "  journalctl -u vnc-novnc -f   # View VNC logs"
