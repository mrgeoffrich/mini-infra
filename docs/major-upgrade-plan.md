# Major Dependency Upgrade Plan

Generated: 2026-04-12

Minor/patch upgrades can be applied with `ncu -u --reject <major-packages>` + `npm install` and are low-risk.
This doc covers only **major version bumps** that need investigation before applying.

> **Do not upgrade `@modyfi/vite-plugin-yaml` past 1.0.2** — versions ≥1.0.3 bundle a vulnerable js-yaml (prototype pollution). Pinned via `overrides` in root `package.json`.

---

## Summary Table

| Package | Current | Latest | Effort | Risk |
|---------|---------|--------|--------|------|
| [TypeScript](#typescript-5--6) | ~5.8 | ~6.0 | Medium | Medium |
| [ESLint](#eslint-9--10) | ^9.x | ^10.x | Low | Low |
| [Prisma](#prisma-6--7) | ^6.x | ^7.x | High | High |
| [Recharts](#recharts-2--3) | ^2.x | ^3.x | Medium | Medium |
| [cloudflare SDK](#cloudflare-sdk-4--5) | ^4.x | ^5.x | Low | Medium |
| [cuid2](#paralleldrivecuid2-2--3) | ^2.x | ^3.x | Low | Low |
| [pino + pino-http + pino-roll](#pino-9--10-pino-http-10--11-pino-roll-3--4) | 9/10/3 | 10/11/4 | Low | Low |
| [eslint-plugin-react-hooks](#eslint-plugin-react-hooks-5--7) | ^5.x | ^7.x | Low | Low |
| [globals](#globals-16--17) | ^16.x | ^17.x | Low | Low |
| [@types/dockerode](#typesdockeroode-3--4) | ^3.x | ^4.x | Low | Low |

---

## TypeScript 5 → 6

**Packages:** `typescript` in `client/`, `server/`, `lib/`

### Breaking Changes

- **`strict` mode is ON by default** — enables `strictNullChecks`, `noImplicitAny`, `strictPropertyInitialization`, etc. Any project that relied on these being off will get new errors.
- **`types: []` is empty by default** — TS no longer auto-includes `@types/*` packages. Must explicitly declare: `"types": ["node"]` etc. in tsconfig.
- **`moduleResolution: classic` removed** — must use `nodenext` or `bundler`.
- **`target: es5` removed** — minimum is ES2015.
- **`module` defaults to `esnext`** (was `commonjs`).
- **`target` defaults to `es2025`**.
- **`esModuleInterop`/`allowSyntheticDefaultImports` always `true`** — cannot be disabled.
- **`module Foo {}` syntax now errors** — must use `namespace Foo {}`.

### Migration Steps

1. Run `npx @andrewbranch/ts5to6` — automated migration tool for mechanical changes.
2. Update all `tsconfig.json` files:
   - Add explicit `"types"` array (e.g., `["node"]` for server, `["vite/client"]` for client).
   - Verify `moduleResolution` is `"bundler"` (client) or `"nodenext"` (server/lib).
   - Remove any `target: es5` references.
3. Run `npx tsc --noEmit` in each workspace and fix strict-mode errors.
4. Use `"ignoreDeprecations": "6.0"` temporarily to suppress deprecation warnings while working through errors.

---

## ESLint 9 → 10

**Packages:** `eslint`, `@eslint/js`, `typescript-eslint`, `globals` in `client/` and `server/`

### Breaking Changes

- **Legacy `.eslintrc*` format completely removed** — both projects already use `eslint.config.js` flat config (ESLint 9 introduced this), so this should be a no-op.
- **`FlatESLint` and `LegacyESLint` classes removed** — use only `ESLint` class.
- **Node.js ≥20.19, ≥22.13, or ≥24 required** — we're on v24.13.0, so fine.
- **Three new rules added to `eslint:recommended`:**
  - `no-unassigned-vars`
  - `no-useless-assignment`
  - `preserve-caught-error`
- **JSX scope analysis improved** — may surface new lint errors in JSX files.

### Migration Steps

1. Upgrade `eslint` and `@eslint/js` to `^10.x`.
2. Run `npm run lint -w client` and `npm run lint -w server`; fix any new rule violations or explicitly disable new rules in config.
3. Check JSX files for new scope-analysis errors.

---

## Prisma 6 → 7

**Packages:** `prisma`, `@prisma/client` in `server/`

### Breaking Changes — HIGH IMPACT

- **ESM-only** — Prisma 7 drops CommonJS support. Server must be configured for ESM (`"type": "module"` or `"module": "ESNext"` in tsconfig).
- **Generator provider changed** — `provider = "prisma-client-js"` → `provider = "prisma-client"`.
- **`output` field now mandatory** — client no longer generates into `node_modules` by default. Must specify output path in schema.
- **Explicit driver adapter required** — must install and pass `@prisma/adapter-pg` (for PostgreSQL) to `new PrismaClient()`.
- **Datasource `url` moved out of schema** — database URL now lives in `prisma.config.ts` at the project root, not in `schema.prisma`.
- **`$use()` middleware removed** — replace with Client Extensions.
- **Auto-seeding removed** — `prisma migrate dev`/`prisma migrate reset` no longer run seeds automatically; must call `npx prisma db seed` manually.
- **Node.js ≥20.19 required** — fine on v24.

### Migration Steps

1. Install `@prisma/adapter-pg` and update `@prisma/client`/`prisma` to `^7.x`.
2. Update `schema.prisma`:
   - Change `provider = "prisma-client-js"` → `provider = "prisma-client"`.
   - Add `output` field pointing to a local path (e.g., `output = "../node_modules/.prisma/client"`).
   - Remove `url` from datasource block.
3. Create `prisma.config.ts` at project root with the database URL and schema/migration paths.
4. Update all `new PrismaClient()` calls to pass the adapter instance.
5. Replace any `prisma.$use()` middleware with Client Extensions.
6. Update deployment/CI scripts to call `npx prisma db seed` explicitly after migrations.
7. Configure server TypeScript/build for ESM output.

> **Recommendation:** Do this as a dedicated PR with careful testing. Check the [official v7 upgrade guide](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions).

---

## Recharts 2 → 3

**Packages:** `recharts` in `client/`

### Breaking Changes

- **Internal state props removed** — `activeIndex` and similar internal state props are no longer accessible from outside components.
- **`CategoricalChartState` no longer available** in event handlers or `Customized` components.
- **`accessibilityLayer` now defaults to `true`** (was `false`) — may change visual/DOM structure of charts.
- **Keyboard events no longer passed through `onMouseMove`** callback.
- **`recharts-scale` dependency removed** — functionality moved in-house.
- **Custom components no longer require `Customized` wrapper** (now optional).

### Migration Steps

1. Audit all chart components for access to internal state — replace with new React hooks provided by Recharts 3.
2. For multi-axis charts using `Tooltip`, use the new `axisId` prop.
3. Set Y-axis width with `width="auto"` instead of margin manipulation.
4. Test accessibility output — `accessibilityLayer` is now on by default.
5. See the [Recharts 3.0 migration guide](https://github.com/recharts/recharts/wiki/3.0-migration-guide).

---

## cloudflare SDK 4 → 5

**Packages:** `cloudflare` in `server/`

### Breaking Changes

- **DNS record type names shortened** — verbose class names replaced with abbreviations:
  - `ARecord` → `A`, `AAAARecord` → `AAAA`, etc.
- **Zero Trust Tunnel response types removed** — `CloudflaredCreateResponse`, `CloudflaredListResponse`, `CloudflaredDeleteResponse`, `CloudflaredEditResponse`, `CloudflaredGetResponse`, `CloudflaredListResponsesV4PagePaginationArray` all gone.
- **IAM restructured** — resource groups, roles, and permissions have new parameter shapes.
- **Some previously-optional fields became required** across multiple services.
- **Workers `TailConsumer` binding type removed.**

### Migration Steps

1. Search for all `cloudflare` SDK usages in `server/src/` — focus on DNS record types and tunnel operations.
2. Update DNS type references from verbose to abbreviated names.
3. Update tunnel API calls — remove references to deleted response type classes; use inferred types or `any` temporarily, then tighten.
4. Check for optional→required parameter changes by running `tsc --noEmit` after upgrade.

---

## @paralleldrive/cuid2 2 → 3

**Packages:** `@paralleldrive/cuid2` in `server/`

### Breaking Changes

- **ESM-only** — no more `require('@paralleldrive/cuid2')`. Must use `import`.
- **`isCuid()` validation stricter** — first character must now be `a-z` (not `0-9`).

### Migration Steps

1. Find all `require('@paralleldrive/cuid2')` calls and convert to `import`.
2. Check if any tests or code validates existing CUIDs — if so, review against new validation rules.
3. If server is CommonJS-only at the time of upgrade, coordinate with the ESM migration for Prisma 7.

---

## pino 9 → 10, pino-http 10 → 11, pino-roll 3 → 4

**Packages:** `pino`, `pino-http`, `pino-roll` in `server/`

### Breaking Changes

- **Node.js ≥19 required** — we're on v24, so fine.
- `pino-http` v11 and `pino-roll` v4 are compatibility releases for pino v10 with no documented API-level changes.

### Migration Steps

Upgrade all three together. Run the server and check log output is formatted correctly. No code changes expected.

---

## eslint-plugin-react-hooks 5 → 7

**Packages:** `eslint-plugin-react-hooks` in `client/`

### Breaking Changes

- **Config preset restructured:**
  - `recommended` now uses flat config format by default.
  - Legacy config moved to `recommended-legacy`.
  - `flat/recommended` and `recommended-latest-legacy` presets deleted.
- **New validation rules:**
  - Disallows calling `use` within try/catch blocks.
  - Disallows calling `useEffectEvent` functions in arbitrary closures.
- **Node.js ≥18 required** — fine.

### Migration Steps

1. Update `eslint.config.js` in `client/` to reference the new preset name if using `flat/recommended`.
2. Run lint and address any new `use`/`useEffectEvent` violations.

---

## globals 16 → 17

**Packages:** `globals` in `client/` and `server/` (ESLint config)

### Breaking Changes

- **`audioWorklet` split out of `browser`** — now a separate standalone environment. If ESLint config includes `browser` globals and expects audio worklet globals, add `audioWorklet` explicitly.

### Migration Steps

Check `eslint.config.js` in `client/` and `server/` — if either uses `globals.browser` and relies on audio worklet globals, add `globals.audioWorklet`. Otherwise, this is a drop-in upgrade.

---

## @types/dockerode 3 → 4

**Packages:** `@types/dockerode` in `server/`

### Breaking Changes

Updated to match dockerode v4.x API. Specific type signature changes are not well-documented.

### Migration Steps

Upgrade and run `npx tsc --noEmit -w server` to surface any type errors. Fix as needed.

---

## Suggested Upgrade Order

Given the inter-dependencies (ESM, TypeScript strictness), suggest tackling in this order:

1. **Low-risk first** (one PR): pino stack, eslint-plugin-react-hooks, globals, cuid2, @types/dockerode, @types/config, @types/supertest, xstate, all remaining minor/patch bumps
2. **ESLint 10 + TypeScript 6** (one PR): coordinate across all three workspaces; run linter + `tsc --noEmit` and fix errors
3. **cloudflare SDK 5** (one PR): focused on the cloudflare service layer
4. **Recharts 3** (one PR): focused on chart components in client
5. **Prisma 7** (dedicated PR with careful testing): ESM migration, config restructure, adapter wiring
