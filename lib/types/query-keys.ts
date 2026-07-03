import type { ContainerQueryParams } from "./containers";

// ====================
// TanStack Query Key Factory
// ====================
//
// The single source of truth for TanStack Query `queryKey` arrays, shared
// between every client hook that reads or invalidates a given resource.
// Mirrors the house idiom in `socket-events.ts` / `api-routes.ts`: `as const`
// value/builder maps grouped by resource, with parameterized builders for
// keys that vary by filter/id.
//
// - Each resource group starts with `all` — the bare, un-parameterized key
//   used for broad invalidation. TanStack's default `invalidateQueries`
//   match is a prefix match, so
//   `invalidateQueries({ queryKey: queryKeys.containers.all })` also matches
//   every narrower key for that resource (e.g. `queryKeys.containers.list(params)`).
// - Narrower builders (`list`, `detail`, etc.) extend `all` with additional
//   segments. Once other call sites depend on a key's shape, never
//   restructure it in place — add a new builder instead.
//
// Only the `containers` group is built out (Phase 3's reference
// implementation, mirrored by `client/src/hooks/useContainers.ts`). These
// keys are byte-identical to the raw arrays `useContainers` used to
// construct inline (`["containers"]` / `["containers", queryParams]`), so
// every other call site across the app that still invalidates
// `["containers"]` by hand (e.g. `use-container-actions.ts`,
// `use-connect-container.ts`, `task-type-registry.ts`) keeps matching by
// prefix. Phase 4 grows this per-resource as it migrates the other inline
// `queryKey` call sites — follow the `containers` shape (root `all` +
// additive narrower builders) when adding a new group.

export const queryKeys = {
  containers: {
    /** Root key for the containers resource — matches every narrower containers key by prefix. */
    all: ["containers"] as const,
    /** List query key — one cache entry per distinct `queryParams` value. */
    list: (params: ContainerQueryParams) => ["containers", params] as const,
  },
} as const;
