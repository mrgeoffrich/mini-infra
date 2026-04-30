FROM python:3.12-slim

ARG GH_VERSION=2.92.0
ARG GWS_VERSION=0.22.5

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        curl ca-certificates jq gnupg openssl \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# gh CLI — static release tarball
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tar.gz \
 && tar -xzf /tmp/gh.tar.gz -C /tmp \
 && install -m 755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh*

# gws (Google Workspace CLI) — static release tarball
RUN curl -fsSL "https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/gws.tar.gz \
 && tar -xzf /tmp/gws.tar.gz -C /tmp \
 && install -m 755 /tmp/gws /usr/local/bin/gws \
 && rm -rf /tmp/gws*

# Python: anthropic SDK + claude-agent-sdk
RUN pip install --no-cache-dir anthropic claude-agent-sdk

# Node: bundle the Claude Code CLI globally so claude-agent-sdk has it on PATH
RUN npm install -g @anthropic-ai/claude-code

# Trust paths used by Node and Python at runtime. The CA cert itself is
# mounted from the cert-init volume; entrypoint.sh installs it system-wide.
ENV NODE_EXTRA_CA_CERTS=/certs/ca.crt
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /work
COPY entrypoint.sh /entrypoint.sh
COPY test_anthropic.py test_claude_agent.py test_proxy.sh test_gh_live.sh test_gws_live.sh ./
RUN chmod +x /entrypoint.sh test_proxy.sh test_gh_live.sh test_gws_live.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["sleep", "infinity"]
