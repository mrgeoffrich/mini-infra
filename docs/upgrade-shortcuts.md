# Upgrade Shortcuts & Known Issues

Generated during: `chore/major-dependency-upgrades` PR (2026-04-12)

This document records shortcuts taken during the ESLint 10, globals, cloudflare SDK, and Recharts upgrades. Each item is a TODO for a follow-up cleanup PR.

---

## 1. ESLint 10 — New rules disabled in server

**File:** `server/eslint.config.js`

**Rules disabled:**
- `preserve-caught-error` — 67 violations (catch blocks that re-throw without `{ cause: e }`)
- `no-useless-assignment` — 9 violations (variables assigned but never read before reassignment)

**Why:** Too many pre-existing violations to fix in the upgrade PR. These are real code quality issues.

**Fix:** Sweep through server `src/` for `catch` blocks and update thrown errors to use `new Error('msg', { cause: e })`. Remove or fix the useless assignments.

---

## 2. typescript-eslint 8.58 severity changes — downgraded back to pre-upgrade state

**Files:** `server/eslint.config.js`, `client/eslint.config.js`

**Rules overridden:**
- `@typescript-eslint/no-explicit-any`: `error` → `warn` (both workspaces)
- `@typescript-eslint/no-empty-object-type`: `error` → `warn` (both workspaces)

**Why:** typescript-eslint 8.58 changed these from `warn` to `error` in the recommended config. Restoring to `warn` maintains the pre-upgrade lint baseline so the upgrade PR doesn't introduce 80+ new blocking errors.

**Fix:** Fix all `any` usages (client has ~81, server has ~many) and `{}` type usages (~3 server). Then remove the overrides to let the recommended config apply.

---

## 3. react-hooks v7 new rules — disabled in client

**File:** `client/eslint.config.js`

**Rules disabled:**
- `react-hooks/set-state-in-effect` — calling `setState` synchronously in `useEffect` bodies (~6 violations)
- `react-hooks/purity` — calling impure functions during render (~3 violations)
- `react-hooks/preserve-manual-memoization` — React Compiler: existing memoization couldn't be preserved (~3 violations)
- `react-hooks/immutability` — accessing variables before declaration (React Compiler rule) (~3 violations)
- `react-hooks/refs` — accessing refs during render (~2 violations)

**Why:** These rules were activated because the config was migrated from the legacy plugin format (`configs["recommended-latest"]`) to the proper flat config format (`configs.flat["recommended-latest"]`). The legacy format was silently not enforcing these rules in ESLint 9; fixing the format for ESLint 10 compatibility surfaced them.

**Fix:** Review each violation:
- `set-state-in-effect`: Restructure effects to avoid synchronous `setState` calls. See [React docs on effects](https://react.dev/learn/you-might-not-need-an-effect).
- `purity`, `immutability`, `refs`: These are React Compiler compatibility rules. May require restructuring render logic.

---

## 4. Pre-existing lint errors — not fixed in upgrade PR

The following pre-existing lint errors exist in both workspaces but were not introduced by this upgrade. They were already present with ESLint 9 + typescript-eslint 8.41 (lint was not enforced in CI).

**Server (~134 errors):**
- 115 × `@typescript-eslint/no-unused-vars` — unused imports and variables across 50+ route/service files
- 8 × `no-useless-escape` — unnecessary escape characters in regexes
- 3 × `no-empty` — empty catch/if blocks
- 2 × `@typescript-eslint/no-require-imports` — `require()` calls in `config-new.ts`
- 1 × `no-control-regex` — control character in regex
- 1 × `@typescript-eslint/no-namespace` — namespace usage in service-error-mapper.ts

**Client (~18 errors):**
- 15 × `@typescript-eslint/no-unused-vars` — unused catch bindings and variables
- 1 × `react-hooks/rules-of-hooks` — hook called in non-component function
- 1 × `no-extra-boolean-cast` — redundant `Boolean()` call
- 1 × `no-control-regex` — control character in regex

**Fix:** Address in a dedicated "lint cleanup" PR. Server unused vars are the largest task — many are unused type imports in route files that can simply be removed.

---

## 5. ESLint 10 — preserve-caught-error disabled in client

**File:** `client/eslint.config.js`

**Rule disabled:** `preserve-caught-error` — 2 violations in client

**Fix:** Find catch blocks in client that re-throw without `{ cause: e }` and add it.
