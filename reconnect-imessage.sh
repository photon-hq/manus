#!/bin/bash

# Script to reconnect iMessage SDK in production
# Usage: ./reconnect-imessage.sh

echo "🔄 Triggering iMessage SDK reconnection..."
echo ""

# Make the API call
response=$(curl -s -X POST https://manus.photon.codes/admin/reconnect-imessage \
  -H "Content-Type: application/json" \
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
