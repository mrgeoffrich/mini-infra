# Multi-stage Docker build for Mini Infra
# Stage 1: Build shared types library
# Stage 2: Build frontend application
# Stage 3: Build backend application
# Stage 4: Production runtime image

# ============================================
# Stage 1: Build shared types library
# ============================================
FROM node:24-alpine AS lib-builder

WORKDIR /app

# Copy root package files for workspace configuration
COPY package*.json ./

# Copy lib package
COPY lib ./lib

# Install dependencies and build shared types
RUN npm install --workspace=lib && \
    npm run build:lib

# ============================================
# Stage 2: Build frontend application
# ============================================
FROM node:24-alpine AS client-builder

WORKDIR /app

# Copy built lib from previous stage
COPY --from=lib-builder /app/lib ./lib

# Copy root package files
COPY package*.json ./

# Copy client package
COPY client ./client

# Install dependencies for client workspace
RUN npm install --workspace=client

# Build frontend (outputs to server/public via vite.config.ts)
WORKDIR /app/client
RUN npm run build

WORKDIR /app

# ============================================
# Stage 3: Build backend application
# ============================================
FROM node:24-alpine AS server-builder

WORKDIR /app

# Copy built lib from lib-builder stage
COPY --from=lib-builder /app/lib ./lib

# Copy root package files
COPY package*.json ./

# Copy server package
COPY server ./server

# Install all dependencies (including dev dependencies for build)
RUN npm install --workspace=server --production=false

# Generate Prisma client and build backend
WORKDIR /app/server
RUN npx prisma generate && \
    npm run build

WORKDIR /app

# ============================================
# Stage 4: Production runtime image
# ============================================
FROM node:24-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init=1.2.5-r3

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

# Copy startup script
COPY server/docker-entrypoint.sh ./server/docker-entrypoint.sh

# Create directories for data and logs with proper permissions
RUN mkdir -p /app/data /app/server/logs

# Make startup script executable
RUN chmod +x /app/server/docker-entrypoint.sh

# Change ownership of the entire app directory once, before switching users
# This is more efficient than chown after creating thousands of node_modules files
RUN chown -R node:node /app

# Switch to non-root user for security BEFORE running npm/prisma
# This way all generated files (node_modules, .prisma) are owned by node from the start
USER node

# Install production dependencies only (after copying package files)
RUN npm install --workspace=lib --workspace=server --omit=dev

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
