#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/renjun/文档/FUCK/课题汇总/codexdesk"
export CODEX_HOME="/home/renjun/文档/FUCK/.codex"
export PATH="/home/renjun/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

cd "$APP_DIR"
exec node "$APP_DIR/scripts/start.cjs"
