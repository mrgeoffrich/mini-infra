# Shared Types (`@mini-infra/types`)

The single source of truth for TypeScript types shared between client and server. Importing from here keeps API contracts, Socket.IO event shapes, and domain models consistent across the full stack.

## Structure

```
lib/
├── types/
│   ├── index.ts           # Barrel export — re-exports every domain module
│   ├── api.ts             # REST request/response shapes
│   ├── auth.ts            # Auth, sessions, API keys
│   ├── permissions.ts     # Permission scopes + presets
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

- **Always use `Channel.*` and `ServerEvent.*` constants** from `socket-events.ts` for Socket.IO. Never raw strings.
- **No runtime dependencies.** This package is types-only — keep it that way.
- **No business logic.** Pure type/interface declarations and constant enums only.
- When adding a new domain module, add it to `index.ts` so it's re-exported.
