import type {
  AddonMergeStrategy,
  EnvInjectionAddonDefinition,
  EnvInjectionProvisionedValues,
  ProvisionContext,
  SidecarAddonDefinition,
  SidecarProvisionedValues,
  StackServiceDefinition,
  SyntheticServiceInfo,
  TargetIntegration,
} from '@mini-infra/types';
import type { AddonRegistry, RegisteredAddon } from './registry';

/**
 * Per-stack metadata the render pipeline carries into every addon's
 * `provision()` call. `vault` and `connectedServices` are typed `unknown` so
 * the framework can be exercised in unit tests without standing up either —
 * Phase 3+ addon implementations narrow them to their concrete service types.
 */
export interface ExpansionContext {
  stack: { id: string; name: string };
  environment: {
    id: string;
    name: string;
    networkType: 'local' | 'internet';
  };
  registry: AddonRegistry;
  /** Present iff this expansion is for a single pool-instance spawn. */
  instance?: { instanceId: string };
  vault?: unknown;
  connectedServices?: unknown;
  /**
   * When true, expansion runs from a read-only plan path: `provision()` and
   * `buildServiceDefinition()` are skipped in favour of `planStub()` (or a
   * generic placeholder), and the `requiresConnectedService` check is
   * tolerant of an absent `connectedServices` lookup. Apply paths leave this
   * unset so real provisioning runs.
   */
  dryRun?: boolean;
}

/**
 * Per-addon-application progress callback. The render pipeline invokes this
 * after each successful provision and after each failure so callers can
 * fan-out the existing `STACK_ADDON_PROVISIONED` / `STACK_ADDON_FAILED`
 * events without re-implementing the success/failure book-keeping.
 *
 * Phase 1 declares the callback shape but doesn't wire it to socket emission;
 * Phase 3 (`tailscale-ssh`) is the first phase to emit the events.
 */
export interface ExpansionProgress {
  onProvisioned?: (info: {
    serviceName: string;
    addonIds: string[];
    kind?: string;
    syntheticServiceName: string;
  }) => void;
  onFailed?: (info: {
    serviceName: string;
    addonIds: string[];
    kind?: string;
    error: string;
  }) => void;
}

/** Internal: one pending application before merge-group resolution. */
interface PendingApplication {
  addonId: string;
  config: unknown;
  registered: RegisteredAddon;
}

/** Internal: a merge group that survived applicability checks. */
type ResolvedGroup =
  | {
      kind: 'solo';
      target: StackServiceDefinition;
      application: PendingApplication;
    }
  | {
      kind: 'merged';
      target: StackServiceDefinition;
      kindLabel: string;
      members: PendingApplication[];
      strategy: AddonMergeStrategy;
    };

/**
 * Render-pipeline step that materialises each `addons:` declaration into one
 * or more synthetic `StackServiceDefinition`s appended to the rendered
 * services list.
 *
 * Implements §4.4 of the Service Addons plan:
 *   1. validate     — manifest's configSchema parses the user-supplied config
 *   2. applicability — serviceType in `appliesTo`, prerequisites configured
 *   3. merge-group  — same-`kind` addons on one service collapse via strategy
 *   4. provision    — credential mint / file render / template-var compute
 *   5. materialise  — call `buildServiceDefinition()`, attach `synthetic` ref
 *   6. target ints. — `peer-on-target-network` / `join-target-netns` / …
 *
 * Step 7 (cross-addon rewrites) and the §5 production addons land in later
 * phases. Phase 1 ships only the framework; production registries are empty.
 *
 * Returns the **rendered** services list. Pure function — input is not
 * mutated. Authored services without `addons:` flow through byte-identical.
 */
