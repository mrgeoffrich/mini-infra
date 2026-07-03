# Shared Types (`@mini-infra/types`)

The single source of truth for TypeScript types shared between client and server. Importing from here keeps API contracts, Socket.IO event shapes, and domain models consistent across the full stack.

## Structure

```
lib/
├── types/
│   ├── index.ts           # Barrel export — re-exports every domain module
│   ├── api.ts             # REST request/response shapes
│   ├── http.ts             # HttpHeader constants + newCorrelationId() (runtime helper)
│   ├── api-routes.ts       # ApiBase/ApiRoute builders + ALL_API_ROUTES registry (runtime)
│   ├── query-keys.ts       # queryKeys TanStack Query key factory (runtime)
│   ├── auth.ts            # Auth, sessions, API keys
│   ├── permissions.ts     # Permission scopes, presets, and the Permission const map (runtime)
│   ├── containers.ts      # Container, ContainerStatus
│   ├── docker.ts          # Networks, volumes
│   ├── stacks.ts          # Stack, StackDefinition, plan/apply types
│   ├── stack-templates.ts # Template draft/publish types
│   ├── deployments.ts     # Blue/green deployment phases
│   ├── environments.ts    # Environment, network type, scoping
│   ├── services.ts        # Connected services
│   ├── settings.ts        # Settings keys + payloads
│   ├── tls.ts             # Certificate types
│   ├── dns.ts             # Cloudflare DNS records/zones
│   ├── cloudflare.ts      # Cloudflare account/tunnel types
│   ├── azure.ts           # Azure storage types
│   ├── github.ts          # GitHub repo types
│   ├── github-app.ts      # GitHub App install types
│   ├── postgres.ts        # PG backup types
│   ├── registry.ts        # Image registry credential types
│   ├── self-backup.ts     # Mini Infra self-backup types
│   ├── self-update.ts     # Self-update sidecar types
│   ├── monitoring.ts      # Monitoring + connectivity types
│   ├── operations.ts      # OperationStep, generic operation progress
│   ├── user-events.ts     # Audit event types
│   ├── socket-events.ts   # Channel + ServerEvent constants (USE THESE)
│   ├── agent.ts           # Agent sidecar API types
│   ├── egress.ts          # Egress firewall types
│   └── vault.ts           # Vault types
├── package.json
└── tsconfig.json
```

## Build Order

`@mini-infra/types` must be built before client or server compile. The root `pnpm build:lib` (or `pnpm dev` for watch) handles this — don't try to build client/server against a stale `dist/`.

## Commands

```bash
pnpm --filter @mini-infra/types build   # tsc → dist/
pnpm --filter @mini-infra/types dev     # tsc --watch
pnpm --filter @mini-infra/types clean   # rm -rf dist
```

## Conventions

- **This package is not types-only.** Alongside pure type/interface declarations, it ships dependency-free runtime constants and small helpers that both client and server import to avoid duplicating magic strings: `Channel`/`ServerEvent` (`socket-events.ts`), `ApiBase`/`ApiRoute`/`ALL_API_ROUTES` (`api-routes.ts`), `queryKeys` (`query-keys.ts`), `HttpHeader`/`newCorrelationId()` (`http.ts`), `Permission`/`ALL_PERMISSION_SCOPES` (`permissions.ts`), and Socket.IO reconnection/tuning constants. Treat these as first-class exports, not an accident.
- **The load-bearing invariant is zero external runtime dependencies** — check `package.json`: no `dependencies` entry, ever. Every runtime helper here must be implementable with plain TypeScript/JS (no `zod`, `lodash`, etc.). This is what makes the package safe to import from both the Vite client bundle and the Node server without pulling in a second copy of some library, or a dependency one side doesn't otherwise need.
- **Always use `Channel.*` and `ServerEvent.*` constants** from `socket-events.ts` for Socket.IO. Never raw strings.
- **Always use `Permission.*` constants** from `permissions.ts` for permission scopes (`requirePermission()`, `describeRoute()` meta, etc.). Never raw `"resource:action"` strings.
- When adding a new domain module, add it to `index.ts` so it's re-exported.
- When adding a new symbolic-name-to-string-literal map (mirroring `Channel`/`ServerEvent`/`Permission`), back it with a runtime or test-time check that its values equal the authoritative source list (see `assertPermissionCatalogInSync()` in `permissions.ts`) — `as const satisfies Record<string, ...>` alone only checks the *shape*, not that every catalog entry is covered.
