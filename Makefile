.PHONY: help install dev build start stop clean migrate db-studio logs

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install all dependencies
	pnpm install

dev: ## Start all services in development mode
	docker-compose up -d postgres redis
	@echo "Waiting for services to be ready..."
	@sleep 5
	pnpm db:generate
	pnpm db:migrate
	pnpm dev

build: ## Build all services
	pnpm build

docker-build: ## Build Docker images
	docker-compose build

docker-up: ## Start all services with Docker
	docker-compose up -d

docker-down: ## Stop all Docker services
	docker-compose down

docker-logs: ## View Docker logs
	docker-compose logs -f

migrate: ## Run database migrations
	pnpm db:migrate

db-studio: ## Open Prisma Studio
	pnpm db:studio

clean: ## Clean build artifacts
	pnpm clean
	rm -rf node_modules
	rm -rf packages/*/node_modules
	rm -rf services/*/node_modules

reset-db: ## Reset database (WARNING: deletes all data)
	docker-compose down -v
	docker-compose up -d postgres
	@sleep 5
	pnpm db:migrate

logs: ## View logs from all services
	docker-compose logs -f

# MCP Package Publishing
mcp-build: ## Build MCP package for publishing
	cd services/mcp-server && pnpm build

mcp-test: ## Test MCP package locally
	cd services/mcp-server && pnpm build
	@echo "Testing MCP package..."
	@echo "Run: PHOTON_API_KEY=test_key BACKEND_URL=http://localhost:3000 node services/mcp-server/dist/index.js"

mcp-publish-beta: mcp-build ## Publish MCP package to NPM (beta tag)
	cd services/mcp-server && npm publish --tag beta --access public

mcp-publish: mcp-build ## Publish MCP package to NPM (latest)
	cd services/mcp-server && npm publish --access public

mcp-promote: ## Promote beta version to latest
	@read -p "Enter version to promote (e.g., 1.0.0): " version; \
	cd services/mcp-server && npm dist-tag add photon-manus-mcp@$$version latest
