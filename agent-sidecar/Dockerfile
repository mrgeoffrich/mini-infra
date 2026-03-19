# Build context must be the repo root: docker build -f agent-sidecar/Dockerfile .
FROM node:24-alpine AS builder

WORKDIR /app

COPY agent-sidecar/package*.json ./
RUN npm ci

COPY agent-sidecar/tsconfig.json ./
COPY agent-sidecar/src/ ./src/
RUN npm run build

# ---------------------------------------------------------
FROM node:24-alpine AS production

# dumb-init for proper PID 1 signal handling
# docker-cli, github-cli, curl, git, bash for agent tool execution
RUN apk add --no-cache \
    dumb-init \
    docker-cli \
    github-cli \
    curl \
    git \
    bash \
    jq

WORKDIR /app

COPY agent-sidecar/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ ./dist/

# Documentation and .claude context baked in at build time
COPY client/src/user-docs/ /app/docs/
COPY .claude/ /app/.claude/

# Create agent working directory and SDK session persistence directory
RUN mkdir -p /tmp/agent-work /home/node/.claude && chown -R node:node /app /tmp/agent-work /home/node/.claude

USER node

ENV NODE_ENV=production
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3100/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
