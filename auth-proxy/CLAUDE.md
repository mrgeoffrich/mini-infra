# Auth Proxy

Per-environment reverse-proxy sidecar that holds API credentials on behalf of
application containers. Apps point their SDK / CLI at the proxy
(`http://auth-proxy:8080/<provider>/<tenant>/<rest>`); the proxy strips any
inbound `Authorization` / `X-Api-Key`, looks up the right credential from its
config, injects it, and forwards plain HTTP to the upstream API. App
containers don't carry the keys.

Two credential strategies in v1:
- **`static_header`** — Anthropic API keys, GitHub PATs.
- **`oauth2_refresh`** — Google Workspace (refresh token → access token, in-memory cache, single-flight refresh).

See `../docs/planning/not-shipped/auth-proxy-sidecar-plan.md` for the original
design doc.

## Structure

```
auth-proxy/
├── cmd/
│   └── main.go              # load config -> build providers -> serve
├── internal/
│   ├── config/              # YAML parse + ${ENV} interpolation + validation
│   ├── providers/           # CredentialProvider interface + impls
│   │                        # (static_header.go, oauth2_refresh.go)
│   ├── proxy/               # path router + reverse-proxy + /healthz, /readyz
│   └── accesslog/           # JSON access log — never logs auth headers/bodies
├── Dockerfile
├── config.example.yaml
└── go.mod
```

## Build & Run

```bash
cd auth-proxy
go build ./cmd                              # produces ./cmd or ./auth-proxy.exe
go test ./...                               # all units

# Run locally with the example config + env vars
ANTHROPIC_KEY_TEAM_FOO=sk-ant-... \
GITHUB_PAT_ORG_ACME=ghp_... \
GWS_CLIENT_ID=... \
GWS_CLIENT_SECRET=... \
GWS_REFRESH_TOKEN=... \
  ./auth-proxy --config config.example.yaml
```

The container-side flow is identical: mount `config.yaml` at
`/etc/auth-proxy/config.yaml` (default), pass the env vars, expose port 8080.

## Configuration

Single YAML file with `${ENV_VAR}` interpolation for every secret. Loading
fails loudly if any referenced var is unset — a misdeployment cannot end up
sending an empty `Authorization` header to an upstream.

```yaml
listen: ":8080"
providers:
  anthropic:
    type: static_header
    upstream: https://api.anthropic.com
    tenants:
      team-foo:
        headers:
          x-api-key: ${ANTHROPIC_KEY_TEAM_FOO}
  gws:
    type: oauth2_refresh
    upstream: https://www.googleapis.com
    oauth:
      token_url: https://oauth2.googleapis.com/token
    tenants:
      default:
        client_id:     ${GWS_CLIENT_ID}
        client_secret: ${GWS_CLIENT_SECRET}
        refresh_token: ${GWS_REFRESH_TOKEN}
```

Tenant names must match `[a-z0-9][a-z0-9-]*` so they map cleanly to per-tenant
ACLs later (e.g. Vault path `secret/auth-proxy/<provider>/<tenant>`).

## Conventions

- **Resolve auth before forwarding.** The handler calls `Provider.Apply()`
  *before* constructing the `httputil.ReverseProxy`, so OAuth refresh
  failures map cleanly to a `502 auth provider error` instead of being
  swallowed inside `Director` (which can't return errors).
- **Strip then inject, in that order.** Inbound `Authorization` and
  `X-Api-Key` are deleted before the provider's headers are added — clients
  shouldn't send them, but if they do, the proxy's value wins.
- **No request-body size limit.** Anthropic image prompts and Drive uploads
  are legitimately multi-MB. Let upstreams enforce. If a future PR adds a
  limit "for safety", it will silently break Drive — keep the explicit
  no-limit comment in `cmd/main.go`.
- **Access log redaction is structural.** `internal/accesslog.Entry` is the
  entire log surface — if a field isn't on the struct, it cannot leak. Don't
  add `Headers`, `Body`, `Token`, or anything that might pull secrets out of
  a request.
- **Single-flight OAuth refresh.** `oauth2_refresh` uses a `chan struct{}`
  gate keyed by the provider so a burst of concurrent requests collapses
  into one token-endpoint call. Tested in `oauth2_refresh_test.go::TestOAuth2_single_flight_under_concurrent_load`.
- **Stateless except for the access-token cache.** That cache is rebuilt
  from the refresh token on boot, so bouncing the container is the supported
  way to roll secrets — no SIGHUP plumbing yet.

## What's NOT in this package (yet)

- Vault secret resolution (planned — `vault://secret/...` instead of `${ENV}`).
- Server-side stack template / API model integration with the larger app.
- Per-environment UI for managing providers and tenants.
- Service-account JWT auth (gcloud / GAM-style — separate provider type).
- GitHub App auth (currently PAT only).

These are deliberate scope holds — the original plan doc breaks them into
separate PRs after this one.
