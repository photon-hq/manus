#!/bin/bash

# Cleanup script - removes all data and resets the system

set -e

echo "🧹 iMessage MCP System - Cleanup"
echo "================================"
echo ""
echo "⚠️  WARNING: This will delete ALL data including:"
echo "   - Docker volumes (database, Redis data)"
echo "   - Node modules"
echo "   - Build artifacts"
echo ""
read -p "Are you sure you want to continue? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Cleanup cancelled."
    exit 0
fi

echo ""
echo "Stopping all services..."
docker-compose down -v

echo "Removing node_modules..."
rm -rf node_modules
rm -rf packages/*/node_modules
rm -rf services/*/node_modules

echo "Removing build artifacts..."
rm -rf packages/*/dist
rm -rf services/*/dist
rm -rf packages/*/.tsbuildinfo
rm -rf services/*/.tsbuildinfo

echo "Removing Prisma generated files..."
rm -rf packages/database/node_modules/.prisma

echo ""
echo "✅ Cleanup complete!"
echo ""
echo "To start fresh, run: pnpm install && docker-compose up -d"
