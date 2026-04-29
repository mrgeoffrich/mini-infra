# ACME Client (`@mini-infra/acme`)

In-house ACME (RFC 8555) client used by the server to issue and renew Let's Encrypt certificates. Zero runtime dependencies — uses only Node's built-in `crypto`, `fetch`, and `node:` modules.

## Why a custom client

The server uses DNS-01 challenges via Cloudflare, with deep integration into the certificate lifecycle (Vault storage, scheduler, drift detection). Bringing in `acme-client` or similar pulled too many transitive deps and made the JWS/CSR flow opaque. This package keeps the protocol surface visible and tweakable.

## Structure

```
acme/
├── src/
│   ├── index.ts          # Public surface — re-exports
│   ├── client.ts         # AcmeClient: account, order, finalize, certificate
│   ├── http.ts           # AcmeHttpClient: nonce handling, JWS POST, retries
│   ├── jws.ts            # JwsSigner: account-key signed JWS payloads
│   ├── directories.ts    # letsencrypt / staging / buypass / zerossl URLs
│   ├── errors.ts         # AcmeProblemError (RFC 7807 problem+json)
│   ├── types.ts          # Account, Order, Authorization, Challenge shapes
│   ├── crypto/
│   │   ├── keys.ts       # ECDSA P-256 / RSA key generation, PEM encode
│   │   ├── jwk.ts        # JWK conversion + thumbprint
│   │   ├── csr.ts        # CSR generation (subject + SAN)
│   │   ├── asn1.ts       # Minimal ASN.1 DER encoder for CSR
│   │   └── pem.ts        # PEM splitting / chain handling
│   └── flow/
│       ├── auto.ts       # End-to-end issuance flow (high-level helper)
│       ├── poll.ts       # Order/authorization polling with backoff
│       └── verify.ts     # Pre-flight DNS-01 record verification
└── test/                 # Vitest suites: jws, jwk, csr, http, flow, concurrency
```

## Commands

```bash
pnpm --filter @mini-infra/acme build         # tsc → dist/
pnpm --filter @mini-infra/acme dev           # tsc --watch
pnpm --filter @mini-infra/acme test          # vitest run
pnpm --filter @mini-infra/acme test:watch
```

## Build Order

The server depends on this package (workspace dep). `pnpm build:server` builds acme before server, so don't compile server against a stale `dist/`.

## Conventions

- **Zero runtime deps.** If you need a dependency, push back hard — this is a deliberate constraint that keeps the cert-issuance path auditable.
- **DNS-01 only** is exercised in production. HTTP-01 paths exist but aren't wired into the server.
- Use `flow/auto.ts` as the high-level entry; only drop to `client.ts` when you need to do something the auto flow doesn't.