export async function expandAddons(
  authoredDefinitions: StackServiceDefinition[],
  context: ExpansionContext,
  progress: ExpansionProgress = {},
): Promise<StackServiceDefinition[]> {
  // Single output buffer keyed by serviceName so we can mutate target
  // definitions in-place when an addon's TargetIntegration rewrites them
  // (env / mounts / network_mode). Authored services land first; synthetic
  // sidecars are appended later.
  const rendered = new Map<string, StackServiceDefinition>();
  for (const def of authoredDefinitions) {
    // Authored services may carry an `addons:` block. We strip it on the
    // *rendered* output because addons are an authoring artifact — once
    // expanded, the rendered definition is a flat services list. The
    // authored block is preserved on the original input via the immutable
    // input contract; the rendered map is the function's only output.
    const { addons: _stripped, ...withoutAddons } = def;
    void _stripped;
    rendered.set(def.serviceName, { ...withoutAddons });
  }

  for (const authored of authoredDefinitions) {
    if (!authored.addons || Object.keys(authored.addons).length === 0) continue;

    // resolveGroups throws AddonExpansionError directly on validation /
    // applicability / connected-service / merge-strategy issues. Surface
    // those through progress.onFailed before re-throwing so Phase 3+
    // socket emission of STACK_ADDON_FAILED captures the most common
    // user-facing error class — "addon X isn't registered" or "config Y
    // is invalid" — which fires before any provision() runs.
    let groups: ResolvedGroup[];
    try {
      groups = await resolveGroups(authored, authored.addons, context);
    } catch (err) {
      const e =
        err instanceof AddonExpansionError
          ? err
          : new AddonExpansionError(
              authored.serviceName,
              [],
              err instanceof Error ? err.message : String(err),
              err,
            );
      progress.onFailed?.({
        serviceName: e.serviceName,
        addonIds: e.addonIds,
        error: e.message,
      });
      throw e;
    }

    for (const group of groups) {
      try {
        await applyGroup(group, context, rendered, progress);
      } catch (err) {
        const memberIds =
          group.kind === 'solo'
            ? [group.application.addonId]
            : group.members.map((m) => m.addonId);
        const message = err instanceof Error ? err.message : String(err);
        progress.onFailed?.({
          serviceName: authored.serviceName,
          addonIds: memberIds,
          kind: group.kind === 'merged' ? group.kindLabel : undefined,
          error: message,
        });
        throw new AddonExpansionError(
          authored.serviceName,
          memberIds,
          message,
          err,
        );
      }
    }
  }

  return [...rendered.values()];
}

/**
 * Thrown when an addon application fails validation, applicability, or
 * provision/build. Carries enough context for the apply orchestrator to
 * surface a clear error in the task tracker without re-deriving identifiers.
 */
export class AddonExpansionError extends Error {
  constructor(
    public readonly serviceName: string,
    public readonly addonIds: string[],
    message: string,
    public readonly cause?: unknown,
  ) {
    super(
      `Addon expansion failed on service "${serviceName}" (addons: ${addonIds.join(', ')}): ${message}`,
    );
    this.name = 'AddonExpansionError';
  }
}

