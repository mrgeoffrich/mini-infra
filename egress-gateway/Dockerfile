# egress-gateway image — Smokescreen-based HTTP/HTTPS forward proxy.
#
# Build context is the repo root so we can pull in the egress-shared/ module
# alongside egress-gateway/. The replace directive in egress-gateway/go.mod
# resolves egress-shared via a relative path inside the build container.

# ============================================================
# Stage 1: Builder
# ============================================================
FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /build

# Copy both modules so the relative `replace ../egress-shared` resolves.
COPY egress-shared/   /build/egress-shared/
COPY egress-gateway/  /build/egress-gateway/

WORKDIR /build/egress-gateway

# Disable workspace mode in the build — replace directives in go.mod are authoritative.
ENV GOWORK=off

RUN go mod download

ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} \
    go build -ldflags="-s -w" -o /out/egress-gateway ./cmd

# ============================================================
# Stage 2: Runtime
# ============================================================
FROM alpine:3.19

RUN apk add --no-cache ca-certificates

COPY --from=builder /out/egress-gateway /usr/local/bin/egress-gateway

ENTRYPOINT ["/usr/local/bin/egress-gateway"]
# Healthcheck is handled by the admin API at /admin/health.
