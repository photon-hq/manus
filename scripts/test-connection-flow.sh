#!/bin/bash

# Test script for iMessage MCP connection flow
# This script tests the complete connection setup process

set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
PHONE_NUMBER="+1234567890"
MANUS_API_KEY="manus_sk_test_123456789"

echo "🧪 Testing iMessage MCP Connection Flow"
echo "========================================"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Health Check
echo "1️⃣  Testing health endpoint..."
HEALTH_RESPONSE=$(curl -s "$BASE_URL/health")
if echo "$HEALTH_RESPONSE" | grep -q "ok"; then
    echo -e "${GREEN}✓ Health check passed${NC}"
else
    echo -e "${RED}✗ Health check failed${NC}"
    exit 1
fi
echo ""

# Test 2: Start Connection
echo "2️⃣  Starting connection..."
START_RESPONSE=$(curl -s -X POST "$BASE_URL/api/connect/start" \
    -H "Content-Type: application/json" \
    -d "{\"phoneNumber\": \"$PHONE_NUMBER\"}")

CONNECTION_ID=$(echo "$START_RESPONSE" | grep -o '"connectionId":"[^"]*"' | cut -d'"' -f4)

if [ -z "$CONNECTION_ID" ]; then
    echo -e "${RED}✗ Failed to start connection${NC}"
    echo "Response: $START_RESPONSE"
    exit 1
fi

echo -e "${GREEN}✓ Connection started${NC}"
echo "Connection ID: $CONNECTION_ID"
echo ""

# Test 3: Verify Token (this will fail without valid Manus API, but tests the endpoint)
echo "3️⃣  Testing token verification endpoint..."
TOKEN_RESPONSE=$(curl -s -X POST "$BASE_URL/api/connect/verify" \
    -H "Content-Type: application/json" \
    -d "{\"connectionId\": \"$CONNECTION_ID\", \"manusApiKey\": \"$MANUS_API_KEY\"}")

if echo "$TOKEN_RESPONSE" | grep -q "photonApiKey\|error"; then
    echo -e "${YELLOW}⚠ Token submission endpoint working (may fail with test key)${NC}"
else
    echo -e "${RED}✗ Token submission endpoint not responding${NC}"
fi
echo ""

# Test 4: Test MCP Endpoints (will fail without valid photon key, but tests structure)
echo "4️⃣  Testing MCP endpoints structure..."

# Fetch endpoint
FETCH_RESPONSE=$(curl -s "$BASE_URL/api/mcp/fetch" \
    -H "Authorization: Bearer photon_sk_test_123")

if echo "$FETCH_RESPONSE" | grep -q "error\|messages"; then
    echo -e "${GREEN}✓ MCP fetch endpoint responding${NC}"
else
    echo -e "${RED}✗ MCP fetch endpoint not responding${NC}"
fi

# Send endpoint
SEND_RESPONSE=$(curl -s -X POST "$BASE_URL/api/mcp/send" \
    -H "Authorization: Bearer photon_sk_test_123" \
    -H "Content-Type: application/json" \
    -d '{"message": "Test message"}')

if echo "$SEND_RESPONSE" | grep -q "error\|success"; then
    echo -e "${GREEN}✓ MCP send endpoint responding${NC}"
else
    echo -e "${RED}✗ MCP send endpoint not responding${NC}"
fi
echo ""

# Test 5: Test SLM Classifier
echo "5️⃣  Testing SLM classifier..."
SLM_URL="${SLM_URL:-http://localhost:3001}"

SLM_HEALTH=$(curl -s "$SLM_URL/health")
if echo "$SLM_HEALTH" | grep -q "ok"; then
    echo -e "${GREEN}✓ SLM classifier health check passed${NC}"
else
    echo -e "${RED}✗ SLM classifier not responding${NC}"
fi

# Test classification endpoint
CLASSIFY_RESPONSE=$(curl -s -X POST "$SLM_URL/classify" \
    -H "Content-Type: application/json" \
    -d '{
        "latest_message": "Research AI trends",
        "last_task_context": []
    }')

if echo "$CLASSIFY_RESPONSE" | grep -q "type\|NEW_TASK\|FOLLOW_UP"; then
    echo -e "${GREEN}✓ SLM classification endpoint working${NC}"
    echo "Classification result: $CLASSIFY_RESPONSE"
else
    echo -e "${RED}✗ SLM classification endpoint failed${NC}"
fi
echo ""

# Summary
echo "========================================"
echo -e "${GREEN}✓ Connection flow tests completed!${NC}"
echo ""
echo "Next steps:"
echo "1. Set up your iMessage integration credentials in .env"
echo "2. Get a real Manus API key from https://manus.im"
echo "3. Test the full flow with real credentials"
echo "4. Monitor with SigNoz at http://localhost:3301"