async function resolveGroups(
  target: StackServiceDefinition,
  addonsBlock: Record<string, unknown>,
  context: ExpansionContext,
): Promise<ResolvedGroup[]> {
  const applications: PendingApplication[] = [];

  for (const [addonId, rawConfig] of Object.entries(addonsBlock)) {
    const registered = context.registry.get(addonId);
    if (!registered) {
      throw new AddonExpansionError(
        target.serviceName,
        [addonId],
        `Addon "${addonId}" is not registered`,
      );
    }

    // Step 1 — config validation. Throws ZodError with a field-pathed message
    // if the user-supplied config doesn't fit the manifest's schema.
    const parsed = registered.configSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new AddonExpansionError(
        target.serviceName,
        [addonId],
        `Invalid config: ${parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`,
      );
    }

    // Step 2 — applicability. Reject early when the addon doesn't support
    // this service's type or requires a connected service that isn't
    // configured. Connected-service presence is checked from the
    // expansion context — Phase 3 narrows `connectedServices` to the
    // concrete lookup type.
    if (!registered.manifest.appliesTo.includes(target.serviceType)) {
      throw new AddonExpansionError(
        target.serviceName,
        [addonId],
        `Addon "${addonId}" does not apply to service type "${target.serviceType}" (allowed: ${registered.manifest.appliesTo.join(', ')})`,
      );
    }
    // Connected-service presence is enforced at apply time (when the caller
    // supplies a real lookup). Plan-time callers run with `dryRun: true` and
    // no lookup — the synthetic sidecar still appears in the plan diff, and
    // the eventual apply re-checks before any provisioning runs. Skipping
    // here keeps standalone plan UIs (validation-routes, update-route)
    // working for stacks that declare addons.
    if (
      registered.manifest.requiresConnectedService &&
      context.connectedServices !== undefined &&
      !connectedServiceConfigured(
        registered.manifest.requiresConnectedService,
        context.connectedServices,
      )
    ) {
      throw new AddonExpansionError(
        target.serviceName,
        [addonId],
        `Addon "${addonId}" requires connected service "${registered.manifest.requiresConnectedService}" but it is not configured`,
      );
    }
    if (
      registered.manifest.requiresConnectedService &&
      context.connectedServices === undefined &&
      !context.dryRun
    ) {
      throw new AddonExpansionError(
        target.serviceName,
        [addonId],
        `Addon "${addonId}" requires connected service "${registered.manifest.requiresConnectedService}" but no connected-services lookup was provided to apply-time expansion`,
      );
    }

    applications.push({ addonId, config: parsed.data, registered });
  }

  // Step 3 — merge-group resolution. Group by `kind`; solo applications go
  // through verbatim. Two members of the same kind without a registered
  // strategy is a hard error (configuration mistake at registry-build time).
  //
  // Env-injection addons are kept out of `kind`-based merge groups entirely —
  // by definition they don't materialise a sidecar, so there's no shared
  // sidecar to collapse multiple members into. If two env-injection addons
  // happen to share a `kind`, each is treated as a solo application and
  // merges its own outputs onto the target independently.
  const byKind = new Map<string, PendingApplication[]>();
  const solos: PendingApplication[] = [];
  for (const app of applications) {
    const kind = app.registered.manifest.kind;
    const mode = app.registered.manifest.mode ?? 'sidecar';
    if (!kind || mode === 'env-injection') {
      solos.push(app);
      continue;
    }
    const bucket = byKind.get(kind);
    if (bucket) bucket.push(app);
    else byKind.set(kind, [app]);
  }

  const groups: ResolvedGroup[] = [];
  for (const solo of solos) {
    groups.push({ kind: 'solo', target, application: solo });
  }
  for (const [kind, members] of byKind) {
    if (members.length === 1) {
      groups.push({ kind: 'solo', target, application: members[0] });
      continue;
    }
    const strategy = context.registry.getMergeStrategy(kind);
    if (!strategy) {
      throw new AddonExpansionError(
        target.serviceName,
        members.map((m) => m.addonId),
        `${members.length} addons of kind "${kind}" declared on the same service but no merge strategy is registered`,
      );
    }
    groups.push({ kind: 'merged', target, kindLabel: kind, members, strategy });
  }

  return groups;
}

