#!/bin/sh
set -e

echo "Waiting for database to be ready..."
cd /app/packages/database

# Wait for database to be accessible and migrations to complete
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if npx prisma migrate status 2>&1 | grep -q "Database schema is up to date"; then
    echo "✅ Database is ready and migrations are complete"
    break
  fi
  
  RETRY_COUNT=$((RETRY_COUNT + 1))
  echo "⏳ Waiting for database migrations to complete... (attempt $RETRY_COUNT/$MAX_RETRIES)"
  sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "⚠️  Database migrations not complete after $MAX_RETRIES attempts, starting anyway..."
fi

echo "Starting worker service..."
cd /app/services/worker
exec node dist/index.js
