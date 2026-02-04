#!/bin/sh
set -e

echo "Running database migrations..."
cd /app/packages/database

# Check if RESET_DATABASE env var is set to explicitly reset the database
if [ "$RESET_DATABASE" = "true" ]; then
  echo "🔄 RESET_DATABASE=true detected. Resetting database schema..."
  
  # Drop all tables and recreate from scratch (suppress expected errors for fresh databases)
  npx prisma migrate reset --force --skip-seed 2>&1 | grep -v "does not exist" || true
  
  echo "✅ Database reset complete"
else
  # Check if _prisma_migrations table exists
  TABLE_EXISTS=$(npx prisma db execute --stdin <<SQL 2>&1 || echo "not_found"
SELECT EXISTS (
  SELECT FROM information_schema.tables 
  WHERE table_schema = 'public' 
  AND table_name = '_prisma_migrations'
);
SQL
)

  if echo "$TABLE_EXISTS" | grep -q "not_found\|does not exist"; then
    echo "📦 Fresh database detected. Running initial migrations..."
    npx prisma migrate deploy
  else
    # Check migration status
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
fi

echo "✅ Database ready"
echo "Starting backend service..."
cd /app/services/backend
exec node dist/index.js
