# Mobile Terminal - Local Development Notes

## Repository Setup

This is a fork of [zalo/terminal](https://github.com/zalo/terminal).

**Remotes:**
- `origin` → `https://github.com/zaloh/terminal.git` (this fork)
- `upstream` → `https://github.com/zalo/terminal.git` (original)

**To pull updates from original:**
```bash
git pull upstream main
```

## Installation

- Location: `/opt/terminal`
- Runtime: Node.js 22, tmux
- Service port: 3000

## Systemd Service

The service runs as root and starts at boot (before login) via multi-user.target.

**Service file:** `/etc/systemd/system/terminal-server.service`

**Commands:**
```bash
sudo systemctl status terminal-server.service  # check status
sudo systemctl restart terminal-server.service  # restart after changes
sudo systemctl disable terminal-server.service  # disable auto-start
```

## Building After Updates

```bash
cd /opt/terminal/server && npm run build
cd /opt/terminal/frontend && npm run build
sudo systemctl restart terminal-server.service
```

## VNC Server

The VNC tab provides browser-based remote desktop access to the Pi's actual Wayland desktop (labwc).

**Architecture:**
- wayvnc → captures Wayland compositor (port 5900)
- noVNC proxy → WebSocket bridge (port 6901)
- cloudflared tunnel → routes vnc.selst.uk

**Key files:**
- `/tmp/novnc-server.js` - noVNC WebSocket proxy
- `/tmp/start-vnc-novnc.sh` - startup script
- `/etc/systemd/system/vnc-novnc.service` - VNC stack service
- `/etc/systemd/system/cloudflared-vnc.service` - VNC tunnel service

**Commands:**
```bash
sudo systemctl status vnc-novnc           # check VNC status
sudo systemctl restart vnc-novnc           # restart VNC
sudo systemctl status cloudflared-vnc       # check tunnel
journalctl -u vnc-novnc -f                 # view logs
```

**Troubleshooting:**
```bash
# Check wayvnc is running
ps aux | grep wayvnc

# Check ports
ss -tlnp | grep -E '5900|6901'

# Test VNC directly
node -e "const net=require('net'); const c=net.createConnection(5900,'127.0.0.1'); c.on('connect',()=>{console.log('OK');c.destroy()})"

# Test WebSocket through proxy
node -e "const WebSocket=require('/tmp/node_modules/ws'); const ws=new WebSocket('ws://localhost:6901/websockify'); ws.on('open',()=>{console.log('OK');ws.close()}); ws.on('error',e=>console.log('Error:',e.message))"
```

## Cloudflare Tunnel

- **Tunnel**: `selst.uk` (using cloudflared service)
- **URL**: `https://selst.uk/terminal`
- **Ingress config**: `/etc/cloudflared/config.yml`
- **Service**: `cloudflared.service` (systemd)

**Commands:**
```bash
sudo systemctl status cloudflared        # check tunnel status
sudo systemctl restart cloudflared       # restart tunnel
sudo tail -f /var/log/cloudflared.log   # view logs
```

## Cloudflare Zero Trust Access

See [CLOUDFLARE_ACCESS_SETUP.md](./CLOUDFLARE_ACCESS_SETUP.md) for detailed setup instructions.

**Quick setup when you have credentials:**
```bash
export CF_API_TOKEN="***"
export CF_TEAM_NAME="your-team-name"
export GOOGLE_CLIENT_ID="your-google-oauth-client-id"
export GOOGLE_CLIENT_SECRET="your-g...cret"
/opt/terminal/setup-cloudflare-access.sh
```

## Development Mode

```bash
cd /opt/terminal
./dev.sh
```
