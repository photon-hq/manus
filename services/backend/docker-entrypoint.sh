#!/bin/sh
set -e

echo "Running database migrations..."
cd /app/packages/database

# Check if database is empty or has failed migrations
MIGRATION_STATUS=$(npx prisma migrate status 2>&1 || true)

if echo "$MIGRATION_STATUS" | grep -q "failed"; then
  echo "⚠️  Failed migrations detected. Resetting database..."
  
  # Drop all tables and reset migration history
  echo "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO postgres; GRANT ALL ON SCHEMA public TO public;" | \
    PGPASSWORD="${DB_PASSWORD:-postgres}" psql -h postgres -U postgres -d manus_imessage || true
  
  echo "✅ Database reset complete. Running migrations..."
fi

# Run migrations
npx prisma migrate deploy

echo "✅ Database migrations complete"
echo "Starting backend service..."
cd /app/services/backend
exec node dist/index.js
