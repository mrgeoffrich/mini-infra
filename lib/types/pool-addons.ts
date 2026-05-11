// ====================
// Pool Addon Types
// ====================
//
// Per-instance addon sidecars (Phase 6 of Service Addons) carry a small set
// of labels that let the reaper find and clean them up, and let the
// Containers page render them with the right context. The keys live here so
// the server-side spawner / reaper and the client-side container label
// rendering reference the same string constants — and so a future label
// rename is a one-line edit.

/**
 * Docker container labels stamped on every per-pool-instance addon sidecar.
 *
 * `STACK_ID` + `SERVICE` mirror the labels on the worker container itself —
 * a reaper sweep keyed on (stack-id, service, pool-instance-id) catches the
 * worker and all of its addon sidecars in one query.
 *
 * `POOL_INSTANCE_ID` is the per-spawn join key. `ADDON` carries the addon's
 * `id` (e.g. `tailscale-ssh`) for solo applications and the merge `kind`
 * (e.g. `tailscale`) for merged groups, so a Containers-page filter on a
 * specific addon kind selects the right rows without consulting the registry.
 *
 * `SYNTHETIC` matches the existing static-service sidecar marker so any
 * reconciler/UI code that already treats `synthetic=true` rows specially
 * (e.g. dimming them on the Connect panel) picks up pool-instance sidecars
 * uniformly.
 */
export const POOL_ADDON_LABELS = {
  /** Stack id this sidecar belongs to. */
  STACK_ID: "mini-infra.stack-id",
  /** Authored pool service this sidecar attaches to. */
  SERVICE: "mini-infra.service",
  /** Per-instance id (matches the worker's `mini-infra.pool-instance-id`). */
  POOL_INSTANCE_ID: "mini-infra.pool-instance-id",
  /** Addon id (solo) or merge kind label. */
  ADDON: "mini-infra.addon",
  /** Synthetic-marker shared with static addon sidecars. */
  SYNTHETIC: "mini-infra.synthetic",
  /** Authored target service the sidecar wraps — same key the static path uses. */
  ADDON_TARGET: "mini-infra.addon-target",
} as const;

export type PoolAddonLabelKey =
  (typeof POOL_ADDON_LABELS)[keyof typeof POOL_ADDON_LABELS];
