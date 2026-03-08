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

# Copy root package.json for workspace resolution
COPY package*.json ./

# Copy lib package.json
COPY lib/package*.json ./lib/

# Copy built lib artifacts
COPY --from=lib-builder /app/lib/dist ./lib/dist

# Copy server package.json
COPY server/package*.json ./server/

# Copy built frontend assets (served by Express from server/public)
COPY --from=client-builder /app/server/public ./server/public

# Copy built backend JavaScript
COPY --from=server-builder /app/server/dist ./server/dist

# Copy Prisma schema and migrations for runtime
COPY server/prisma ./server/prisma

# Copy configuration files
COPY server/config ./server/config

# Copy stack template files (HAProxy, monitoring, etc.)
COPY server/templates ./server/templates

# Copy startup script
COPY server/docker-entrypoint.sh ./server/docker-entrypoint.sh

# Create agent working directory and copy user documentation
COPY client/src/user-docs/ /app/agent/docs/

# Create directories for data, logs, and agent with proper permissions
RUN mkdir -p /app/data /app/server/logs /app/agent

# Make startup script executable
RUN chmod +x /app/server/docker-entrypoint.sh

# Change ownership of the entire app directory once, before switching users
# This is more efficient than chown after creating thousands of node_modules files
RUN chown -R node:node /app

# Switch to non-root user for security BEFORE running npm/prisma
# This way all generated files (node_modules, .prisma) are owned by node from the start
USER node

# Install production dependencies only (after copying package files)
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 \
    npm install --workspace=lib --workspace=server --omit=dev

# Generate Prisma client in production environment
# This creates the client code in node_modules/.prisma/client based on the schema
WORKDIR /app/server
RUN npx prisma generate

WORKDIR /app

# Set environment to production
ENV NODE_ENV=production

# Default database location (can be overridden)
ENV DATABASE_URL=file:/app/data/production.db?foreign_keys=true

WORKDIR /app/server

# Expose application port
EXPOSE 5000

# Health check using built-in Node.js HTTP module
# HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
#   CMD node -e "require('http').get('http://localhost:5000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use dumb-init as entrypoint for proper signal handling (SIGTERM for graceful shutdown)
ENTRYPOINT ["dumb-init", "--"]

CMD ["sh", "/app/server/docker-entrypoint.sh"]
