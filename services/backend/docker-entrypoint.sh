#!/bin/sh
set -e

echo "Running database migrations..."
cd /app/packages/database
npx prisma migrate deploy

echo "Starting backend service..."
cd /app/services/backend
exec node dist/index.js
