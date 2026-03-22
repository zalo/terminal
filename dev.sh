#!/bin/bash
# Development mode - runs both server and frontend with hot reload

BASE=/home/selstad/Desktop/terminal-workspace/terminal

# Start server on port 3002 with tsx watch
(cd "$BASE/server" && PORT=3002 npm run dev) &
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
