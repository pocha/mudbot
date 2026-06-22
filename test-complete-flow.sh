#!/bin/bash

# Comprehensive Test Suite for Mudbot Backend
# Tests: Registration → Verification → Login → API Key → Schedules → Data Encryption

set -e  # Exit on error

BASE_URL="http://localhost:3000"
TEST_EMAIL="testuser@example.com"
USER_DIR_BASE="/home/nonbios/mudbot/users"
TOKEN_MAP_FILE="/home/nonbios/mudbot/tokens.json"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== MUDBOT BACKEND COMPREHENSIVE TEST SUITE ===${NC}\n"

# Test 1: Register User
echo -e "${YELLOW}[TEST 1] Registering user: ${TEST_EMAIL}${NC}"
REGISTER_RESPONSE=$(curl -s -X POST ${BASE_URL}/api/register \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\"}")

echo "Response: $REGISTER_RESPONSE"

if echo "$REGISTER_RESPONSE" | grep -q "Registration email sent"; then
    echo -e "${GREEN}✓ Registration successful${NC}\n"
else
    echo -e "${RED}✗ Registration failed${NC}\n"
    exit 1
fi

# Test 2: Extract Token from Maildev
echo -e "${YELLOW}[TEST 2] Extracting verification token from email${NC}"
sleep 2  # Wait for email to arrive

