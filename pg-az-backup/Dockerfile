FROM alpine:3.23

# Phase 4 (MINI-53): the NATS CLI is downloaded so `backup.sh` / `restore.sh`
# can publish `mini-infra.backup.progress.<runId>` directly to NATS from
# inside the container, replacing the server-mediated bridge that consumed
# stdout. Alpine has no `nats-cli` package — it ships `nats-server` only —
# so we grab the upstream-published static Linux binary. Pinning to a
# specific release keeps the image build deterministic.
RUN apk update && apk upgrade && \
    apk add --no-cache bash curl postgresql-client gzip nodejs npm ca-certificates

ARG NATS_CLI_VERSION=0.4.0
# `unzip` is a virtual dep — installed before extracting the NATS CLI zip and
# removed in the same RUN so it doesn't bloat the final image layer.
RUN apk add --no-cache --virtual .nats-build unzip && \
    arch="$(uname -m)" && case "$arch" in \
        x86_64)  natsarch=amd64 ;; \
        aarch64) natsarch=arm64 ;; \
        *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/nats-io/natscli/releases/download/v${NATS_CLI_VERSION}/nats-${NATS_CLI_VERSION}-linux-${natsarch}.zip" -o /tmp/nats.zip && \
    cd /tmp && unzip -q nats.zip && \
    install -m 0755 "/tmp/nats-${NATS_CLI_VERSION}-linux-${natsarch}/nats" /usr/local/bin/nats && \
    rm -rf /tmp/nats.zip "/tmp/nats-${NATS_CLI_VERSION}-linux-${natsarch}" && \
    apk del .nats-build

RUN mkdir /app
WORKDIR /app

# Install the googleapis client used by the Drive upload/download scripts.
# Keeping this in /app/node_modules so the .mjs scripts can `import` directly.
COPY package.json /app/
RUN npm install --omit=dev --no-package-lock && rm -rf /root/.npm

COPY *.sh /app/
COPY *.mjs /app/
RUN chmod +x /app/*.sh

ENV BACKUP_FORMAT=plain
ENV COMPRESSION_LEVEL=6
ENV STORAGE_PROVIDER=azure

CMD ["/app/run.sh"]
