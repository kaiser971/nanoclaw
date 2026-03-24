#!/usr/bin/env bash
# BOAMP TMA/Education scraper — cron wrapper
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="${SCRIPT_DIR}/data/scraper.log"

cd "$SCRIPT_DIR"

# Load credentials if .env exists
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

/usr/bin/python3 boamp_scraper.py >> "$LOG_FILE" 2>&1
