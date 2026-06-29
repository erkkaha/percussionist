#!/bin/sh
# opencode-tmux.sh — start the opencode TUI inside a detached tmux session.
#
# The TUI starts the same HTTP API server as `opencode web` / `opencode serve`
# on 0.0.0.0:$OPENCODE_PORT, so the dispatcher sidecar and web dashboard can
# talk to it exactly as before. Running inside tmux means:
#
#   - `kubectl exec -it pod/<pod> -c opencode -- tmux attach -t opencode`
#     drops you into the live TUI (this is what `beatctl attach` does).
#   - The web dashboard's Terminal tab connects via a WebSocket-bridged
#     k8s exec to the same tmux session (pair programming with CLI).
#   - Disconnecting (WS close, terminal close) does NOT kill the TUI —
#     the tmux session persists. Reconnecting resumes with full scrollback.
#
# The `while` loop blocks until the tmux session ends (opencode exits),
# keeping tini's PID 1 alive for the pod's lifetime.
set -eu

PORT="${OPENCODE_PORT:-4096}"

tmux new-session -d -s opencode "opencode --hostname 0.0.0.0 --port ${PORT}"

while tmux has-session -t opencode 2>/dev/null; do
  sleep 2
done
