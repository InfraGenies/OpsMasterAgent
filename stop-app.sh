#!/usr/bin/env bash
# Stops the server/web processes started by start-app.sh (by PID file,
# killing each process tree), then falls back to freeing ports 4100/5173.

QUIET=false
for arg in "$@"; do
  case "$arg" in
    --quiet|-q) QUIET=true ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.run"

say() {
  if [ "$QUIET" = false ]; then echo "$*"; fi
}

stop_tracked() {
  local name="$1"
  local pidfile="$RUN_DIR/${name}.pid"
  if [ ! -f "$pidfile" ]; then
    say "$name: no pid file, nothing tracked."
    return
  fi
  local pid
  pid="$(head -1 "$pidfile" | tr -d '[:space:]')"
  if kill -0 "$pid" 2>/dev/null; then
    say "Stopping $name (pid $pid and its child processes)..."
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  else
    say "$name: pid $pid not running."
  fi
  rm -f "$pidfile"
}

stop_tracked "server"
stop_tracked "web"

# Fallback: free ports if something is still bound
for port in 4100 5173; do
  pids="$(lsof -ti :"$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    for p in $pids; do
      say "Port $port still in use by pid $p - stopping it too."
      kill "$p" 2>/dev/null || true
    done
  fi
done

say "Stopped."
