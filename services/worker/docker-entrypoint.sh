#!/bin/sh
set -e

echo "Waiting for database to be ready..."
cd /app/packages/database

# Wait for database to be accessible and migrations to complete
MAX_RETRIES=60
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  # Check if _prisma_migrations table exists and schema is up to date
  MIGRATION_CHECK=$(npx prisma migrate status 2>&1 || echo "not_ready")
  
  if echo "$MIGRATION_CHECK" | grep -q "Database schema is up to date"; then
    echo "✅ Database is ready and migrations are complete"
    break
  elif echo "$MIGRATION_CHECK" | grep -q "does not exist"; then
    # Database not initialized yet, keep waiting
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "⏳ Waiting for database initialization... (attempt $RETRY_COUNT/$MAX_RETRIES)"
    sleep 3
  else
    # Other status, keep waiting
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "⏳ Waiting for database migrations to complete... (attempt $RETRY_COUNT/$MAX_RETRIES)"
    sleep 3
  fi
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "⚠️  Database migrations not complete after $MAX_RETRIES attempts, starting anyway..."
fi

echo "Starting worker service..."
cd /app/services/worker
exec node dist/index.js
