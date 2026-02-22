#!/bin/sh
set -e

# Check if SLM mode is enabled via DETECTION_MODE environment variable
# This script allows the container to start but exit gracefully if not needed

if [ "$DETECTION_MODE" != "slm" ]; then
  echo "🔧 DETECTION_MODE is not 'slm' (current: ${DETECTION_MODE:-thread})"
  echo "⏭️  SLM classifier not needed - exiting gracefully"
  # Sleep forever to keep container "running" but idle (uses minimal resources)
  # This prevents Docker from restarting it constantly
  exec sleep infinity
fi

echo "🚀 DETECTION_MODE=slm - Starting SLM classifier service..."

# Execute the main application
exec node dist/index.js
