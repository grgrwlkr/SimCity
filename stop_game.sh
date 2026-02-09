#!/usr/bin/env bash
set -euo pipefail

# Stop any running SimCity instance (binary and its cargo parent).

find_pids() {
  pgrep -f "target/debug/simcity" || true
}

kill_pids() {
  local pids="$1"
  if [ -z "$pids" ]; then
    return 0
  fi
  echo "Stopping SimCity PID(s): $pids"
  kill $pids || true
}

wait_for_exit() {
  local attempts=20
  local delay=0.2
  for _ in $(seq 1 "$attempts"); do
    if ! pgrep -f "target/debug/simcity" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

main() {
  local pids
  pids="$(find_pids)"
  if [ -z "$pids" ]; then
    echo "SimCity is not running."
    exit 0
  fi

  kill_pids "$pids"

  if wait_for_exit; then
    echo "SimCity stopped."
    exit 0
  fi

  echo "Graceful stop failed, forcing kill."
  pids="$(find_pids)"
  if [ -n "$pids" ]; then
    kill -9 $pids || true
  fi

  # Also kill any lingering cargo run parent for simcity.
  pids="$(pgrep -f "cargo run.*simcity" || true)"
  if [ -n "$pids" ]; then
    kill -9 $pids || true
  fi

  echo "Force stop complete."
}

main "$@"
