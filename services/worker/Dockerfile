FROM node:20-slim AS base
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

FROM base AS build
WORKDIR /app

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages ./packages
COPY services/worker ./services/worker

# Install all dependencies
RUN pnpm install --no-frozen-lockfile

# Build packages
RUN pnpm --filter @imessage-mcp/shared build
RUN pnpm --filter @imessage-mcp/database generate
RUN pnpm --filter @imessage-mcp/database build
RUN pnpm --filter @imessage-mcp/worker build

FROM base AS runner
WORKDIR /app

# Copy everything from build
COPY --from=build /app ./

# Copy entrypoint script
COPY services/worker/docker-entrypoint.sh /app/services/worker/
RUN chmod +x /app/services/worker/docker-entrypoint.sh

# Set working directory to service
WORKDIR /app/services/worker

ENV NODE_ENV=production
ENTRYPOINT ["/app/services/worker/docker-entrypoint.sh"]
