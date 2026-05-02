// ====================
// Service Addon Types
// ====================
//
// The Service Addons framework lets a stack service opt into one or more named
// capabilities (e.g. `tailscale-ssh`, `caddy-auth`) by adding entries to a
// single `addons:` block on its definition. At apply / pool-spawn time the
// render pipeline expands those declarations into rendered
// `StackServiceDefinition`s — synthetic sidecars carrying `synthetic` metadata
// — that flow through the existing reconciler without parallel plumbing.
//
// The runtime (server) consumes these types. The zod manifest schema lives on
// the server because lib/ is type-only.

import type { StackConfigFile, StackServiceDefinition, StackServiceType, SyntheticServiceInfo } from './stacks';

export type { SyntheticServiceInfo };

/**
 * Connected-service prerequisite an addon may declare in its manifest.
 *
 * Listed as a string type rather than narrowing to the existing
 * `services.ts` enum so that future addons (Tailscale, OIDC providers) can
 * grow the set without forcing churn here. The runtime treats this as an
 * opaque tag matched against `ConnectedService.type`.
 */
export type AddonRequiredConnectedService = string;

/**
 * Identity, applicability, and config-shape declaration for an addon.
 *
 * The runtime consumes `id` for registry lookup, `appliesTo` to gate
 * applicability per service type, and `requiresConnectedService` to gate
 * applicability per environment. `kind` controls merge-group behaviour at
 * render time — addons sharing a `kind` collapse into one sidecar via the
 * registered `AddonMergeStrategy`.
 *
 * The zod manifest schema lives in `server/src/services/stack-addons/` so
 * `lib/` stays runtime-dep-free; the runtime stores it on the manifest at
 * registration time.
 */
export interface AddonManifest {
  /** Stable string id, e.g. "tailscale-ssh". */
  id: string;
  /** Optional grouping label. Addons sharing a kind on the same target merge. */
  kind?: string;
  description: string;
  /**
   * Service types this addon supports. The render pipeline rejects an
   * application against a service whose `serviceType` is not in this list.
   */
  appliesTo: StackServiceType[];
  /**
   * Connected-service type that must be configured for this addon to apply.
   * `undefined` means no external service prerequisite (e.g. the no-op test
   * addon used in unit tests).
   */
  requiresConnectedService?: AddonRequiredConnectedService;
}

/**
 * How a sidecar attaches to its target service. The runtime applies the
 * declared mode in step 6 of the render pipeline (§4.4 of the plan).
 *
 * - `peer-on-target-network`: sidecar joins the same Docker network as the
 *   target; reaches the target by service name. Target unchanged. Default for
 *   non-intercepting addons.
 * - `join-target-netns`: sidecar uses `network_mode: service:<target>`. Target
 *   unchanged in shape; sidecar reaches target on 127.0.0.1. For outbound
 *   interceptors and observers.
 * - `own-target-netns`: target's `network_mode` rewritten to
 *   `service:<sidecar>`. Target's published ports stripped (when
 *   `reclaimTargetPorts` is set) and inherited by the sidecar. For
 *   unbypassable ingress gates.
 */
export type AddonNetworkMode =
  | 'peer-on-target-network'
  | 'join-target-netns'
  | 'own-target-netns';

export interface TargetIntegration {
  network: AddonNetworkMode;
  envForTarget?: Record<string, string>;
  mountsForTarget?: NonNullable<StackServiceDefinition['containerConfig']['mounts']>;
  /** Valid only with `own-target-netns`. */
  reclaimTargetPorts?: boolean;
}

/**
 * Per-(service, addon) context handed to `provision()` and
 * `buildServiceDefinition()`. The runtime fills in stack/env/service metadata;
 * `instance` is populated only at pool-instance spawn time.
 *
 * `vault` and `connectedServices` are typed as `unknown` here so `lib/` keeps
 * zero runtime deps — the server narrows them to its concrete service types
 * before invoking the addon hooks.
 */
export interface ProvisionContext {
  stack: { id: string; name: string };
  service: { name: string; type: StackServiceType };
  environment: {
    id: string;
    name: string;
    networkType: 'local' | 'internet';
  };
  /** Already validated against the addon's `configSchema`. */
  addonConfig: unknown;
  /** Present iff this is a pool-instance spawn (Phase 9 of the plan). */
  instance?: { instanceId: string };
  /** VaultClient — narrowed by the server invoker. */
  vault?: unknown;
  /** ConnectedServiceLookup — narrowed by the server invoker. */
  connectedServices?: unknown;
}

/**
 * Output of `provision()`. The runtime threads these into
 * `buildServiceDefinition()` and the target-integration step.
 */
export interface ProvisionedValues {
  envForSidecar?: Record<string, string>;
  /** Merged into `TargetIntegration.envForTarget` on the rendered target. */
  envForTarget?: Record<string, string>;
  /**
   * Files written into the rendered sidecar's config-file mount. Use the
   * existing `StackConfigFile` shape so the rendered sidecar's `configFiles`
   * field is byte-compatible.
   */
  files?: StackConfigFile[];
  /** Available to `buildServiceDefinition()` for interpolation / shaping. */
  templateVars: Record<string, unknown>;
}

/**
 * Status payload returned by an addon's optional `status()` hook. Phase 1
 * does not consume this; the type is declared so `AddonDefinition.status`
 * has a stable signature for later phases.
 */
export interface AddonStatus {
  online: boolean;
  detail?: string;
}

export interface StatusContext {
  stack: { id: string; name: string };
  service: { name: string; type: StackServiceType };
  environment: {
    id: string;
    name: string;
    networkType: 'local' | 'internet';
  };
  instance?: { instanceId: string };
  connectedServices?: unknown;
}

/**
 * What an addon directory exports. The render pipeline consumes:
 *  1. `manifest` — registry lookup + applicability gating.
 *  2. `targetIntegration` — how the sidecar binds to its target.
 *  3. `provision()` — credential minting + per-application value computation.
 *  4. `buildServiceDefinition()` — the rendered sidecar.
 *  5. `cleanup()` — invoked on instance reap (Phase 9) / addon removal.
 *  6. `status()` — Connect-panel live status (Phase 5).
 */
export interface AddonDefinition {
  manifest: AddonManifest;
  targetIntegration: TargetIntegration;
  provision(ctx: ProvisionContext): Promise<ProvisionedValues>;
  buildServiceDefinition(
    ctx: ProvisionContext,
    provisioned: ProvisionedValues,
  ): StackServiceDefinition;
  cleanup?(ctx: ProvisionContext, provisioned: ProvisionedValues): Promise<void>;
  status?(ctx: StatusContext): Promise<AddonStatus>;
}

/**
 * Strategy for collapsing multiple same-`kind` addons on one service into a
 * single sidecar definition. Registered per kind alongside the addons that
 * share it.
 */
export interface AddonMergeStrategy {
  kind: string;
  /** Single integration applied to the merged group. */
  targetIntegration: TargetIntegration;
  provision(
    ctx: ProvisionContext,
    members: Array<{ addonId: string; config: unknown }>,
  ): Promise<ProvisionedValues>;
  buildServiceDefinition(
    ctx: ProvisionContext,
    provisioned: ProvisionedValues,
    members: Array<{ addonId: string; config: unknown }>,
  ): StackServiceDefinition;
}

// `SyntheticServiceInfo` is declared in `./stacks` (next to
// `StackServiceDefinition`) and re-exported above so the back-ref doesn't
// create a circular dependency between stacks.ts and addons.ts.
