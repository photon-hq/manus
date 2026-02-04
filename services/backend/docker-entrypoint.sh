#!/bin/sh
set -e

echo "Running database migrations..."
cd /app/packages/database

# Try to run migrations, if it fails due to failed migration, resolve it
if ! npx prisma migrate deploy 2>&1; then
  echo "Migration failed, attempting to resolve..."
  npx prisma migrate resolve --rolled-back "20260202000000_add_attachments_and_current_task" || true
  echo "Retrying migrations..."
  npx prisma migrate deploy
fi

echo "Starting backend service..."
cd /app/services/backend
exec node dist/index.js
