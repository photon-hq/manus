FROM node:20-slim AS base
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

FROM base AS build
WORKDIR /app

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages ./packages
COPY services/slm-classifier ./services/slm-classifier

# Install all dependencies
RUN pnpm install --no-frozen-lockfile

# Build packages
RUN pnpm --filter @imessage-mcp/shared build
RUN pnpm --filter @imessage-mcp/slm-classifier build

FROM base AS runner
WORKDIR /app

# Copy everything from build
COPY --from=build /app ./

# Remove dev dependencies and build artifacts from production image
RUN pnpm prune --prod --no-optional && \
    rm -rf /app/.pnpm-store /app/**/src /app/**/*.ts /app/**/tsconfig.json 2>/dev/null || true

# Set working directory to service
WORKDIR /app/services/slm-classifier

# Set up entrypoint script (already copied from build stage)
RUN chmod +x docker-entrypoint.sh

RUN chown -R node:node /app

USER node
ENV NODE_ENV=production
EXPOSE 3001

# Use entrypoint script that checks DETECTION_MODE
ENTRYPOINT ["./docker-entrypoint.sh"]
