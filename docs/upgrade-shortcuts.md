# Upgrade Shortcuts & Known Issues

Generated during: `chore/major-dependency-upgrades` PR (2026-04-12)
Updated: 2026-04-12 — all shortcuts resolved except `no-explicit-any` warnings.

This document records shortcuts taken during the ESLint 10, globals, cloudflare SDK, and Recharts upgrades.

---

## 1. ESLint 10 — New rules disabled in server ✅ RESOLVED

`preserve-caught-error` and `no-useless-assignment` are now enforced. All violations fixed.

---

## 2. typescript-eslint 8.58 severity changes — `no-explicit-any` ⚠️ TODO (warning only)

**`@typescript-eslint/no-explicit-any`** — 743 warnings in server, 81 in client.

These remain as **warnings** (default severity in the installed tseslint version), so they don't block lint. Fixing them out requires proper typing work on a case-by-case basis — a separate dedicated PR.

**`@typescript-eslint/no-empty-object-type`** ✅ RESOLVED — all 3 violations fixed.

---

## 3. react-hooks v7 new rules ✅ RESOLVED

All 31 violations across 22 files fixed. The `set-state-in-effect`, `purity`, `preserve-manual-memoization`, `immutability`, and `refs` rules are now enforced in `client/eslint.config.js`.

Notable patterns applied:
- **`set-state-in-effect`**: derived state during render, lazy `useState` initializers, `useEffectEvent` for event-like effects, `useSyncExternalStore` for external-subscription mirroring (`use-socket.ts`), dialog-gate splitting (`{open && <Inner/>}`) for forms.
- **`purity`**: hoisted pure helpers to module scope; replaced impure `useMemo(() => Date.now()/Math.random())` with lazy `useState` + derived-state-reset keyed on stable inputs.
- **`immutability`**: reordered declarations; broke self-referential `useCallback` via a ref + sync effect.
- **`preserve-manual-memoization`**: removed manual `useMemo`s that the React Compiler can inline.
- **`refs`**: converted render-time ref reads to state.

See PR diff for per-file details.

---

## 4. Pre-existing lint errors ✅ RESOLVED

All 134 pre-existing server errors and 18 pre-existing client errors have been fixed.

---

## 5. ESLint 10 — preserve-caught-error client ✅ RESOLVED

Both violations fixed.

---

## Remaining follow-up

Only `@typescript-eslint/no-explicit-any` remains (as warnings). Consider a dedicated typing cleanup PR to tighten these.
