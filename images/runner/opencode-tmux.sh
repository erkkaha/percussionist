#!/bin/sh
# opencode-tmux.sh — start the opencode headless server.
#
# Runs `opencode serve` which starts the same HTTP API as `opencode web`
# but without the web UI. The dispatcher sidecar and web dashboard talk
# to it via the HTTP API on 0.0.0.0:$OPENCODE_PORT.
#
# Interactive attach is a shell inside the pod (via `beatctl attach` or
# the web dashboard's Terminal tab). From the shell, run:
#
#   opencode attach http://127.0.0.1:$PORT
#
# to open the opencode TUI.
set -eu

PORT="${OPENCODE_PORT:-4096}"

exec opencode serve --hostname 0.0.0.0 --port "${PORT}"