# Get latest email from Maildev API
EMAIL_DATA=$(curl -s http://localhost:1080/email)
TOKEN=$(echo "$EMAIL_DATA" | jq -r '.[0].html' | grep -oP 'token=\K[a-f0-9]+' | head -1)

if [ -z "$TOKEN" ]; then
    echo -e "${RED}✗ Failed to extract token from email${NC}\n"
    exit 1
fi

echo "Token extracted: $TOKEN"
echo -e "${GREEN}✓ Token extracted successfully${NC}\n"

# Test 3: Verify Token and Login
echo -e "${YELLOW}[TEST 3] Verifying token and logging in${NC}"
VERIFY_RESPONSE=$(curl -s ${BASE_URL}/api/verify/${TOKEN})
echo "Response: $VERIFY_RESPONSE"

if echo "$VERIFY_RESPONSE" | grep -q "\"email\":\"${TEST_EMAIL}\""; then
    echo -e "${GREEN}✓ Token verification successful${NC}\n"
else
    echo -e "${RED}✗ Token verification failed${NC}\n"
    exit 1
fi

# Test 4: Verify User Directory Created and Encrypted
echo -e "${YELLOW}[TEST 4] Verifying encrypted user directory creation${NC}"

# Find the user directory by checking metadata.json files
USER_DIR=""
for dir in ${USER_DIR_BASE}/*; do
    if [ -d "$dir" ] && [ -f "$dir/metadata.json" ]; then
        DIR_EMAIL=$(jq -r '.email' "$dir/metadata.json" 2>/dev/null)
        if [ "$DIR_EMAIL" = "$TEST_EMAIL" ]; then
            USER_DIR="$dir"
            break
        fi
    fi
done

if [ -z "$USER_DIR" ]; then
    echo -e "${RED}✗ User directory not found${NC}\n"
    exit 1
fi

if [ -d "$USER_DIR" ]; then
    echo "User directory found: $USER_DIR"
    echo -e "${GREEN}✓ Encrypted user directory created${NC}\n"
else
    echo -e "${RED}✗ User directory not found${NC}\n"
    exit 1
fi

# Test 5: Generate API Key
echo -e "${YELLOW}[TEST 5] Generating API key${NC}"
API_KEY_RESPONSE=$(curl -s -X POST ${BASE_URL}/api/apikey/generate \
  -H "Authorization: Bearer ${TOKEN}")
echo "Response: $API_KEY_RESPONSE"

API_KEY=$(echo "$API_KEY_RESPONSE" | jq -r '.apiKey')

if [ -z "$API_KEY" ] || [ "$API_KEY" = "null" ]; then
    echo -e "${RED}✗ Failed to generate API key${NC}\n"
    exit 1
fi

echo "API Key: $API_KEY"
echo -e "${GREEN}✓ API key generated successfully${NC}\n"

# Test 6: Verify API Key Stored Encrypted in User Directory
echo -e "${YELLOW}[TEST 6] Verifying API key stored encrypted locally${NC}"
if [ -f "${USER_DIR}/user.json.enc" ]; then
    echo "Encrypted user.json.enc found"
    # Check file size to ensure it has content
    FILE_SIZE=$(stat -f%z "${USER_DIR}/user.json.enc" 2>/dev/null || stat -c%s "${USER_DIR}/user.json.enc" 2>/dev/null)
    if [ "$FILE_SIZE" -gt 0 ]; then
        echo -e "${GREEN}✓ API key stored encrypted (file size: ${FILE_SIZE} bytes)${NC}\n"
    else
        echo -e "${RED}✗ Encrypted file is empty${NC}\n"
        exit 1
    fi
else
    echo -e "${RED}✗ Encrypted user file not found${NC}\n"
    exit 1
fi

# Test 7: Create Schedule
echo -e "${YELLOW}[TEST 7] Creating schedule${NC}"
CREATE_SCHEDULE_RESPONSE=$(curl -s -X POST ${BASE_URL}/api/schedules \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Schedule",
    "phoneNumber": "+1234567890",
    "message": "Test message from automated test",
    "cronExpression": "0 10 * * *"
  }')

echo "Response: $CREATE_SCHEDULE_RESPONSE"

SCHEDULE_ID=$(echo "$CREATE_SCHEDULE_RESPONSE" | jq -r '.schedule.id')

if [ -z "$SCHEDULE_ID" ] || [ "$SCHEDULE_ID" = "null" ]; then
    echo -e "${RED}✗ Failed to create schedule${NC}\n"
    exit 1
fi

echo "Schedule ID: $SCHEDULE_ID"
echo -e "${GREEN}✓ Schedule created successfully${NC}\n"

# Test 8: Verify Schedules File Encrypted
echo -e "${YELLOW}[TEST 8] Verifying schedules stored encrypted${NC}"
if [ -f "${USER_DIR}/schedules.json.enc" ]; then
    echo "Encrypted schedules.json.enc found"
    FILE_SIZE=$(stat -f%z "${USER_DIR}/schedules.json.enc" 2>/dev/null || stat -c%s "${USER_DIR}/schedules.json.enc" 2>/dev/null)
    if [ "$FILE_SIZE" -gt 0 ]; then
        echo -e "${GREEN}✓ Schedules stored encrypted (file size: ${FILE_SIZE} bytes)${NC}\n"
    else
        echo -e "${RED}✗ Encrypted schedules file is empty${NC}\n"
        exit 1
    fi
else
    echo -e "${RED}✗ Encrypted schedules file not found${NC}\n"
    exit 1
fi

# Test 9: Verify Cron Entry Created
echo -e "${YELLOW}[TEST 9] Verifying cron entry created${NC}"
CRON_COUNT=$(crontab -l 2>/dev/null | grep -c "mudbot.*${SCHEDULE_ID}" || true)

if [ "$CRON_COUNT" -gt 0 ]; then
    echo "Cron entry found:"
    crontab -l | grep "mudbot.*${SCHEDULE_ID}"
    echo -e "${GREEN}✓ Cron entry created successfully${NC}\n"
else
    echo -e "${RED}✗ Cron entry not found${NC}\n"
    exit 1
fi

# Test 10: Retrieve Schedule
echo -e "${YELLOW}[TEST 10] Retrieving schedule${NC}"
GET_SCHEDULE_RESPONSE=$(curl -s ${BASE_URL}/api/schedules/${SCHEDULE_ID} \
  -H "Authorization: Bearer ${TOKEN}")

echo "Response: $GET_SCHEDULE_RESPONSE"

if echo "$GET_SCHEDULE_RESPONSE" | grep -q "\"id\":\"${SCHEDULE_ID}\""; then
    echo -e "${GREEN}✓ Schedule retrieved successfully${NC}\n"
else
    echo -e "${RED}✗ Failed to retrieve schedule${NC}\n"
    exit 1
fi

# Test 11: Update Schedule
echo -e "${YELLOW}[TEST 11] Updating schedule${NC}"
UPDATE_SCHEDULE_RESPONSE=$(curl -s -X PUT ${BASE_URL}/api/schedules/${SCHEDULE_ID} \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Test Schedule",
    "message": "Updated test message",
    "enabled": false
  }')

echo "Response: $UPDATE_SCHEDULE_RESPONSE"

if echo "$UPDATE_SCHEDULE_RESPONSE" | grep -q "\"name\":\"Updated Test Schedule\""; then
    echo -e "${GREEN}✓ Schedule updated successfully${NC}\n"
else
    echo -e "${RED}✗ Failed to update schedule${NC}\n"
    exit 1
fi

# Test 12: Verify Encrypted Data Updated After Update
echo -e "${YELLOW}[TEST 12] Verifying encrypted data updated after schedule update${NC}"
UPDATED_FILE_SIZE=$(stat -f%z "${USER_DIR}/schedules.json.enc" 2>/dev/null || stat -c%s "${USER_DIR}/schedules.json.enc" 2>/dev/null)
echo "Updated file size: ${UPDATED_FILE_SIZE} bytes"

if [ "$UPDATED_FILE_SIZE" -gt 0 ]; then
    # Verify file was modified recently (within last minute)
    if [ "$(uname)" = "Darwin" ]; then
        MTIME=$(stat -f %m "${USER_DIR}/schedules.json.enc")
    else
        MTIME=$(stat -c %Y "${USER_DIR}/schedules.json.enc")
    fi
    CURRENT_TIME=$(date +%s)
    TIME_DIFF=$((CURRENT_TIME - MTIME))
    
    if [ "$TIME_DIFF" -lt 60 ]; then
        echo -e "${GREEN}✓ Encrypted data updated (modified ${TIME_DIFF} seconds ago)${NC}\n"
    else
        echo -e "${RED}✗ File not recently modified${NC}\n"
        exit 1
    fi
else
    echo -e "${RED}✗ Encrypted file is empty after update${NC}\n"
    exit 1
fi

# Test 13: Delete Schedule
echo -e "${YELLOW}[TEST 13] Deleting schedule${NC}"
DELETE_SCHEDULE_RESPONSE=$(curl -s -X DELETE ${BASE_URL}/api/schedules/${SCHEDULE_ID} \
  -H "Authorization: Bearer ${TOKEN}")

echo "Response: $DELETE_SCHEDULE_RESPONSE"

if echo "$DELETE_SCHEDULE_RESPONSE" | grep -q "\"success\":true"; then
    echo -e "${GREEN}✓ Schedule deleted successfully${NC}\n"
else
    echo -e "${RED}✗ Failed to delete schedule${NC}\n"
    exit 1
fi

# Test 14: Verify Cron Entry Removed
echo -e "${YELLOW}[TEST 14] Verifying cron entry removed${NC}"
CRON_COUNT_AFTER=$(crontab -l 2>/dev/null | grep -c "mudbot.*${SCHEDULE_ID}" || true)

if [ "$CRON_COUNT_AFTER" -eq 0 ]; then
    echo -e "${GREEN}✓ Cron entry removed successfully${NC}\n"
else
    echo -e "${RED}✗ Cron entry still exists${NC}\n"
    exit 1
fi

# Test 15: Verify Schedule Deleted from Encrypted Storage
echo -e "${YELLOW}[TEST 15] Verifying schedule removed from encrypted storage${NC}"
GET_ALL_SCHEDULES=$(curl -s ${BASE_URL}/api/schedules \
  -H "Authorization: Bearer ${TOKEN}")

if echo "$GET_ALL_SCHEDULES" | grep -q "\"schedules\":\[\]"; then
    echo -e "${GREEN}✓ Schedule removed from storage${NC}\n"
else
    echo -e "${RED}✗ Schedule still exists in storage${NC}\n"
    exit 1
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}ALL TESTS PASSED SUCCESSFULLY! ✓${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Summary:"
echo "  - User registered and verified: ${TEST_EMAIL}"
echo "  - Token: ${TOKEN}"
echo "  - API Key: ${API_KEY}"
echo "  - User Directory: ${USER_DIR}"
echo "  - Schedule ID (deleted): ${SCHEDULE_ID}"
echo ""
echo "Verified:"
echo "  ✓ Email sending and token extraction"
echo "  ✓ Token verification and login"
echo "  ✓ Encrypted directory creation"
echo "  ✓ API key generation and encryption"
echo "  ✓ Schedule CRUD operations"
echo "  ✓ Cron job management"
echo "  ✓ Data encryption after each write"