async function applyGroup(
  group: ResolvedGroup,
  context: ExpansionContext,
  rendered: Map<string, StackServiceDefinition>,
  progress: ExpansionProgress,
): Promise<void> {
  // Branch by mode. Env-injection addons are solo-by-construction (see
  // `resolveGroups`) and bypass the sidecar materialisation entirely.
  if (
    group.kind === 'solo' &&
    (group.application.registered.manifest.mode ?? 'sidecar') === 'env-injection'
  ) {
    await applyEnvInjectionGroup(group.application, group.target, context, rendered, progress);
    return;
  }

  // Step 4–5 — provision and materialise. In `dryRun` mode the side-effecting
  // `provision()` (e.g. authkey minting) is skipped; the addon's `planStub()`
  // (or a generic placeholder) supplies a deterministic synthetic-service
  // skeleton so the plan diff still shows the sidecar. `applyTargetIntegration`
  // also degrades to a no-op in dryRun because `provisioned` carries nothing
  // for it to thread through.
  let provisioned: SidecarProvisionedValues;
  let sidecar: StackServiceDefinition;
  let integration: TargetIntegration;
  let synthetic: SyntheticServiceInfo;
  let memberIds: string[];

  if (group.kind === 'solo') {
    // Mode was checked above; this branch is sidecar-only.
    const def = group.application.registered.definition as SidecarAddonDefinition;
    const provisionCtx = buildProvisionContext(
      group.target,
      group.application.config,
      context,
    );
    if (context.dryRun) {
      provisioned = { templateVars: {} };
      sidecar = def.planStub
        ? def.planStub(provisionCtx)
        : genericPlanStub(group.target.serviceName, [group.application.addonId]);
    } else {
      provisioned = await def.provision(provisionCtx);
      sidecar = def.buildServiceDefinition(provisionCtx, provisioned);
    }
    integration = def.targetIntegration;
    memberIds = [group.application.addonId];
    synthetic = {
      addonIds: memberIds,
      targetService: group.target.serviceName,
    };
  } else {
    const provisionCtx = buildProvisionContext(
      group.target,
      // For merged groups the `addonConfig` slot is unused — the strategy
      // reads each member's config through the `members` parameter — but
      // we still set it to the group's combined member configs for
      // observability inside `provision()`.
      group.members.map((m) => ({ addonId: m.addonId, config: m.config })),
      context,
    );
    const memberPairs = group.members.map((m) => ({
      addonId: m.addonId,
      config: m.config,
    }));
    memberIds = group.members.map((m) => m.addonId);
    if (context.dryRun) {
      provisioned = { templateVars: {} };
      sidecar = group.strategy.planStub
        ? group.strategy.planStub(provisionCtx, memberPairs)
        : genericPlanStub(group.target.serviceName, memberIds, group.kindLabel);
    } else {
      provisioned = await group.strategy.provision(provisionCtx, memberPairs);
      sidecar = group.strategy.buildServiceDefinition(
        provisionCtx,
        provisioned,
        memberPairs,
      );
    }
    integration = group.strategy.targetIntegration;
    synthetic = {
      addonIds: memberIds,
      kind: group.kindLabel,
      targetService: group.target.serviceName,
    };
  }

  // Tag the sidecar with its synthetic back-reference. The render pipeline
  // is the only authority that sets this field — authored services never
  // carry it.
  const renderedSidecar: StackServiceDefinition = {
    ...sidecar,
    synthetic,
  };

  // Sidecar serviceName conflicts with an authored or already-rendered
  // service: hard fail. Naming is the addon author's responsibility, but a
  // collision means the render output is ambiguous and the reconciler will
  // misbehave.
  if (rendered.has(renderedSidecar.serviceName)) {
    throw new Error(
      `Synthetic service name "${renderedSidecar.serviceName}" collides with an existing service in the rendered stack`,
    );
  }
  rendered.set(renderedSidecar.serviceName, renderedSidecar);

  // Step 6 — target integration. Apply env / mounts / network_mode rewrites
  // to the rendered target (looked up via the rendered map so prior
  // applications' rewrites are preserved). The authored input is never
  // mutated.
  applyTargetIntegration(group.target.serviceName, integration, provisioned, rendered);

  progress.onProvisioned?.({
    serviceName: group.target.serviceName,
    addonIds: memberIds,
    kind: group.kind === 'merged' ? group.kindLabel : undefined,
    syntheticServiceName: renderedSidecar.serviceName,
  });
}

