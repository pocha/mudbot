#!/bin/bash
# Start MailDev in background for email testing
echo "Starting MailDev on port 1080 (web) and 1025 (SMTP)..."
npx maildev --smtp 1025 --web 1080 > /dev/null 2>&1 &
MAILDEV_PID=$!
echo "MailDev started with PID: $MAILDEV_PID"
echo "MailDev Web UI: http://localhost:1080"
echo ""

# Give MailDev a moment to start
sleep 2

# Start the Node.js server
echo "Starting Mudbot server..."
node server.js

# Cleanup on exit
trap "kill $MAILDEV_PID 2>/dev/null" EXIT
