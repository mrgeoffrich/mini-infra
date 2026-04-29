# Multi-stage Docker build for Mini Infra (pnpm workspace)
# Stage 1: Install all dependencies (shared across build stages)
# Stage 2: Build shared types library
# Stage 3: Build frontend application
# Stage 4: Build backend application
# Stage 4a: Assemble a self-contained prod tree via `pnpm deploy`
# Stage 5: Production runtime image

# ============================================
# Stage 1: Install all workspace dependencies
# ============================================
FROM node:24-alpine AS deps

WORKDIR /app

RUN corepack enable

# Copy only manifest files first for optimal layer caching.
# Changes to source code won't bust this layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY lib/package.json ./lib/
COPY acme/package.json ./acme/
COPY client/package.json ./client/
COPY server/package.json ./server/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ============================================
# Stage 2: Build shared types library
# ============================================
FROM deps AS lib-builder

COPY lib ./lib

RUN pnpm --filter @mini-infra/types build

# ============================================
# Stage 2a: Build in-house ACME library
# ============================================
FROM deps AS acme-builder

COPY acme ./acme

RUN pnpm --filter @mini-infra/acme build

# ============================================
# Stage 2b: deps with built lib + acme available
# (needed because workspace symlinks resolve through lib/ and acme/)
# ============================================
FROM deps AS deps-with-lib

COPY --from=lib-builder /app/lib/dist ./lib/dist
COPY --from=lib-builder /app/lib/types ./lib/types
COPY --from=lib-builder /app/lib/tsconfig.json ./lib/tsconfig.json

COPY --from=acme-builder /app/acme/dist ./acme/dist
COPY --from=acme-builder /app/acme/src ./acme/src
COPY --from=acme-builder /app/acme/tsconfig.json ./acme/tsconfig.json

# ============================================
# Stage 3: Build frontend application
# ============================================
FROM deps-with-lib AS client-builder

COPY client ./client

# Build frontend (outputs to server/public via vite.config.ts)
RUN pnpm --filter mini-infra-client build

# ============================================
# Stage 4: Build backend application
# ============================================
FROM deps-with-lib AS server-builder

COPY server ./server

# Generate Prisma client and build backend.
# `pnpm --filter ... exec` scopes prisma resolution to the server workspace.
RUN pnpm --filter mini-infra-server exec prisma generate && \
    pnpm --filter mini-infra-server build

# ============================================
# Stage 4a: Deploy (self-contained prod tree for server)
# `pnpm deploy` assembles a directory containing only mini-infra-server's
# prod deps, with workspace:* references (lib, acme) inlined. This replaces
# the previous `npm install --workspace=... --omit=dev` pattern.
# ============================================
FROM server-builder AS deployer

# `--legacy` preserves the pnpm <10 deploy semantics (symlink-traversal of
# workspace:* deps) so we don't need `inject-workspace-packages=true`
# globally — which would break dev hot-reload on the lib/ workspace.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm deploy --filter=mini-infra-server --prod --legacy /prod/server

# ============================================
# Stage 5: Production runtime image
# ============================================
FROM node:24-alpine AS production

# Install dumb-init for proper signal handling, Docker CLI for container management,
# and GitHub CLI for repository operations
RUN apk add --no-cache dumb-init=1.2.5-r3 docker-cli github-cli

WORKDIR /app

# Create directories with proper ownership
RUN mkdir -p /app/data /app/server/logs /app/agent && chown -R node:node /app

# --- Dependency + built-code layer ---
# `pnpm deploy` produced a self-contained tree with node_modules + package.json
# + built artefacts (for the server workspace). Drop it at /app/server.
COPY --chown=node:node --from=deployer /prod/server ./server

# Copy built lib artifacts (consumed as a workspace dep, already linked
# into /app/server/node_modules by pnpm deploy — this copy keeps the
# on-disk layout matching previous deploys for any runtime code that
# references `../lib/dist` directly).
COPY --chown=node:node --from=lib-builder /app/lib/dist ./lib/dist

# Copy built acme artifacts (same rationale as lib/dist above).
COPY --chown=node:node --from=acme-builder /app/acme/dist ./acme/dist

# Copy built frontend assets (served by Express from server/public)
COPY --chown=node:node --from=client-builder /app/server/public ./server/public

# Copy user documentation for agent
COPY --chown=node:node client/src/user-docs/ /app/agent/docs/

# Bake in the matching sidecar image tag so the app always launches
# the correct sidecar version during self-update.
ARG SIDECAR_IMAGE_TAG=latest
ENV SIDECAR_IMAGE_TAG=${SIDECAR_IMAGE_TAG}

ARG AGENT_SIDECAR_IMAGE_TAG=latest
ENV AGENT_SIDECAR_IMAGE_TAG=${AGENT_SIDECAR_IMAGE_TAG}

ARG EGRESS_SIDECAR_IMAGE_TAG=ghcr.io/mrgeoffrich/mini-infra-egress-sidecar
ENV EGRESS_SIDECAR_IMAGE_TAG=${EGRESS_SIDECAR_IMAGE_TAG}

ARG EGRESS_GATEWAY_IMAGE_TAG=mini-infra/egress-gateway:dev
ENV EGRESS_GATEWAY_IMAGE_TAG=${EGRESS_GATEWAY_IMAGE_TAG}

ARG PG_BACKUP_IMAGE_TAG=ghcr.io/mrgeoffrich/mini-infra-pg-backup:dev
ENV PG_BACKUP_IMAGE_TAG=${PG_BACKUP_IMAGE_TAG}

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
