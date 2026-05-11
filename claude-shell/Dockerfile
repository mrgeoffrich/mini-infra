# Claude Shell — Tailscale-SSH-enabled developer container with Claude Code baked in.
#
# Base: tailscale/tailscale:stable (Alpine-based; ships tailscaled + tailscale).
# Added: nodejs, npm, git, openssh-client, tini, bash, ca-certificates.
# Globally installed: @anthropic-ai/claude-code (the `claude` CLI).
#
# Runtime contract — see claude-shell/README.md and docs/planning/not-shipped/claude-shell-plan.md §4.4.
# Required env: TS_AUTHKEY, TS_HOSTNAME, TS_EXTRA_ARGS.
# Optional env: GIT_REPO_URL, GIT_SSH_KEY, WORKSPACE_DIR (default /workspace).

FROM tailscale/tailscale:stable

# Install runtime tooling. Pin nothing here — base is Alpine stable and apk
# upgrades flow with the base tag.
RUN apk add --no-cache \
        nodejs \
        npm \
        git \
        openssh-client \
        tini \
        bash \
        ca-certificates \
    && npm install -g --omit=dev @anthropic-ai/claude-code \
    && npm cache clean --force \
    && rm -rf /var/cache/apk/* /tmp/* /root/.npm

# Run as root for simplicity (matches the sidecar precedent and lets tailscaled
# create /var/lib/tailscale state + bind privileged tun sockets). HOME points at
# /home/claude so that Claude Code OAuth tokens (`~/.config/claude/`), shell
# history, and any per-user MCP installs land on a persistent volume that the
# stack can mount independently of /workspace.
ENV HOME=/home/claude
RUN mkdir -p /home/claude /workspace /var/lib/tailscale

WORKDIR /workspace

# Persistent volumes declared so consumers (the Phase 3 addon, hand-crafted
# stacks, docker run users) get sane defaults.
VOLUME ["/workspace", "/home/claude"]

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# tini as PID 1 so signal handling and zombie reaping behave; the entrypoint
# script execs tailscaled in the background and `wait`s on it, but tini still
# owns reaping any other transient children.
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
