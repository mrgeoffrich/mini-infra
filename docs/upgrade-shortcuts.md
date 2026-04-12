# Upgrade Shortcuts & Known Issues

Generated during: `chore/major-dependency-upgrades` PR (2026-04-12)
Updated: 2026-04-12 — mechanical shortcuts cleared; react-hooks v7 + `no-explicit-any` remain.

This document records shortcuts taken during the ESLint 10, globals, cloudflare SDK, and Recharts upgrades.

---

## 1. ESLint 10 — New rules disabled in server ✅ RESOLVED

Previously disabled `preserve-caught-error` and `no-useless-assignment` have been re-enabled and all violations fixed. The config overrides have been removed from `server/eslint.config.js`.

---

## 2. typescript-eslint 8.58 severity changes

**`@typescript-eslint/no-explicit-any`** — 743 warnings in server, 81 in client.

These remain as **warnings** (default severity in the installed tseslint version), so they don't block lint. Fixing them out requires proper typing work on a case-by-case basis — a separate dedicated PR.

**`@typescript-eslint/no-empty-object-type`** ✅ RESOLVED — all 3 violations fixed (`Record<string, {}>` → `Record<string, Record<string, never>>`, and `Constructor<T = {}>` → `Constructor<T = object>`).

---

## 3. react-hooks v7 new rules — still disabled in client ⚠️ TODO

**File:** `client/eslint.config.js`

**Rules currently causing 31 errors across 22 files:**
- `react-hooks/set-state-in-effect` (14) — synchronous `setState` calls inside `useEffect`
- `react-hooks/purity` (11) — impure function calls during render
- `react-hooks/preserve-manual-memoization` (3) — React Compiler cannot preserve existing memoization
- `react-hooks/immutability` (3) — variable accessed before declaration

**Affected files:**
- `app/api-keys/new/page.tsx`, `app/certificates/[id]/page.tsx`, `app/certificates/page.tsx`
- `app/login/page.tsx`, `app/logs/LogControls.tsx`, `app/postgres/restore/page.tsx`
- `app/settings/authentication/page.tsx`, `app/setup/page.tsx`
- `components/agent/agent-chat-messages.tsx`, `components/api-keys/preset-form-dialog.tsx`
- `components/cloudflare/tunnel-status.tsx`, `components/haproxy/migrate-haproxy-dialog.tsx`
- `components/haproxy/ssl-certificate-select.tsx`, `components/help/HelpSearchBar.tsx`
- `components/postgres-server/grant-editor.tsx`, `components/stacks/StackParametersDialog.tsx`
- `components/stacks/StackPlanView.tsx`, `components/ui/sidebar.tsx`
- `hooks/use-formatted-date.ts`, `hooks/use-settings-validation.ts`
- `hooks/use-socket.ts`, `hooks/use-volumes.ts`

**Why still deferred:** These are not mechanical fixes. Each violation requires restructuring component/hook logic (effects that avoid synchronous `setState`, pure render paths, fixing hoisting order for React Compiler compatibility). Needs care per site.

**Fix:** Dedicated PR, review each violation:
- `set-state-in-effect`: Restructure effects. See [React docs on effects](https://react.dev/learn/you-might-not-need-an-effect).
- `purity`, `immutability`, `preserve-manual-memoization`: React Compiler compatibility rules — may require restructuring render logic.

The rules are currently disabled in `client/eslint.config.js`.

---

## 4. Pre-existing lint errors ✅ RESOLVED

All 134 pre-existing server errors and 18 pre-existing client errors have been fixed, including:
- `@typescript-eslint/no-unused-vars` — removed unused imports/vars, converted `catch (err)` → `catch` where binding was unused
- `no-useless-escape`, `no-empty`, `no-control-regex` — fixed or scoped disable-comments with rationale
- `@typescript-eslint/no-require-imports` — converted `require()` to ES `import` in `config-new.ts`
- `@typescript-eslint/no-namespace` — module augmentation in `middleware/validation.ts` kept with scoped disable comment (Express type extension requires namespace idiom)
- `no-extra-boolean-cast` — removed redundant `Boolean()` wrapper
- `react-hooks/rules-of-hooks` — refactored `createMutation` helper in `use-container-actions.ts` so `useMutation` is called at top level

---

## 5. ESLint 10 — preserve-caught-error client ✅ RESOLVED

Both violations fixed — errors now include `{ cause: error }`.
