import type {
  AddonMergeStrategy,
  ProvisionContext,
  ProvisionedValues,
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

    const groups = await resolveGroups(authored, authored.addons, context);
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
    if (
      registered.manifest.requiresConnectedService &&
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

    applications.push({ addonId, config: parsed.data, registered });
  }

  // Step 3 — merge-group resolution. Group by `kind`; solo applications go
  // through verbatim. Two members of the same kind without a registered
  // strategy is a hard error (configuration mistake at registry-build time).
  const byKind = new Map<string, PendingApplication[]>();
  const solos: PendingApplication[] = [];
  for (const app of applications) {
    const kind = app.registered.manifest.kind;
    if (!kind) {
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
  // Step 4–5 — provision and materialise.
  let provisioned: ProvisionedValues;
  let sidecar: StackServiceDefinition;
  let integration: TargetIntegration;
  let synthetic: SyntheticServiceInfo;
  let memberIds: string[];

  if (group.kind === 'solo') {
    const def = group.application.registered.definition;
    const provisionCtx = buildProvisionContext(
      group.target,
      group.application.config,
      context,
    );
    provisioned = await def.provision(provisionCtx);
    sidecar = def.buildServiceDefinition(provisionCtx, provisioned);
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
    provisioned = await group.strategy.provision(provisionCtx, memberPairs);
    sidecar = group.strategy.buildServiceDefinition(
      provisionCtx,
      provisioned,
      memberPairs,
    );
    integration = group.strategy.targetIntegration;
    memberIds = group.members.map((m) => m.addonId);
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
  provisioned: ProvisionedValues,
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
