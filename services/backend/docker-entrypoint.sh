#!/bin/sh
set -e

echo "Running database migrations... (v2)"
cd /app/packages/database

# Check if RESET_DATABASE env var is set to explicitly reset the database
if [ "$RESET_DATABASE" = "true" ]; then
  echo "🔄 RESET_DATABASE=true detected. Resetting database..."
  npx prisma migrate reset --force --skip-seed
  echo "✅ Database reset complete"
elif [ "$RESET_DATABASE" = "force" ]; then
  echo "🔄 RESET_DATABASE=force detected. Force resetting database..."
  npx prisma db push --force-reset --accept-data-loss
  echo "✅ Database force reset complete"
else
  # Check if database is empty or has failed migrations
  MIGRATION_STATUS=$(npx prisma migrate status 2>&1 || true)

  if echo "$MIGRATION_STATUS" | grep -q "failed"; then
    echo "⚠️  Failed migrations detected. Marking all as rolled back..."
    
    # Mark all failed migrations as rolled back
    npx prisma migrate resolve --rolled-back "20260201000000_init" || true
    npx prisma migrate resolve --rolled-back "20260202000000_add_attachments_and_current_task" || true
    
    echo "✅ Failed migrations marked as rolled back"
  fi

  # Run migrations to record them in migration history
  npx prisma migrate deploy || {
    echo "⚠️  Migration deploy failed, using db push as fallback..."
    npx prisma db push --accept-data-loss
  }
fi

echo "✅ Database ready"
echo "Starting backend service..."
cd /app/services/backend
exec node dist/index.js
