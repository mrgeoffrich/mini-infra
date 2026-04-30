# Auth-proxy sidecar (design)

Status: **planned, not implemented**. Ideation captured for a future build.

## Problem

API credentials for outbound services (Anthropic, GitHub, Google Drive, gws CLI) currently live in the application containers that consume them — set as env vars or injected from Vault at container start. That has three downsides:

1. **Rotation is per-container.** Every consumer container needs a restart or re-injection when a key rotates.
2. **No central audit.** We can't tell which app made which call to which provider without per-app instrumentation.
3. **Bypass risk.** Any container with the key can call the provider; we can't enforce "only app X may call Anthropic" without per-app key splitting.

We already have a forward proxy (`egress-gateway`) for outbound traffic, but it's CONNECT-tunnelling — it can't read or modify the headers of HTTPS requests without TLS interception, which is a much bigger change in scope (per-container CA trust, plaintext exposure, breaks any future cert pinning). See [egress-gateway/CLAUDE.md](../../../egress-gateway/CLAUDE.md).

A small per-environment reverse-proxy sidecar gives us the same end-state outcome (apps don't hold keys) without MITM.

## Goals

1. Credentials for Anthropic, GitHub (PAT), Google Drive, and gws live in the auth-proxy, not in app containers.
2. Multi-tenant from day one — multiple keys per provider per environment, addressed by a path segment.
3. Standard reverse-proxy semantics: streaming/SSE works, large bodies pass through, no body buffering.
4. One sidecar per environment, deployed as a stack like the egress gateway.
5. Reuses existing Vault for secret storage; reuses existing stack-template plumbing for deployment.

## Non-goals

- TLS interception of arbitrary outbound traffic. Apps explicitly opt in by pointing their SDK at the sidecar.
- Replacing the egress gateway. The sidecar still routes outbound through the gateway — it's just another container in the env.
- GitHub App support in v1. Personal Access Tokens only. The JWT → installation-token dance is a worthwhile but separable follow-up.
- Service-account JWT auth (e.g. GAM, gcloud). Not needed for the v1 service set.
- Auto-managing the egress allowlist. Users add `api.anthropic.com`, `api.github.com`, `oauth2.googleapis.com`, `www.googleapis.com` themselves.

## Architecture

Single Go binary, ~400-600 LOC. Stdlib `net/http` + `httputil.ReverseProxy` (handles streaming/SSE/flushing correctly out of the box).

- Listens HTTP on `:8080` on the env's docker network. **No TLS inbound** — internal traffic only, env network is already isolated.
- Outbound TLS to upstreams is normal Go `http.Transport`. No MITM, no cert games.
- One container per environment. DNS name within the env: `auth-proxy`.
- Reads config from a mounted YAML file + a Vault token in env. Re-reads on `SIGHUP` so secrets rotate without bouncing the container.

## Routing

Path-prefix routing with a tenant segment:

```
http://auth-proxy:8080/<provider>/<tenant>/<rest-of-path>
```

| Client request | Upstream |
|---|---|
| `…/anthropic/team-foo/v1/messages` | `https://api.anthropic.com/v1/messages` |
| `…/github/org-acme/repos/...` | `https://api.github.com/repos/...` |
| `…/github-uploads/org-acme/...` | `https://uploads.github.com/...` |
| `…/gdrive/personal/drive/v3/files` | `https://www.googleapis.com/drive/v3/files` |
| `…/gdrive-upload/personal/...` | `https://www.googleapis.com/upload/drive/v3/...` |

Router behaviour:

- Strip the `/<provider>/<tenant>` prefix, rewrite `Host`, drop any inbound `Authorization` / `x-api-key` headers (defensive — clients shouldn't send them, but we strip in case).
- Unknown provider or tenant → `404` with a structured error body. Misconfigured clients fail loudly rather than mysteriously hitting the wrong account.
- Tenant ID character set restricted to `[a-z0-9][a-z0-9-]*` (DNS-label-ish). Validated at config load time.

## Credential providers

Single interface, two implementations in v1:

```go
type CredentialProvider interface {
    Apply(ctx context.Context, tenantID string, req *http.Request) error
}
```

### `static_header` — Anthropic, GitHub PAT

- Pulls header values from Vault on boot, caches in memory per tenant.
- Sets the configured headers on every request (e.g. `x-api-key`, `Authorization: Bearer …`, `anthropic-version: 2023-06-01`).
- No expiry, no refresh.

### `oauth2_refresh` — Google Drive, gws

- Per-tenant: stores `client_id`, `client_secret`, `refresh_token` in Vault.
- Maintains an in-memory `(access_token, expires_at)` keyed by `(provider, tenant)`.
- On request: if `expires_at - now < 60s`, calls the token endpoint with `grant_type=refresh_token` to mint a fresh access token. Sets `Authorization: Bearer <access>`.
- **Single-flight refresh** (sync.Once-style guard) so a burst of requests doesn't fan out N refresh calls.
- Failure mode: refresh-token revoked → log a structured event, return `503` with a body explaining "credential needs re-link" (rather than letting a 401 leak through and confusing clients).

## Config shape

```yaml
listen: ":8080"
providers:
  anthropic:
    type: static_header
    routes: [/anthropic]
    upstream: https://api.anthropic.com
    common_headers:
      anthropic-version: "2023-06-01"
    tenants:
      team-foo:
        x-api-key: vault://secret/auth-proxy/anthropic/team-foo#api-key
      team-bar:
        x-api-key: vault://secret/auth-proxy/anthropic/team-bar#api-key

  github:
    type: static_header
    routes: [/github, /github-uploads]
    upstreams:
      /github: https://api.github.com
      /github-uploads: https://uploads.github.com
    tenants:
      org-acme:
        Authorization: "Bearer ${vault://secret/auth-proxy/github/org-acme#pat}"
      personal:
        Authorization: "Bearer ${vault://secret/auth-proxy/github/personal#pat}"

  gdrive:
    type: oauth2_refresh
    routes: [/gdrive, /gdrive-upload]
    upstreams:
      /gdrive: https://www.googleapis.com
      /gdrive-upload: https://www.googleapis.com
    oauth:
      token_url: https://oauth2.googleapis.com/token
    tenants:
      personal:
        client_id: vault://secret/auth-proxy/gdrive/personal#client-id
        client_secret: vault://secret/auth-proxy/gdrive/personal#client-secret
        refresh_token: vault://secret/auth-proxy/gdrive/personal#refresh-token
      work:
        client_id: vault://secret/auth-proxy/gdrive/work#client-id
        client_secret: vault://secret/auth-proxy/gdrive/work#client-secret
        refresh_token: vault://secret/auth-proxy/gdrive/work#refresh-token
```

Vault path convention: `secret/auth-proxy/<provider>/<tenant>#<field>`. Codified up-front so server-side and UI work in later PRs don't reinvent it. The `<provider>/<tenant>` shape makes per-tenant ACLs straightforward later.

## Directory layout

Mirror the egress-gateway shape so it's familiar:

```
auth-proxy/
├── CLAUDE.md
├── Dockerfile
├── cmd/
│   └── main.go                  # load config → wire providers → start http server
├── internal/
│   ├── config/
│   │   ├── config.go            # YAML parse, vault:// resolution, validation
│   │   └── config_test.go
│   ├── providers/
│   │   ├── provider.go          # CredentialProvider interface
│   │   ├── static_header.go     # Anthropic, GitHub PAT
│   │   ├── static_header_test.go
│   │   ├── oauth2_refresh.go    # Drive, gws
│   │   └── oauth2_refresh_test.go
│   ├── proxy/
│   │   ├── router.go            # /<provider>/<tenant>/... → (provider, tenant, rest)
│   │   ├── router_test.go
│   │   ├── reverse_proxy.go     # httputil.ReverseProxy + Director hook
│   │   └── reverse_proxy_test.go
│   ├── vault/
│   │   └── client.go            # minimal KV-v2 read; SIGHUP-driven refresh
│   └── log/
│       └── access.go            # JSON access log, never logs auth/body
├── go.mod
└── go.sum
```

Add to root `go.work` alongside `egress-gateway` / `egress-fw-agent` / `egress-shared`. Build wiring: `pnpm build:auth-proxy` script following the same pattern as `pnpm build:egress-gateway`.

## Observability

- `/healthz` (liveness) and `/readyz` (returns 503 until every provider's initial cred load succeeds).
- Structured JSON access log: one line per request — `{ts, route, tenant, upstream_status, latency_ms, bytes_in, bytes_out, provider}`.
- **Never log auth headers, request bodies, or response bodies.** Encoded as a hard rule in `internal/log/access.go`.
- Optional `/metrics` Prometheus endpoint as a follow-up if we want per-provider RPS and refresh failure counters.

## Client wiring

| Stack | Code |
|---|---|
| Anthropic Python SDK | `Anthropic(base_url="http://auth-proxy:8080/anthropic/team-foo", api_key="unused")` |
| Anthropic TS SDK | `new Anthropic({ baseURL: "http://auth-proxy:8080/anthropic/team-foo", apiKey: "unused" })` |
| Octokit (JS) | `new Octokit({ baseUrl: "http://auth-proxy:8080/github/org-acme", auth: "unused" })` |
| go-github | `c := github.NewClient(nil); c.BaseURL, _ = url.Parse("http://auth-proxy:8080/github/org-acme/")` (trailing slash required) |
| Google Drive (Go) | Construct `drive.Service` with `option.WithEndpoint("http://auth-proxy:8080/gdrive/personal")` **and** `option.WithoutAuthentication()` — otherwise the SDK adds its own `Authorization` header |
| Google Drive (Python) | `build("drive", "v3", discoveryServiceUrl=..., http=...)` with a custom `httplib2.Http` whose base URL is overridden — uglier than the others, may justify just using REST directly |
| gws CLI | Point its OAuth token endpoint and API base at the sidecar; same OAuth refresh shape as Drive |

The dummy `apiKey: "unused"` matters: most SDKs refuse to construct without one, but the proxy strips inbound `Authorization` / `x-api-key` before injecting its own, so the value is ignored.

Each app/worker hardcodes (or env-vars) which tenant it's using — that mapping is a deployment concern, not a runtime one. Apps don't need to know about other tenants existing.

## Egress integration

The auth-proxy container is just another container in the env, so its outbound calls hit the egress gateway like everything else. The gateway allowlist needs the upstream hosts (`api.anthropic.com`, `api.github.com`, `uploads.github.com`, `oauth2.googleapis.com`, `www.googleapis.com`). App containers themselves only need to reach `auth-proxy` on the internal network — they should **not** have the upstream hosts on their allowlist.

This gives us a useful property for free: app containers can't bypass the auth-proxy by calling Anthropic directly, because egress will block them.

The allowlist is managed manually by the user — auto-management is explicitly out of scope.

## Request size limits

Anthropic and Drive both legitimately handle large request bodies (image prompts, file uploads). Set `http.Server.MaxHeaderBytes` modestly but **do not** set a body limit on the reverse proxy — let the upstream enforce. Code this with an explicit comment so a future "let's add a 10MB limit for safety" PR doesn't break Drive uploads.

## PR scope

Four PRs, ordered so each is reviewable on its own and value lands progressively. Container first, server integration after — same staging the egress work followed.

### PR 1 — container skeleton + `static_header` provider

In:

- `auth-proxy/` directory, `cmd/main.go`, `internal/config`, `internal/proxy`, `internal/log`, `internal/vault`.
- `static_header` provider only.
- Multi-tenant routing (`/<provider>/<tenant>/...`) wired end-to-end.
- `/healthz` + `/readyz`.
- SIGHUP → reload config + re-resolve vault secrets.
- Dockerfile, `pnpm build:auth-proxy`, `go.work` entry.
- Unit tests for config parse, router, reverse proxy stripping/header replacement, JSON access log redaction.
- `auth-proxy/CLAUDE.md` describing structure + conventions.

Out:

- No OAuth refresh.
- No server-side integration. Run it locally with `docker run -v config.yaml:/etc/auth-proxy/config.yaml ...` and prove Anthropic + GitHub PAT calls work end-to-end.

Right shape for a first PR — proves the bones with the simpler provider so review focuses on architecture, not OAuth semantics.

### PR 2 — `oauth2_refresh` provider

In:

- `oauth2_refresh.go` + tests.
- Per-`(provider, tenant)` access-token cache with single-flight refresh.
- 60s pre-expiry refresh window.
- Refresh-token-revoked failure mode: structured event + `503` with explanatory body.
- Unit tests using `httptest` for the token endpoint, including the single-flight path under concurrent load.

After this lands, the container is feature-complete for v1 and runnable standalone. Drive and gws both work.

### PR 3 — server-side stack template + deployment

In:

- New system stack template `auth-proxy` (scope: Environment) — single service, mounts a generated config file, mounts a Vault token, joins the env's network.
- Server-side service that renders the YAML config from a new `AuthProxyProvider` model (Prisma migration).
- Egress allowlist note in the template description so users know which hosts to add.
- Server triggers a `SIGHUP` to running auth-proxy containers when providers/tenants change (or just bounces the container — simpler, probably fine for v1 since it's stateless).

Out:

- No UI yet. Manage providers via API/seed.

### PR 4 — UI

In:

- "Auth Proxy" page per environment listing providers + tenants.
- Add/edit forms for `static_header` and `oauth2_refresh` shapes, with secrets going to Vault.
- Tenant management within each provider.
- Status indicator per tenant (last-successful-auth, last-refresh-failure for OAuth).
- Optional "test" button per tenant that does a known-cheap call (Anthropic `GET /v1/models`, GitHub `GET /user`, Drive `GET /drive/v3/about`) and reports the result.

## Decisions made during ideation

| Question | Decision |
|---|---|
| MITM at the egress proxy vs separate sidecar? | Separate sidecar. MITM is a much larger blast radius (CA trust, plaintext exposure, future cert-pinning conflicts). |
| One sidecar per provider, or one with multiple upstreams? | One sidecar, multiple upstreams. Three containers per env triples supervision surface without buying isolation that matters. |
| Multi-tenant in v1? | Yes — needed from day one. Path-segment routing. |
| GitHub Apps vs PAT in v1? | PAT only. App support is a separable follow-up once we learn what's actually needed. |
| Auto-manage egress allowlist? | No — manual. Keeps the responsibilities of the auth-proxy and egress gateway cleanly separated. |
| `gws` CLI auth shape? | OAuth2 refresh-token flow (per `taylorskalyo/gws`-style CLI). Covered by `oauth2_refresh` provider, no new code. |
| Service-account JWT (GAM/gcloud) support? | Out of scope for v1. Add a `service_account_jwt` provider later if needed. |

## Open threads to confirm before PR 1

1. **Bounce vs SIGHUP on config change.** v1 spec says SIGHUP. If the container is genuinely stateless (and `oauth2_refresh` rebuilds its token cache from refresh tokens on boot anyway), bouncing is simpler and lets us drop the SIGHUP code path. Worth deciding before writing the reload plumbing.
2. **Where does the auth-proxy stack template live?** New built-in template in the stack-templates seed, same as how the egress gateway is provisioned. Confirm this is the right pattern rather than a hand-crafted stack.
3. **Tenant naming defaults.** Should the UI default a single tenant called `default` so users who don't need multi-tenancy don't have to think about it? Probably yes — keeps the path `…/anthropic/default/…` predictable.