/**
 * Apply a `mode: 'env-injection'` addon to the rendered target. Unlike the
 * sidecar path, no synthetic service is materialised — the provisioned env,
 * mounts, labels, and requiredEgress are merged onto the target's
 * `containerConfig` in place. The target is additionally tagged with
 * `mini-infra.addon: <addon-id>` so downstream endpoint discovery (Phase 4)
 * can locate env-injection addons without scanning manifests.
 *
 * Env-injection addons don't participate in `kind`-based merge groups (see
 * `resolveGroups`) — two same-`kind` env-injection addons each take this
 * path independently and stack their outputs onto the target. Key collisions
 * on `envForTarget` fail loudly rather than silently overwrite.
 *
 * In `dryRun` mode the side-effecting `provision()` is skipped and the
 * target is only tagged with the addon-id label so the plan diff reflects
 * which addons are attached without exercising vault / authkey-minter side
 * effects.
 */
async function applyEnvInjectionGroup(
  application: PendingApplication,
  target: StackServiceDefinition,
  context: ExpansionContext,
  rendered: Map<string, StackServiceDefinition>,
  progress: ExpansionProgress,
): Promise<void> {
  const addonId = application.addonId;
  const renderedTarget = rendered.get(target.serviceName);
  if (!renderedTarget) {
    throw new Error(
      `Target service "${target.serviceName}" missing from rendered map`,
    );
  }

  // Always-on label so endpoint discovery can locate env-injection addons
  // without scanning manifests. Applied in both `dryRun` and apply paths so
  // the plan diff reflects the addon attachment.
  const baseLabels: Record<string, string> = {
    ...(renderedTarget.containerConfig.labels ?? {}),
    'mini-infra.addon': addonId,
    // `synthetic: false` is conceptually redundant for an authored target,
    // but the label is the discovery key — making it explicit means callers
    // can distinguish "target with env-injection addon" from "target with
    // no addon" using a single label query.
    'mini-infra.synthetic': 'false',
  };

  if (context.dryRun) {
    // Side-effect-free `planStub()` (optional) lets the addon surface the
    // static parts of its provisioned values — `requiredEgress`, mounts,
    // caps, devices, labels — so plan-time consumers see the same shape
    // the apply path would write. Implementations must NOT read Vault or
    // mint credentials here. Without this hook, the egress-rule reconciler
    // can't see env-injection-derived `requiredEgress` (e.g. claude-shell's
    // Tailscale control-plane hostnames) and the env's egress firewall
    // silently blocks them at apply time — see the egress-policy-lifecycle
    // pass (b) for the corresponding consumer.
    const def = application.registered.definition as EnvInjectionAddonDefinition;
    const stub = def.planStub
      ? def.planStub(buildProvisionContext(target, application.config, context))
      : {};
    // Mirror the non-dryRun merge shape below (env / templateVars are
    // skipped because those depend on minted secrets the dryRun path
    // doesn't have). Fields that the stub doesn't supply AND the target
    // didn't declare stay undefined so the rendered shape matches the
    // authored shape for hash-stable plan diffs.
    const mergedLabels: Record<string, string> = {
      ...baseLabels,
      ...(stub.labelsForTarget ?? {}),
    };
    const existingMounts = renderedTarget.containerConfig.mounts;
    const stubMounts = stub.mountsForTarget ?? [];
    const mergedMounts =
      existingMounts !== undefined || stubMounts.length > 0
        ? [...(existingMounts ?? []), ...stubMounts]
        : undefined;
    const existingEgress = renderedTarget.containerConfig.requiredEgress;
    const stubEgress = stub.requiredEgress ?? [];
    const mergedEgress =
      existingEgress !== undefined || stubEgress.length > 0
        ? Array.from(new Set([...(existingEgress ?? []), ...stubEgress]))
        : undefined;
    const existingCapAdd = renderedTarget.containerConfig.capAdd;
    const stubCapAdd = stub.capAddForTarget ?? [];
    const mergedCapAdd =
      existingCapAdd !== undefined || stubCapAdd.length > 0
        ? Array.from(new Set([...(existingCapAdd ?? []), ...stubCapAdd]))
        : undefined;
    const existingDevices = renderedTarget.containerConfig.devices;
    const stubDevices = stub.devicesForTarget ?? [];
    const mergedDevices =
      existingDevices !== undefined || stubDevices.length > 0
        ? Array.from(new Set([...(existingDevices ?? []), ...stubDevices]))
        : undefined;
    renderedTarget.containerConfig = {
      ...renderedTarget.containerConfig,
      labels: mergedLabels,
      ...(mergedMounts !== undefined ? { mounts: mergedMounts } : {}),
      ...(mergedEgress !== undefined ? { requiredEgress: mergedEgress } : {}),
      ...(mergedCapAdd !== undefined ? { capAdd: mergedCapAdd } : {}),
      ...(mergedDevices !== undefined ? { devices: mergedDevices } : {}),
    };
    progress.onProvisioned?.({
      serviceName: target.serviceName,
      addonIds: [addonId],
      // No synthetic service is materialised — surface the target name so
      // callers fanning out events still get a non-empty back-reference.
      syntheticServiceName: target.serviceName,
    });
    return;
  }

  const def = application.registered.definition as EnvInjectionAddonDefinition;
  const provisionCtx = buildProvisionContext(target, application.config, context);
  const provisioned: EnvInjectionProvisionedValues = await def.provision(provisionCtx);

  // Env merge: hard-fail on key collision rather than silently overwriting
  // operator-authored or previously-merged env vars. The error message
  // names the colliding key so the operator can resolve the conflict in
  // their stack definition.
  const existingEnv = renderedTarget.containerConfig.env ?? {};
  const mergedEnv: Record<string, string> = { ...existingEnv };
  if (provisioned.envForTarget) {
    for (const [key, value] of Object.entries(provisioned.envForTarget)) {
      if (key in mergedEnv) {
        throw new Error(
          `Addon "${addonId}" cannot inject env var "${key}" into target service "${target.serviceName}": key already set`,
        );
      }
      mergedEnv[key] = value;
    }
  }

  const mergedMounts = [
    ...(renderedTarget.containerConfig.mounts ?? []),
    ...(provisioned.mountsForTarget ?? []),
  ];

  const mergedLabels: Record<string, string> = {
    ...baseLabels,
    ...(provisioned.labelsForTarget ?? {}),
  };

  // Required egress: dedupe to avoid duplicate egress-rule rows when the
  // operator already declared an overlapping hostname.
  const existingEgress = renderedTarget.containerConfig.requiredEgress ?? [];
  const addonEgress = provisioned.requiredEgress ?? [];
  const mergedEgress = Array.from(new Set([...existingEgress, ...addonEgress]));

  // Capabilities + devices: dedupe the same way egress does. The env-injection
  // mode exists for cases where the target image runs the agent the addon
  // would otherwise sidecar (e.g. `claude-shell` runs `tailscaled` in-process),
  // so the target needs whatever caps + devices the would-be sidecar needed
  // (`NET_ADMIN` + `/dev/net/tun` for tailscaled in kernel mode). The merge
  // is additive — operator-declared caps/devices are preserved verbatim,
  // addon-supplied ones are appended without duplicates. We avoid writing
  // empty arrays onto fields the target never declared so the rendered
  // shape stays identical to the authored shape for addons that don't
  // touch caps/devices (matters for hash-based drift detection).
  const existingCapAdd = renderedTarget.containerConfig.capAdd;
  const addonCapAdd = provisioned.capAddForTarget ?? [];
  const mergedCapAdd =
    existingCapAdd !== undefined || addonCapAdd.length > 0
      ? Array.from(new Set([...(existingCapAdd ?? []), ...addonCapAdd]))
      : undefined;

  const existingDevices = renderedTarget.containerConfig.devices;
  const addonDevices = provisioned.devicesForTarget ?? [];
  const mergedDevices =
    existingDevices !== undefined || addonDevices.length > 0
      ? Array.from(new Set([...(existingDevices ?? []), ...addonDevices]))
      : undefined;

  renderedTarget.containerConfig = {
    ...renderedTarget.containerConfig,
    env: mergedEnv,
    mounts: mergedMounts,
    labels: mergedLabels,
    requiredEgress: mergedEgress,
    ...(mergedCapAdd !== undefined ? { capAdd: mergedCapAdd } : {}),
    ...(mergedDevices !== undefined ? { devices: mergedDevices } : {}),
  };

  progress.onProvisioned?.({
    serviceName: target.serviceName,
    addonIds: [addonId],
    syntheticServiceName: target.serviceName,
  });
}

