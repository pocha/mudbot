#!/bin/bash

# Mudbot Schedule Execution Script
# Called by cron to execute scheduled WhatsApp messages

USER_DIR="$1"
SCHEDULE_ID="$2"

if [ -z "$USER_DIR" ] || [ -z "$SCHEDULE_ID" ]; then
    echo "Error: Missing required parameters"
    echo "Usage: $0 <user_dir> <schedule_id>"
    exit 1
fi

# Paths
BASE_DIR="/home/nonbios/mudbot"
USERS_DIR="$BASE_DIR/users"
MUDSLIDE="$BASE_DIR/mudslide"
SCHEDULE_DIR="$USERS_DIR/$USER_DIR/schedules/$SCHEDULE_ID"
SCHEDULE_FILE="$SCHEDULE_DIR/schedule.json"
LOG_FILE="$SCHEDULE_DIR/logs.txt"
CREDENTIALS_DIR="$USERS_DIR/$USER_DIR/.mudslide"

# Check if schedule exists
if [ ! -f "$SCHEDULE_FILE" ]; then
    echo "[$(date -Iseconds)] ERROR: Schedule file not found: $SCHEDULE_FILE" >> "$LOG_FILE"
    exit 1
fi

# Check if schedule is enabled
ENABLED=$(jq -r '.enabled' "$SCHEDULE_FILE")
if [ "$ENABLED" != "true" ]; then
    echo "[$(date -Iseconds)] INFO: Schedule is disabled, skipping execution" >> "$LOG_FILE"
    exit 0
fi

# Read schedule data
MESSAGE=$(jq -r '.message' "$SCHEDULE_FILE")
MEDIA=$(jq -r '.media' "$SCHEDULE_FILE")
RECIPIENTS=$(jq -r '.recipients[]' "$SCHEDULE_FILE")

# Log execution start
echo "[$(date -Iseconds)] INFO: Starting scheduled execution for schedule $SCHEDULE_ID" >> "$LOG_FILE"

# Send to each recipient
SUCCESS_COUNT=0
FAILURE_COUNT=0

for RECIPIENT in $RECIPIENTS; do
    echo "[$(date -Iseconds)] INFO: Sending to $RECIPIENT" >> "$LOG_FILE"
    
    if [ "$MEDIA" != "null" ] && [ -n "$MEDIA" ]; then
        # Send with media
        OUTPUT=$("$MUDSLIDE" -c "$CREDENTIALS_DIR" send "$RECIPIENT" --media "$MEDIA" --caption "$MESSAGE" 2>&1)
    else
        # Send text only
        OUTPUT=$("$MUDSLIDE" -c "$CREDENTIALS_DIR" send "$RECIPIENT" "$MESSAGE" 2>&1)
    fi
    
    if [ $? -eq 0 ]; then
        echo "[$(date -Iseconds)] SUCCESS: Message sent to $RECIPIENT" >> "$LOG_FILE"
        ((SUCCESS_COUNT++))
    else
        echo "[$(date -Iseconds)] ERROR: Failed to send to $RECIPIENT - $OUTPUT" >> "$LOG_FILE"
        ((FAILURE_COUNT++))
    fi
done

# Update schedule metadata with last run time
TEMP_FILE=$(mktemp)
jq --arg timestamp "$(date -Iseconds)" '.lastRun = $timestamp' "$SCHEDULE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$SCHEDULE_FILE"

# Log summary
echo "[$(date -Iseconds)] INFO: Execution completed - Success: $SUCCESS_COUNT, Failed: $FAILURE_COUNT" >> "$LOG_FILE"

exit 0
