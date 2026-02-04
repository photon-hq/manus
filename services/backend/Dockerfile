FROM node:20-slim AS base
RUN apt-get update && apt-get install -y openssl postgresql-client && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

FROM base AS build
WORKDIR /app

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages ./packages
COPY services/backend ./services/backend
COPY favicon.png ./

# Install all dependencies
RUN pnpm install --no-frozen-lockfile

# Build packages
RUN pnpm --filter @imessage-mcp/shared build
RUN pnpm --filter @imessage-mcp/database generate
RUN pnpm --filter @imessage-mcp/database build
RUN pnpm --filter @imessage-mcp/backend build

FROM base AS runner
WORKDIR /app

# Copy everything from build
COPY --from=build /app ./

# Copy entrypoint script
COPY services/backend/docker-entrypoint.sh /app/services/backend/
RUN chmod +x /app/services/backend/docker-entrypoint.sh

# Set working directory to service
WORKDIR /app/services/backend

ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/app/services/backend/docker-entrypoint.sh"]
