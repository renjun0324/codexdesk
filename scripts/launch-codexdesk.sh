#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/renjun/文档/FUCK/课题汇总/codexdesk"
export CODEX_HOME="/home/renjun/文档/FUCK/.codex"
export PATH="/home/renjun/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

# GUI launches don't inherit the shell proxy; Codex must reach the OpenAI backend
# through it or it hangs forever. Respect an existing proxy, else default to clash.
CODEX_DESK_PROXY="${CODEX_DESK_PROXY:-http://127.0.0.1:7890}"
export HTTPS_PROXY="${HTTPS_PROXY:-$CODEX_DESK_PROXY}"
export HTTP_PROXY="${HTTP_PROXY:-$CODEX_DESK_PROXY}"
export ALL_PROXY="${ALL_PROXY:-$CODEX_DESK_PROXY}"
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1}"

cd "$APP_DIR"
exec node "$APP_DIR/scripts/start.cjs"
