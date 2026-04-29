# Multi-stage Dockerfile — builds both egress-gateway and egress-fw-agent binaries.
# Builder: golang:1.22-alpine (matches the plan specification).
# Runtime: alpine:3.19 with iptables, ipset, and libnetfilter_log.

# ============================================================
# Stage 1: Builder
# ============================================================
FROM golang:1.22-alpine AS builder

# Install build dependencies for CGO-free Go modules.
RUN apk add --no-cache git ca-certificates

WORKDIR /build

# Copy go module files first for layer caching.
COPY go.mod go.sum ./
RUN go mod download

# Copy source.
COPY . .

# Build both binaries (CGO disabled — go-nflog uses pure Go netlink).
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w" -o /out/egress-gateway ./cmd/gateway

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w" -o /out/egress-fw-agent ./cmd/fw-agent

# ============================================================
# Stage 2: Runtime
# ============================================================
FROM alpine:3.19

# Install iptables, ipset, and libnetfilter_log at runtime.
# nftables-compat wraps iptables calls through the nf_tables backend on modern kernels.
RUN apk add --no-cache \
    iptables \
    ip6tables \
    ipset \
    libnetfilter_log \
    ca-certificates

# Copy compiled binaries from builder stage.
COPY --from=builder /out/egress-gateway  /usr/local/bin/egress-gateway
COPY --from=builder /out/egress-fw-agent /usr/local/bin/egress-fw-agent

# No default ENTRYPOINT — docker-compose sets it per service.
# Healthcheck is handled by the admin API at /v1/health.
