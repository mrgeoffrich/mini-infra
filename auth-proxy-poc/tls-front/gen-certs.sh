#!/bin/sh
# Generates a self-signed CA + a multi-SAN server cert covering the upstream
# hostnames the test stack intercepts. Idempotent — skips when /certs already
# has the bundle.
set -e

if [ -f /certs/ca.crt ] && [ -f /certs/server.crt ] && [ -f /certs/server.key ]; then
    echo "certs already present in /certs, skipping"
    exit 0
fi

apk add --no-cache openssl >/dev/null

cd /certs

# Root CA
openssl genrsa -out ca.key 2048 2>/dev/null
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
    -out ca.crt -subj "/CN=auth-proxy-poc-ca" 2>/dev/null

# Server cert with all SANs we want to intercept
cat > /tmp/v3.ext <<EOF
subjectAltName = @alt_names

[alt_names]
DNS.1 = api.anthropic.com
DNS.2 = api.github.com
DNS.3 = www.googleapis.com
DNS.4 = oauth2.googleapis.com
DNS.5 = admin.googleapis.com
DNS.6 = drive.googleapis.com
DNS.7 = gmail.googleapis.com
DNS.8 = people.googleapis.com
EOF

openssl genrsa -out server.key 2048 2>/dev/null
openssl req -new -key server.key -out server.csr \
    -subj "/CN=auth-proxy-poc-tls-front" 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out server.crt -days 365 -sha256 -extfile /tmp/v3.ext 2>/dev/null

rm -f server.csr ca.srl /tmp/v3.ext
echo "certs generated:"
ls -1 /certs
