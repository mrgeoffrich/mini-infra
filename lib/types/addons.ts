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
 * How an addon attaches its provisioned outputs to its target service.
 *
 * - `sidecar` (default): the addon materialises a synthetic peer service
 *   alongside the target via `buildServiceDefinition()`. The synthetic
 *   `StackServiceDefinition` carries the env / mounts / requiredEgress the
 *   addon needs and is appended to the rendered services list. Target may
 *   still be touched via the `TargetIntegration` (env / mounts / network
 *   mode) as before.
 * - `env-injection`: the addon does NOT materialise a sidecar. Its
 *   provisioned `envForTarget` / `mountsForTarget` / `labelsForTarget` /
 *   `requiredEgress` are merged directly onto the target service's
 *   `containerConfig` and the target picks up a `mini-infra.addon: <id>`
 *   label for downstream endpoint-discovery. Used when the target image
 *   itself runs the agent the addon would otherwise sidecar (e.g. the
 *   `claude-shell` image bakes `tailscaled` into the workload container).
 */
export type AddonMode = 'sidecar' | 'env-injection';

/**
 * Identity, applicability, and config-shape declaration for an addon.
 *
 * The runtime consumes `id` for registry lookup, `appliesTo` to gate
 * applicability per service type, and `requiresConnectedService` to gate
 * applicability per environment. `kind` controls merge-group behaviour at
 * render time — addons sharing a `kind` collapse into one sidecar via the
 * registered `AddonMergeStrategy`. `mode` selects the attachment shape (see
 * `AddonMode`).
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
  /**
   * Attachment mode. When omitted, defaults to `'sidecar'` to preserve the
   * Phase-1 contract for existing addons (`tailscale-ssh`, `tailscale-web`).
   * Env-injection addons must set `'env-injection'` explicitly and return
   * the matching `ProvisionedValues` shape from `provision()`.
   */
  mode?: AddonMode;
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
 * Container-config mount shape (re-exported as a convenience for addons that
 * need to declare mount lists on env-injection outputs). Pulled from
 * `StackServiceDefinition.containerConfig.mounts` so addon code can't drift
 * from the reconciler's shape.
 */
export type AddonMount = NonNullable<
  StackServiceDefinition['containerConfig']['mounts']
>[number];

/**
 * Output shape returned by a `mode: 'sidecar'` addon's `provision()`. The
 * runtime threads these into `buildServiceDefinition()` and the
 * target-integration step.
 *
 * `mode: 'sidecar'` is a discriminant so consumers can narrow safely; it is
 * optional on input to preserve back-compat with Phase-1 addons that didn't
 * carry the discriminant.
 */
