# egress-fw-agent image — host-singleton firewall agent that programs
# iptables + ipsets on behalf of the mini-infra-server, and reads NFLOG
# group 1 to surface dropped-egress events.
#
# Build context is the repo root so we can pull in the egress-shared/ module
# alongside egress-fw-agent/. The replace directive in egress-fw-agent/go.mod
# resolves egress-shared via a relative path inside the build container.

# ============================================================
# Stage 1: Builder
# ============================================================
FROM golang:1.22-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /build

# Copy both modules so the relative `replace ../egress-shared` resolves.
COPY egress-shared/    /build/egress-shared/
COPY egress-fw-agent/  /build/egress-fw-agent/

WORKDIR /build/egress-fw-agent

# Disable workspace mode in the build — replace directives in go.mod are authoritative.
ENV GOWORK=off

RUN go mod download

ARG TARGETARCH
# CGO disabled — go-nflog uses pure-Go netlink.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} \
    go build -ldflags="-s -w" -o /out/egress-fw-agent ./cmd

# ============================================================
# Stage 2: Runtime
# ============================================================
FROM alpine:3.19

# iptables / ip6tables / ipset for kernel rule programming;
# libnetfilter_log for NFLOG group reads.
# nftables-compat wraps iptables calls through the nf_tables backend on modern kernels.
RUN apk add --no-cache \
    iptables \
    ip6tables \
    ipset \
    libnetfilter_log \
    ca-certificates

COPY --from=builder /out/egress-fw-agent /usr/local/bin/egress-fw-agent

ENTRYPOINT ["/usr/local/bin/egress-fw-agent"]
