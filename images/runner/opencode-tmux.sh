#!/bin/sh
# opencode-tmux.sh — start the opencode server.
#
# The opencode HTTP API is available on 0.0.0.0:$OPENCODE_PORT.
# The dispatcher sidecar and web dashboard talk to it via this API.
#
# Interactive attach is a shell (via `beatctl attach` or the web
# dashboard's Terminal tab). From the shell, run:
#
#   opencode attach http://127.0.0.1:$PORT
#
# to open the opencode TUI.
set -eu

PORT="${OPENCODE_PORT:-4096}"

exec opencode web --hostname 0.0.0.0 --port "${PORT}"