/**
 * Fallback synthetic-service skeleton when an addon (or merge strategy)
 * doesn't supply its own `planStub`. The shape is deliberately minimal —
 * just enough that the plan diff can include the synthetic by name without
 * leaking apply-time provisioned state. Image / tag use a sentinel that
 * makes plan-time misuse obvious if it ever leaks past plan into the
 * reconciler.
 */
function genericPlanStub(
  targetServiceName: string,
  addonIds: string[],
  kind?: string,
): StackServiceDefinition {
  const suffix = kind ?? addonIds[0] ?? 'addon';
  return {
    serviceName: `${targetServiceName}-${suffix}`,
    serviceType: 'Stateful',
    dockerImage: 'addon-pending',
    dockerTag: 'plan',
    containerConfig: {},
    dependsOn: [targetServiceName],
    order: 1000,
  };
}

function buildProvisionContext(
  target: StackServiceDefinition,
  addonConfig: unknown,
  context: ExpansionContext,
): ProvisionContext {
  return {
    stack: context.stack,
    service: { name: target.serviceName, type: target.serviceType },
    environment: context.environment,
    addonConfig,
    instance: context.instance,
    vault: context.vault,
    connectedServices: context.connectedServices,
  };
}

function applyTargetIntegration(
  targetName: string,
  integration: TargetIntegration,
  provisioned: SidecarProvisionedValues,
  rendered: Map<string, StackServiceDefinition>,
): void {
  const target = rendered.get(targetName);
  if (!target) {
    // Defensive: the target was authored, so it must be in the rendered
    // map. If it isn't, something is structurally wrong with the caller.
    throw new Error(`Target service "${targetName}" missing from rendered map`);
  }

  // Merge env-for-target from both the static integration declaration and
  // the dynamic provisioned values. Static integration wins on key collision
  // — provisioned values are computed-defaults that an integration spec can
  // override deliberately.
  const envForTarget: Record<string, string> = {
    ...(provisioned.envForTarget ?? {}),
    ...(integration.envForTarget ?? {}),
  };
  const mountsForTarget = integration.mountsForTarget ?? [];

  if (Object.keys(envForTarget).length > 0 || mountsForTarget.length > 0) {
    target.containerConfig = {
      ...target.containerConfig,
      env: { ...(target.containerConfig.env ?? {}), ...envForTarget },
      mounts: [...(target.containerConfig.mounts ?? []), ...mountsForTarget],
    };
  }

  // Network-mode rewrites are scoped to specific integration kinds.
  // `peer-on-target-network` does NOT touch the target. Phase 3+ wires up
  // the `join-target-netns` and `own-target-netns` rewrites on the rendered
  // sidecar / target as the §5 addons land. Phase 1 only ships the
  // peer-on-target-network plumbing because the no-op test addon uses it.
}

/**
 * Connected-service presence check. The expansion context carries
 * `connectedServices` as `unknown` (lib/ stays runtime-dep-free), so the
 * concrete lookup is performed via duck-typing here. Phase 3+ may swap this
 * for a strongly-typed lookup once the connected-services API surface is
 * imported into the addon framework.
 */
function connectedServiceConfigured(
  type: string,
  connectedServices: unknown,
): boolean {
  if (!connectedServices) return false;
  if (typeof connectedServices === 'object') {
    const lookup = connectedServices as { has?: (t: string) => boolean } & Record<string, unknown>;
    if (typeof lookup.has === 'function') return lookup.has(type);
    return type in lookup;
  }
  return false;
}
