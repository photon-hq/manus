#!/bin/bash

# Quick start script for iMessage MCP system
# This script sets up and starts all services

set -e

echo "🚀 iMessage MCP System - Quick Start"
echo "===================================="
echo ""

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js >= 20.0.0"
    exit 1
fi

if ! command -v pnpm &> /dev/null; then
    echo "❌ pnpm is not installed. Installing pnpm..."
    npm install -g pnpm
fi

if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

echo "✅ All prerequisites met"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "📝 Creating .env file from template..."
    cp .env.example .env
    echo "⚠️  Please edit .env and add your credentials before continuing!"
    echo "   Required: IMESSAGE_API_KEY, IMESSAGE_ENDPOINT, OPENROUTER_API_KEY"
    echo ""
    read -p "Press Enter after you've updated .env, or Ctrl+C to exit..."
fi

# Install dependencies
echo "📦 Installing dependencies..."
pnpm install
echo ""

# Start infrastructure
echo "🐳 Starting Docker services (PostgreSQL, Redis, SigNoz)..."
docker-compose up -d postgres redis clickhouse signoz-otel-collector signoz-query-service signoz-frontend
echo ""

# Wait for services
echo "⏳ Waiting for services to be ready..."
sleep 10

# Check if services are running
if ! docker-compose ps | grep -q "postgres.*Up"; then
    echo "❌ PostgreSQL failed to start"
    docker-compose logs postgres
    exit 1
fi

if ! docker-compose ps | grep -q "redis.*Up"; then
    echo "❌ Redis failed to start"
    docker-compose logs redis
    exit 1
fi

echo "✅ Infrastructure services ready"
echo ""

# Generate Prisma client and run migrations
echo "🗄️  Setting up database..."
pnpm --filter @imessage-mcp/database generate
pnpm --filter @imessage-mcp/database migrate:dev --name init
echo ""

# Build shared packages
echo "🔨 Building shared packages..."
pnpm --filter @imessage-mcp/shared build
pnpm --filter @imessage-mcp/database build
echo ""

# Start services
echo "🎯 Starting application services..."
echo ""
echo "Services will start in development mode with hot-reload enabled."
echo "Press Ctrl+C to stop all services."
echo ""

# Start all services in parallel
pnpm dev

# This line won't be reached unless dev mode is stopped
echo ""
echo "👋 Services stopped. To restart, run: pnpm dev"
