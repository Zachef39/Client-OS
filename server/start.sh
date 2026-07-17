#!/bin/bash
# Self-healing launcher for Client OS server.
# Handles: stale port, native module ABI mismatch, missing deps.
# Called by launchd (com.faerber.clientos.plist).

set -u
cd "$(dirname "$0")"

NODE=/usr/local/bin/node
NPM=/usr/local/bin/npm
PORT=3737
LOG=/Users/zachef/Library/Logs/faerber-client-os.log

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# 1. Free port if stale process holding it
PID_ON_PORT=$(/usr/sbin/lsof -ti :$PORT 2>/dev/null | head -1)
if [ -n "$PID_ON_PORT" ]; then
  log "freeing port $PORT (killing PID $PID_ON_PORT)"
  kill -9 "$PID_ON_PORT" 2>/dev/null
  sleep 1
fi

# 2. Ensure deps installed
if [ ! -d node_modules ] || [ ! -d node_modules/express ]; then
  log "installing missing node_modules"
  "$NPM" install >> "$LOG" 2>&1
fi

# 3. Try start. If we crash within 10 sec, rebuild native modules and retry.
attempt=0
while [ $attempt -lt 3 ]; do
  attempt=$((attempt + 1))
  log "start attempt $attempt"
  "$NODE" server.js &
  NODE_PID=$!
  sleep 8
  if kill -0 $NODE_PID 2>/dev/null && /usr/sbin/lsof -i :$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    log "server healthy on port $PORT (PID $NODE_PID) — handing off to foreground"
    # Foreground wait so launchd KeepAlive sees the process
    wait $NODE_PID
    log "server exited (code $?) — launchd will restart"
    exit 0
  fi
  log "server failed to bind within 8s on attempt $attempt"
  kill -9 $NODE_PID 2>/dev/null
  if [ $attempt -eq 1 ]; then
    log "running npm rebuild (likely Node ABI mismatch)"
    "$NPM" rebuild >> "$LOG" 2>&1
  elif [ $attempt -eq 2 ]; then
    log "running npm install --force"
    "$NPM" install --force >> "$LOG" 2>&1
  fi
done

log "ERROR: server failed to start after 3 attempts"
exit 1
