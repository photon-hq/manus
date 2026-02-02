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

signoz: ## Open SigNoz dashboard
	@echo "Opening SigNoz at http://localhost:3301"
	@open http://localhost:3301 || xdg-open http://localhost:3301
