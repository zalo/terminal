#!/bin/bash
# Development mode - runs both server and frontend with hot reload

BASE="$(cd "$(dirname "$0")" && pwd)"

# Start server on port 3002 with tsx watch. TERMINAL_TCP=1 keeps the backend on
# a TCP port (prod serves the main app on a Unix socket) so Vite can proxy to it.
(cd "$BASE/server" && TERMINAL_TCP=1 PORT=3002 npm run dev) &
SERVER_PID=$!

# Wait for server to start
sleep 3

# Start frontend dev server on port 3000 (proxies to server on 3002)
(cd "$BASE/frontend" && npm run dev -- --host 0.0.0.0 --port 3000) &
FRONTEND_PID=$!

# Handle shutdown
trap "kill $SERVER_PID $FRONTEND_PID 2>/dev/null" EXIT

# Wait for both
wait
