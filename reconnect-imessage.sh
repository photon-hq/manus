#!/bin/bash

# Script to reconnect iMessage SDK in production
# Usage: ./reconnect-imessage.sh

# Admin token (set this in your environment or pass as argument)
ADMIN_TOKEN="${ADMIN_TOKEN:-93b1fed09a8b94fb9e417f52c96178e518431ca986df3da246717bbcd15e75ef}"

if [ -z "$ADMIN_TOKEN" ]; then
  echo "❌ Error: ADMIN_TOKEN not set"
  echo "Usage: ADMIN_TOKEN=your-token ./reconnect-imessage.sh"
  exit 1
fi

echo "🔄 Triggering iMessage SDK reconnection..."
echo ""

# Make the API call with Bearer token
response=$(curl -s -X POST https://manus.photon.codes/admin/reconnect-imessage \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -w "\nHTTP_STATUS:%{http_code}")

# Extract HTTP status
http_status=$(echo "$response" | grep "HTTP_STATUS:" | cut -d: -f2)
body=$(echo "$response" | sed '/HTTP_STATUS:/d')

echo "Response:"
echo "$body" | jq '.' 2>/dev/null || echo "$body"
echo ""

if [ "$http_status" = "200" ]; then
  echo "✅ Reconnection successful!"
  exit 0
else
  echo "❌ Reconnection failed (HTTP $http_status)"
  exit 1
fi
