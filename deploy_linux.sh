#!/bin/bash
# Deprecated: merged into deploy.sh (macOS + Linux via uname). Kept as a forwarder.
# Usage: bash deploy.sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/deploy.sh" "$@"
