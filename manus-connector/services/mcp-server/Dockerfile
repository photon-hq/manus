FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

FROM base AS dependencies
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/database/package.json ./packages/database/
COPY packages/shared/package.json ./packages/shared/
COPY services/mcp-server/package.json ./services/mcp-server/
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/packages ./packages
COPY . .
RUN pnpm --filter @imessage-mcp/database generate
RUN pnpm --filter @imessage-mcp/mcp-server build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/mcp-server/dist ./services/mcp-server/dist
COPY --from=build /app/services/mcp-server/package.json ./services/mcp-server/

CMD ["node", "services/mcp-server/dist/index.js"]