export interface SidecarProvisionedValues {
  mode?: 'sidecar';
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
 * Output shape returned by a `mode: 'env-injection'` addon's `provision()`.
 *
 * The runtime merges these onto the target service directly — no synthetic
 * sidecar is materialised. The `mode` discriminant is **required** so the
 * render pipeline can distinguish this shape from the legacy sidecar shape
 * at runtime (TypeScript narrowing falls through to a runtime check when
 * the addon's manifest is the source of truth for which shape was returned).
 */
export interface EnvInjectionProvisionedValues {
  mode: 'env-injection';
  /**
   * Environment variables merged into the target's `containerConfig.env`.
   * Key collisions with existing target env are a hard error — addons must
   * not silently overwrite operator-authored env vars.
   */
  envForTarget?: Record<string, string>;
  /**
   * Mounts appended to the target's `containerConfig.mounts`.
   */
  mountsForTarget?: AddonMount[];
  /**
   * Labels merged into the target's `containerConfig.labels`. The framework
   * additionally writes `mini-infra.addon: <addon-id>` so endpoint
   * discovery can find env-injection addons without scanning manifests.
   */
  labelsForTarget?: Record<string, string>;
  /**
   * Required egress hostnames merged into the target's
   * `containerConfig.requiredEgress` so the env's egress-firewall reconciler
   * picks them up identically to sidecar-mode addons.
   */
  requiredEgress?: string[];
  /**
   * Linux capabilities (e.g. `NET_ADMIN`, `SYS_MODULE`) appended to the
   * target's `containerConfig.capAdd`. Required when the target image runs
   * an agent that the addon would otherwise sidecar — e.g. the
   * `claude-shell` image runs `tailscaled` in-process and therefore needs
   * the same `NET_ADMIN` + `SYS_MODULE` caps a `tailscale-ssh` sidecar
   * would have carried. Deduped against any caps the operator already
   * declared on the target.
   */
  capAddForTarget?: string[];
  /**
   * Device specs (e.g. `/dev/net/tun`) appended to the target's
   * `containerConfig.devices`. Same precedent as `capAddForTarget` — the
   * env-injection mode exists so the target image can run the agent
   * directly, which in turn requires whatever host devices the agent
   * needs at runtime. Deduped against any devices the operator already
   * declared on the target.
   */
  devicesForTarget?: string[];
  /** Available for downstream interpolation; unused by the framework. */
  templateVars?: Record<string, unknown>;
}

/**
 * Output of `provision()` — discriminated union over `mode`. The runtime
 * branches on the `mode` field (or on the manifest's `mode`, which is the
 * authoritative source when the addon's `provision()` omits the discriminant
 * — i.e. existing Phase-1 sidecar addons whose return shape predates this
 * union).
 */
export type ProvisionedValues =
  | SidecarProvisionedValues
  | EnvInjectionProvisionedValues;

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
 * Sidecar-mode addon contract. The render pipeline consumes:
 *  1. `manifest` — registry lookup + applicability gating; `mode` is
 *     `'sidecar'` or omitted.
 *  2. `targetIntegration` — how the sidecar binds to its target.
 *  3. `provision()` — credential minting + per-application value computation.
 *  4. `buildServiceDefinition()` — the rendered sidecar.
 *  5. `cleanup()` — invoked on instance reap (Phase 9) / addon removal.
 *  6. `status()` — Connect-panel live status (Phase 5).
 */
export interface SidecarAddonDefinition {
  manifest: AddonManifest & { mode?: 'sidecar' };
  targetIntegration: TargetIntegration;
  provision(ctx: ProvisionContext): Promise<SidecarProvisionedValues>;
  buildServiceDefinition(
    ctx: ProvisionContext,
    provisioned: SidecarProvisionedValues,
  ): StackServiceDefinition;
  cleanup?(
    ctx: ProvisionContext,
    provisioned: SidecarProvisionedValues,
  ): Promise<void>;
  status?(ctx: StatusContext): Promise<AddonStatus>;
  /**
   * Read-only synthetic-service skeleton used at plan time. Must be
   * deterministic — the same `(stack, service, addonConfig)` triple produces
   * byte-identical output. Returned definition stands in for what
   * `buildServiceDefinition()` would produce after `provision()` ran, but
   * with non-deterministic per-mint values (authkeys, hostnames derived from
   * runtime state) excluded so plan-time hashes don't drift between runs.
   *
   * When omitted, the framework substitutes a generic placeholder
   * (`dockerImage: 'addon-pending'`); addons that want plan-time identity to
   * reflect their real image / mounts / requiredEgress should implement this.
   */
  planStub?(ctx: ProvisionContext): StackServiceDefinition;
}

/**
 * Static subset of `EnvInjectionProvisionedValues` that an addon can compute
 * synchronously at plan time without running `provision()`. Excludes
 * `envForTarget` and `templateVars` because those typically depend on
 * minted secrets / dynamic values that we explicitly do not want to compute
 * in the dryRun path. The remaining fields — `requiredEgress`, mounts,
 * caps, devices, labels — are static per-addon (or computable purely from
 * `ProvisionContext` without side effects), and the render pipeline merges
 * them onto the target in dryRun mode so plan-time consumers (e.g. the
 * egress-rule reconciler) see the same hostnames / mounts / caps / devices
 * the apply path would write.
 */
export type EnvInjectionPlanStubValues = Pick<
  EnvInjectionProvisionedValues,
  | 'requiredEgress'
  | 'mountsForTarget'
  | 'capAddForTarget'
  | 'devicesForTarget'
  | 'labelsForTarget'
>;

/**
 * Env-injection-mode addon contract. No synthetic sidecar is materialised —
 * `provision()` returns env / mounts / labels / requiredEgress that the
 * render pipeline merges directly onto the target service. The
 * `buildServiceDefinition()` / `targetIntegration` hooks are intentionally
 * absent from this shape so callers can't accidentally call them on an
 * env-injection addon.
 *
 * `planStub` is an optional synchronous, side-effect-free hook the framework
 * calls in `dryRun` mode (plan-time / egress-reconciler paths) to surface the
 * static parts of the provisioned values without minting credentials or
 * touching Vault. Implementations must NOT read Vault, mint authkeys, or
 * make network calls — the function is called from synchronous-read code
 * paths and any side effects there would bleed into plan-time UIs. Return
 * only the fields that are deterministic per (stack, service, environment).
 */
export interface EnvInjectionAddonDefinition {
  manifest: AddonManifest & { mode: 'env-injection' };
  provision(ctx: ProvisionContext): Promise<EnvInjectionProvisionedValues>;
  cleanup?(
    ctx: ProvisionContext,
    provisioned: EnvInjectionProvisionedValues,
  ): Promise<void>;
  status?(ctx: StatusContext): Promise<AddonStatus>;
  planStub?(ctx: ProvisionContext): EnvInjectionPlanStubValues;
}

/**
 * What an addon directory exports — discriminated union over `manifest.mode`.
 * The render pipeline branches on the manifest's `mode` field (defaulting to
 * `'sidecar'` for back-compat) and narrows to the corresponding member.
 */
export type AddonDefinition =
  | SidecarAddonDefinition
  | EnvInjectionAddonDefinition;

/**
 * Strategy for collapsing multiple same-`kind` addons on one service into a
 * single sidecar definition. Registered per kind alongside the addons that
 * share it.
 *
 * Merge strategies only exist for `mode: 'sidecar'` addons — env-injection
 * addons don't have a sidecar to collapse, so `kind`-based merging is not
 * supported for them. See `expand-addons.ts` for the runtime enforcement.
 */
export interface AddonMergeStrategy {
  kind: string;
  /** Single integration applied to the merged group. */
  targetIntegration: TargetIntegration;
  provision(
    ctx: ProvisionContext,
    members: Array<{ addonId: string; config: unknown }>,
  ): Promise<SidecarProvisionedValues>;
  buildServiceDefinition(
    ctx: ProvisionContext,
    provisioned: SidecarProvisionedValues,
    members: Array<{ addonId: string; config: unknown }>,
  ): StackServiceDefinition;
  /**
   * Plan-time deterministic skeleton for the merged sidecar. See
   * `AddonDefinition.planStub` for the contract — the merge variant takes
   * the resolved member list so it can label the synthetic with the right
   * `addon-members` set without running provision().
   */
  planStub?(
    ctx: ProvisionContext,
    members: Array<{ addonId: string; config: unknown }>,
  ): StackServiceDefinition;
}

// `SyntheticServiceInfo` is declared in `./stacks` (next to
// `StackServiceDefinition`) and re-exported above so the back-ref doesn't
// create a circular dependency between stacks.ts and addons.ts.
