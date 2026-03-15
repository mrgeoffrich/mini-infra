# Multi-stage Docker build for Mini Infra
# Stage 1: Install all dependencies (shared across build stages)
# Stage 2: Build shared types library
# Stage 3: Build frontend application
# Stage 4: Build backend application
# Stage 5: Production runtime image

# ============================================
# Stage 1: Install all workspace dependencies
# ============================================
FROM node:24-alpine AS deps

WORKDIR /app

# Copy only package files first for optimal layer caching
# Changes to source code won't bust this layer
COPY package*.json ./
COPY lib/package*.json ./lib/
COPY client/package*.json ./client/
COPY server/package*.json ./server/

RUN --mount=type=cache,target=/root/.npm \
    npm install --production=false

# ============================================
# Stage 2: Build shared types library
# ============================================
FROM deps AS lib-builder

# Copy lib source (deps already installed)
COPY lib ./lib

RUN npm run build:lib

# ============================================
# Stage 2b: deps with built lib available
# (needed because workspace symlinks resolve through lib/)
# ============================================
FROM deps AS deps-with-lib

COPY --from=lib-builder /app/lib/dist ./lib/dist
COPY --from=lib-builder /app/lib/types ./lib/types
COPY --from=lib-builder /app/lib/tsconfig.json ./lib/tsconfig.json

# ============================================
# Stage 3: Build frontend application
# ============================================
FROM deps-with-lib AS client-builder

# Copy client source only (deps + built lib already available)
COPY client ./client

# Build frontend (outputs to server/public via vite.config.ts)
RUN npm run build -w client

# ============================================
# Stage 4: Build backend application
# ============================================
FROM deps-with-lib AS server-builder

# Copy server source only (deps + built lib already available)
COPY server ./server

# Generate Prisma client and build backend
RUN cd server && npx prisma generate && npm run build

# ============================================
# Stage 5: Production runtime image
# ============================================
FROM node:24-alpine AS production

# Install dumb-init for proper signal handling, Docker CLI for container management,
# and GitHub CLI for repository operations
RUN apk add --no-cache dumb-init=1.2.5-r3 docker-cli github-cli

WORKDIR /app

# --- Dependency layer (cached unless package.json or prisma schema changes) ---
# These layers are large (~710MB) but rarely change, so they should come first.

# Copy package files for workspace resolution and npm install
COPY --chown=node:node package*.json ./
COPY --chown=node:node lib/package*.json ./lib/
COPY --chown=node:node server/package*.json ./server/

# Copy Prisma schema for client generation (migrations copied later with code)
COPY --chown=node:node server/prisma/schema.prisma ./server/prisma/schema.prisma

# Create directories with proper ownership
RUN mkdir -p /app/data /app/server/logs /app/agent && chown -R node:node /app

# Install production dependencies only
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 \
    npm install --workspace=lib --workspace=server --omit=dev

# Generate Prisma client in production environment
WORKDIR /app/server
RUN npx prisma generate

WORKDIR /app

# --- Code layer (changes on every code change, but small ~20MB) ---

# Copy built lib artifacts
COPY --chown=node:node --from=lib-builder /app/lib/dist ./lib/dist

# Copy built frontend assets (served by Express from server/public)
COPY --chown=node:node --from=client-builder /app/server/public ./server/public

# Copy built backend JavaScript
COPY --chown=node:node --from=server-builder /app/server/dist ./server/dist

# Copy Prisma migrations for runtime (migrate deploy)
COPY --chown=node:node server/prisma/migrations ./server/prisma/migrations

# Copy configuration files
COPY --chown=node:node server/config ./server/config

# Copy stack template files (HAProxy, monitoring, etc.)
COPY --chown=node:node server/templates ./server/templates

# Copy startup script
COPY --chown=node:node server/docker-entrypoint.sh ./server/docker-entrypoint.sh
RUN chmod +x /app/server/docker-entrypoint.sh

# Copy user documentation for agent
COPY --chown=node:node client/src/user-docs/ /app/agent/docs/

# Bake in the matching sidecar image tag so the app always launches
# the correct sidecar version during self-update.
ARG SIDECAR_IMAGE_TAG=latest
ENV SIDECAR_IMAGE_TAG=${SIDECAR_IMAGE_TAG}

ARG AGENT_SIDECAR_IMAGE_TAG=latest
ENV AGENT_SIDECAR_IMAGE_TAG=${AGENT_SIDECAR_IMAGE_TAG}

# Bake in the application version for display in the UI.
ARG BUILD_VERSION=dev
ENV BUILD_VERSION=${BUILD_VERSION}

# Set environment to production
ENV NODE_ENV=production

# Default database location (can be overridden)
ENV DATABASE_URL=file:/app/data/production.db?foreign_keys=true&journal_mode=WAL

WORKDIR /app/server

# Expose application port
EXPOSE 5000

# Health check using built-in Node.js HTTP module
# HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
#   CMD node -e "require('http').get('http://localhost:5000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use dumb-init as entrypoint for proper signal handling (SIGTERM for graceful shutdown)
ENTRYPOINT ["dumb-init", "--"]

CMD ["sh", "/app/server/docker-entrypoint.sh"]
