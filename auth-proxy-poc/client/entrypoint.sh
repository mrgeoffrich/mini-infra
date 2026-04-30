#!/bin/sh
# Installs the test stack's self-signed CA into the system trust store at
# container startup. The cert-init service writes /certs/ca.crt before this
# container becomes useful, so it should always be present in live mode; in
# the offline mock phase the container starts without TLS interception.
set -e

if [ -f /certs/ca.crt ]; then
    cp /certs/ca.crt /usr/local/share/ca-certificates/auth-proxy-poc-ca.crt
    update-ca-certificates >/dev/null 2>&1 || true
fi

exec "$@"
