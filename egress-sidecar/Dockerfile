FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:24-alpine

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ ./dist/

USER node

ENV NODE_ENV=production

EXPOSE 53/udp
EXPOSE 53/tcp
EXPOSE 8054/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8054/admin/health || exit 1

ENTRYPOINT ["dumb-init", "node", "dist/index.js"]
