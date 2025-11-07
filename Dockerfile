# Multi-stage Docker build for Mini Infra
# Stage 1: Build shared types library
# Stage 2: Build frontend application
# Stage 3: Build backend application
# Stage 4: Production runtime image

# ============================================
# Stage 1: Build shared types library
# ============================================
FROM node:20-alpine AS lib-builder

WORKDIR /app

# Copy root package files for workspace configuration
COPY package*.json ./

# Copy lib package
COPY lib ./lib

# Install dependencies for lib workspace only
RUN npm install --workspace=lib

# Build shared types
RUN npm run build:lib

# ============================================
# Stage 2: Build frontend application
# ============================================
FROM node:20-alpine AS client-builder

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
RUN cd client && npm run build

# ============================================
# Stage 3: Build backend application
# ============================================
FROM node:20-alpine AS server-builder

WORKDIR /app

# Copy built lib from lib-builder stage
COPY --from=lib-builder /app/lib ./lib

# Copy root package files
COPY package*.json ./

# Copy server package
COPY server ./server

# Install all dependencies (including dev dependencies for build)
RUN npm install --workspace=server --production=false

# Generate Prisma client
RUN cd server && npx prisma generate

# Build backend TypeScript to JavaScript
RUN cd server && npm run build

# ============================================
# Stage 4: Production runtime image
# ============================================
FROM node:20-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

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

# Copy production node_modules from server build stage
COPY --from=server-builder /app/server/node_modules ./server/node_modules

# Copy Prisma schema and migrations for runtime
COPY server/prisma ./server/prisma

# Copy configuration files
COPY server/config ./server/config

# Create directories for data and logs with proper permissions
RUN mkdir -p /app/data /app/server/logs && \
    chown -R node:node /app/data /app/server/logs

# Switch to non-root user for security
USER node

# Set environment to production
ENV NODE_ENV=production

# Default database location (can be overridden)
ENV DATABASE_URL=file:/app/data/production.db?foreign_keys=true

WORKDIR /app/server

# Expose application port
EXPOSE 5000

# Health check using built-in Node.js HTTP module
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start command: Run migrations then start server
# Use dumb-init for proper signal handling (SIGTERM for graceful shutdown)
CMD ["dumb-init", "sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
