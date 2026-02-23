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
      npx prisma migrate resolve --rolled-back "20260206000000_add_task_started_at" || true
      npx prisma migrate resolve --rolled-back "20260211000000_add_triggering_message_guid" || true
      npx prisma migrate resolve --rolled-back "20260214000000_add_contact_card_shared" || true
      npx prisma migrate resolve --rolled-back "20260216000000_add_thread_originator_guid" || true
      npx prisma migrate resolve --rolled-back "20260223000000_add_free_tier_fields" || true
      
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

# Run one-time deploy operations from deploy-ops.json
DEPLOY_OPS_FILE="/app/services/backend/deploy-ops.json"
DEPLOY_OPS_LOG_TABLE="_deploy_ops_log"

if [ -f "$DEPLOY_OPS_FILE" ]; then
  echo "📋 Checking deploy operations..."

  # Create log table if it doesn't exist
  psql "$DATABASE_URL" -q -c "
    CREATE TABLE IF NOT EXISTS $DEPLOY_OPS_LOG_TABLE (
      id TEXT PRIMARY KEY,
      description TEXT,
      executed_at TIMESTAMPTZ DEFAULT now(),
      rows_affected INT
    );
  " 2>/dev/null || true

  # Parse and run each operation (only if not already executed)
  OPS_COUNT=$(node -e "const ops=require('$DEPLOY_OPS_FILE'); console.log(ops.length)")

  i=0
  while [ "$i" -lt "$OPS_COUNT" ]; do
    OP_ID=$(node -e "const ops=require('$DEPLOY_OPS_FILE'); console.log(ops[$i].id)")
    OP_DESC=$(node -e "const ops=require('$DEPLOY_OPS_FILE'); console.log(ops[$i].description)")
    OP_SQL=$(node -e "const ops=require('$DEPLOY_OPS_FILE'); console.log(ops[$i].sql)")

    # Check if already executed
    ALREADY_RAN=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM $DEPLOY_OPS_LOG_TABLE WHERE id = '$OP_ID';" 2>/dev/null || echo "0")

    if [ "$ALREADY_RAN" = "0" ]; then
      echo "  🔧 Running: $OP_DESC"
      RESULT=$(psql "$DATABASE_URL" -c "$OP_SQL" 2>&1)
      ROWS=$(echo "$RESULT" | grep -o '[0-9]*' | head -1 || echo "0")
      echo "  ✅ Done ($RESULT)"

      # Log it
      psql "$DATABASE_URL" -q -c "INSERT INTO $DEPLOY_OPS_LOG_TABLE (id, description, rows_affected) VALUES ('$OP_ID', '$OP_DESC', ${ROWS:-0});" 2>/dev/null || true
    else
      echo "  ⏭️  Already ran: $OP_DESC"
    fi

    i=$((i + 1))
  done

  echo "✅ Deploy operations complete"
fi

echo "Starting backend service..."
cd /app/services/backend
exec node dist/index.js
