#!/data/data/com.termux/files/usr/bin/bash
# Start the Glass Car Dash backend in Termux.
#
#   ~/glass-car-dash/start.sh          # foreground (see logs, ctrl-C to stop)
#   ~/glass-car-dash/start.sh --bg     # background (survives closing Termux)
#   ~/glass-car-dash/start.sh --stop   # kill background instance
set -e
cd "$(dirname "$0")"

PID_FILE="$HOME/.glass-car-dash.pid"

case "${1:-}" in
  --stop)
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null && echo "Stopped." || echo "Not running."
      rm -f "$PID_FILE"
    else
      echo "No PID file found."
    fi
    exit 0
    ;;
  --bg)
    command -v termux-wake-lock &>/dev/null && termux-wake-lock 2>/dev/null || true
    if node --help 2>/dev/null | grep -q -- '--env-file'; then
      nohup node --env-file=.env server.js > "$HOME/glass-car-dash.log" 2>&1 &
    else
      set -a; source .env; set +a
      nohup node server.js > "$HOME/glass-car-dash.log" 2>&1 &
    fi
    echo $! > "$PID_FILE"
    echo "Glass Car Dash backend started in background (PID $(cat "$PID_FILE"))"
    echo "Logs: tail -f ~/glass-car-dash.log"
    echo "Stop:  ~/glass-car-dash/start.sh --stop"
    exit 0
    ;;
esac

echo "Starting Glass Car Dash backend (foreground, ctrl-C to stop)..."
if node --help 2>/dev/null | grep -q -- '--env-file'; then
  exec node --env-file=.env server.js
else
  set -a; source .env; set +a
  exec node server.js
fi
