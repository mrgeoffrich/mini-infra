import Docker from 'dockerode';
import { Prisma } from "../../generated/prisma/client";
import type {
  StackServiceDefinition,
  StackConfigFile,
  StackContainerConfig,
  StackNetwork,
  StackParameterDefinition,
  StackParameterValue,
  StackVolume,
  StackInfo,
  StackServiceInfo,
  StackStatus,
  StackRuntimeIssue,
  NatsDriftInfo,
} from '@mini-infra/types';
import {
  ErrorCode,
  computeStackAttention,
  computeTemplateVersionRelation,
} from '@mini-infra/types';
import { NotFoundError } from '../../lib/errors';
import { buildTemplateContext, resolveStackConfigFiles, resolveServiceDefinition } from './template-engine';
import { computeDefinitionHash, computeSyntheticDefinitionHash } from './definition-hash';
import { StackContainerManager } from './stack-container-manager';
import { decryptInputValues } from './stack-input-values-service';
import {
  expandAddons,
  productionAddonRegistry,
  type AddonRegistry,
  type ExpansionProgress,
} from '../stack-addons';

/**
 * Throws `NotFoundError` (STACK_NOT_FOUND) when a stack lookup came back
 * null, otherwise narrows and returns the found row. Callers still perform
 * their own tailored `prisma.stack.findUnique(...)` (selects/includes vary
 * per route) — this only centralises the not-found check + error shape so
 * every stacks route reports the same code/resource/action.
 */
export function assertStackFound<T>(stack: T | null, stackId: string): T {
  if (!stack) {
    throw new NotFoundError(ErrorCode.STACK_NOT_FOUND, 'Stack not found', {
      resource: { type: 'stack', id: stackId },
      action: 'Check the stack ID or refresh the stacks list.',
    });
  }
  return stack;
}

/**
 * Loose shape of a Prisma stack record extended with optional relations.
 * Fields are `unknown` since they come from Prisma JSON columns.
 */
type SerializableStack = {
  parameters?: unknown;
  parameterValues?: unknown;
  resourceOutputs?: unknown;
  resourceInputs?: unknown;
  templateId?: string | null;
  templateVersion?: number | null;
  templateVersionId?: string | null;
  template?: { source?: string; currentVersion?: { version: number } | null } | null;
  tlsCertificates?: unknown;
  dnsRecords?: unknown;
  tunnelIngress?: unknown;
  lastAppliedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  services?: SerializableService[];
  encryptedInputValues?: string | null;
  [key: string]: unknown;
};

type SerializableService = {
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
};

/**
 * Serialize a Prisma stack (with Date objects) to the API response shape (ISO strings).
 *
 * encryptedInputValues is always stripped — the ciphertext must never leave
 * the server. inputValueKeys (the set of stored input names) is included
 * instead so callers know which inputs have been supplied without seeing the
 * values.
 *
 * lastAppliedVaultSnapshot is internal reconciliation state; it is stripped
 * because it contains concrete policy/path names and content hashes that are
 * not useful to API consumers and would increase response size.
 *
 * lastFailureReason is kept — operators need it to diagnose failed applies.
 */
/**
 * Extras the caller has already fetched and that are not columns on the stack
 * row. `natsDrift` needs its own query (see `detectNatsDrift`), so routes pass
 * it in rather than this function reaching for prisma — which keeps
 * `serializeStack` pure and cheap to call in a list.
 *
 * Passing it matters: `needsAttention` folds NATS drift into its rollup, so a
 * route that omits it silently under-reports.
 */
export interface SerializeStackExtras {
  natsDrift?: NatsDriftInfo | null;
}

export function serializeStack(
  stack: SerializableStack,
  extras: SerializeStackExtras = {},
): StackInfo {
  let inputValueKeys: string[] | undefined;
  if (stack.encryptedInputValues) {
    try {
      inputValueKeys = Object.keys(decryptInputValues(stack.encryptedInputValues));
    } catch {
      inputValueKeys = [];
    }
  }

  const {
    encryptedInputValues: _strippedEncrypted,
    lastAppliedVaultSnapshot: _strippedSnapshot,
    ...rest
  } = stack;
  void _strippedEncrypted;
  void _strippedSnapshot;

  const templateVersionRelation = computeTemplateVersionRelation(
    stack.templateVersion,
    stack.template?.currentVersion?.version,
  );
  const templateUpdateAvailable = templateVersionRelation === 'behind';
  const runtimeIssues = normaliseRuntimeIssues(
    (stack as { runtimeIssues?: unknown }).runtimeIssues,
  );

  return {
    ...rest,
    parameters: stack.parameters ?? [],
    parameterValues: stack.parameterValues ?? {},
    resourceOutputs: stack.resourceOutputs ?? [],
    resourceInputs: stack.resourceInputs ?? [],
    templateId: stack.templateId ?? null,
    templateVersion: stack.templateVersion ?? null,
    // The FK, not just the version number — a targeted upgrade needs the id, and
    // promotion between environments is "install the version this other
    // environment already has". Set explicitly: it was previously reaching the
    // client only by accident, riding the `...rest` spread on queries that
    // happened to use `include` rather than a narrowing `select`.
    templateVersionId: stack.templateVersionId ?? null,
    templateSource: (stack.template?.source as 'system' | 'user' | undefined) ?? null,
    templateCurrentVersion: stack.template?.currentVersion?.version ?? null,
    templateUpdateAvailable,
    templateVersionRelation,
    tlsCertificates: stack.tlsCertificates ?? [],
    dnsRecords: stack.dnsRecords ?? [],
    tunnelIngress: stack.tunnelIngress ?? [],
    lastAppliedAt: stack.lastAppliedAt?.toISOString() ?? null,
    createdAt: stack.createdAt.toISOString(),
    updatedAt: stack.updatedAt.toISOString(),
    services: stack.services?.map(serializeService),
    runtimeIssues,
    ...(extras.natsDrift !== undefined ? { natsDrift: extras.natsDrift } : {}),
    // Computed server-side so every consumer — the UI, the agent sidecar, an
    // API-key integration — gets the same answer instead of reimplementing it.
    // Shares one implementation with the client via @mini-infra/types.
    needsAttention: computeStackAttention({
      status: stack.status as StackStatus,
      lastFailureReason: (stack as { lastFailureReason?: string | null }).lastFailureReason,
      runtimeIssues,
      natsDrift: extras.natsDrift,
      templateUpdateAvailable,
    }),
    ...(inputValueKeys !== undefined ? { inputValueKeys } : {}),
  } as StackInfo;
}

/** The Json column comes back as `unknown`; keep anything malformed out of the rollup. */
function normaliseRuntimeIssues(value: unknown): StackRuntimeIssue[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (issue): issue is StackRuntimeIssue =>
      typeof issue === 'object' &&
      issue !== null &&
      typeof (issue as { kind?: unknown }).kind === 'string' &&
      typeof (issue as { serviceName?: unknown }).serviceName === 'string',
  );
}

export function serializeService(svc: SerializableService): StackServiceInfo {
  return {
    ...svc,
    createdAt: svc.createdAt.toISOString(),
    updatedAt: svc.updatedAt.toISOString(),
  } as StackServiceInfo;
}

/**
 * Map a service definition to the Prisma create input shape.
 * Used when creating or updating stack services in the DB.
 */
export function toServiceCreateInput(s: StackServiceDefinition) {
  return {
    serviceName: s.serviceName,
    serviceType: s.serviceType,
    dockerImage: s.dockerImage,
    dockerTag: s.dockerTag,
    containerConfig: s.containerConfig as unknown as Prisma.InputJsonValue,
    configFiles: (s.configFiles ?? []) as unknown as Prisma.InputJsonValue,
    initCommands: (s.initCommands ?? []) as unknown as Prisma.InputJsonValue,
    dependsOn: s.dependsOn,
    order: s.order,
    routing: s.routing ? (s.routing as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    adoptedContainer: s.adoptedContainer
      ? (s.adoptedContainer as unknown as Prisma.InputJsonValue)
      : Prisma.DbNull,
    poolConfig: s.poolConfig ? (s.poolConfig as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    jobPoolConfig: s.jobPoolConfig ? (s.jobPoolConfig as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    vaultAppRoleId: s.vaultAppRoleId ?? null,
    natsCredentialId: s.natsCredentialId ?? null,
    addons: s.addons ? (s.addons as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
  };
}

/**
 * Check if an error is a Docker connectivity error.
 */
export function isDockerConnectionError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes('connect ENOENT') || msg.includes('ECONNREFUSED')) {
      return true;
    }
  }
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code === 'ECONNREFUSED' || cause?.code === 'ECONNRESET' || cause?.code === 'ENOTFOUND';
  }
  return false;
}

/**
 * Map Docker container info to a status summary object.
 */
export function mapContainerStatus(c: Docker.ContainerInfo) {
  return {
    serviceName: c.Labels['mini-infra.service'] ?? 'unknown',
    containerId: c.Id,
    containerName: c.Names?.[0]?.replace(/^\//, '') ?? '',
    image: c.Image,
    state: c.State,
    status: c.Status,
  };
}

/**
 * Build a Map of containers keyed by service name from a container list.
 */
export function buildContainerMap(containers: Docker.ContainerInfo[]): Map<string, Docker.ContainerInfo> {
  const map = new Map<string, Docker.ContainerInfo>();
  for (const c of containers) {
    const sn = c.Labels['mini-infra.service'];
    if (sn) map.set(sn, c);
  }
  return map;
}

/**
 * Group items by a string property value.
 */
export function groupByProperty<T>(items: T[], key: keyof T): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const value = item[key] as unknown as string;
    const existing = map.get(value) ?? [];
    existing.push(item);
    map.set(value, existing);
  }
  return map;
}

/**
 * Build template context from a stack and its services.
 */
/**
 * Merge parameter values with definitions, filling in defaults for missing values.
 */
export function mergeParameterValues(
  definitions: StackParameterDefinition[],
  values: Record<string, StackParameterValue>
): Record<string, StackParameterValue> {
  const merged: Record<string, StackParameterValue> = {};
  for (const def of definitions) {
    merged[def.name] = values[def.name] ?? def.default;
  }
  return merged;
}

export function buildStackTemplateContext(
  stack: {
    id?: string;
    name: string;
    networks: unknown;
    volumes: unknown;
    services: Array<{
      serviceName: string;
      dockerImage: string;
      dockerTag: string;
      containerConfig: unknown;
    }>;
    // Accept Prisma's broader `string` for type/networkType and narrow inside.
    // The DB schema constrains these via the Environment row; downstream
    // template substitution treats them as opaque values.
    environment?: {
      id: string;
      name: string;
      type: string;
      networkType: string;
    } | null;
  },
  params?: Record<string, StackParameterValue>
) {
  return buildTemplateContext(
    {
      name: stack.name,
      networks: stack.networks as unknown as StackNetwork[],
      volumes: stack.volumes as unknown as StackVolume[],
    },
    stack.services.map((s) => ({
      serviceName: s.serviceName,
      dockerImage: s.dockerImage,
      dockerTag: s.dockerTag,
      containerConfig: s.containerConfig as unknown as StackContainerConfig,
    })),
    {
      stackId: stack.id,
      environment: stack.environment
        ? {
            id: stack.environment.id,
            name: stack.environment.name,
            type: stack.environment.type as import('@mini-infra/types').EnvironmentType,
            networkType: stack.environment.networkType as import('@mini-infra/types').EnvironmentNetworkType,
          }
        : undefined,
      params,
    }
  );
}

export interface ResolveServiceConfigsOptions {
  /**
   * Override the addon registry — tests use this to inject a registry
   * pre-populated with the no-op test addon. Defaults to
   * `productionAddonRegistry`, which now carries `tailscale-ssh` (Phase 3).
   */
  addonRegistry?: AddonRegistry;
  /** Per-(service, addon) progress callback; see `ExpansionProgress`. */
  expansionProgress?: ExpansionProgress;
  /** Pool-instance id when this expansion is for a single pool spawn. */
  instance?: { instanceId: string };
  /**
   * Connected-services lookup an addon's `provision()` may narrow at runtime
   * (e.g. the `tailscale-ssh` addon reads `lookup.tailscale`). Typed
   * `unknown` so the framework doesn't bind to a concrete server-side
   * service surface; addon implementations narrow to their concrete type.
   * Omitted in `plan()` flows where no provisioning runs.
   */
  connectedServices?: unknown;
  /**
   * When true, addon expansion runs as a read-only plan pass: `provision()`
   * and `buildServiceDefinition()` are skipped in favour of the addon's
   * `planStub()` (or a generic placeholder), so plan invocations don't mint
   * authkeys, hit external APIs, or produce synthetic-service hashes that
   * drift between runs. The apply path leaves this unset (defaults to false)
   * so real provisioning runs.
   */
  dryRun?: boolean;
}

/**
 * Resolve config files, run the Service Addons render pass, and compute
 * definition hashes for every rendered service in a stack.
 *
 * The addon expansion runs **before** template substitution and hashing so
 * that:
 *   - synthetic sidecars produced by addons flow through the same
 *     `{{params.X}}` / `{{volumes.Y}}` resolution as authored services;
 *   - the hash of the *authored* service includes the `addons:` block per
 *     §7 of the Service Addons plan (mint-once authkeys never leak in).
 *
 * With the production registry empty (Phase 1), the expansion is a
 * pass-through for every existing stack — output equals input modulo the
 * rendered services Map's iteration order.
 */
export async function resolveServiceConfigs(
  services: Array<{
    serviceName: string;
    serviceType: string;
    dockerImage: string;
    dockerTag: string;
    containerConfig: unknown;
    configFiles: unknown;
    initCommands: unknown;
    dependsOn: unknown;
    order: number;
    routing: unknown;
    adoptedContainer?: unknown;
    poolConfig?: unknown;
    jobPoolConfig?: unknown;
    vaultAppRoleId?: string | null;
    vaultAppRoleRef?: string | null;
    natsCredentialId?: string | null;
    addons?: unknown;
  }>,
  templateContext: ReturnType<typeof buildTemplateContext>,
  options: ResolveServiceConfigsOptions = {},
): Promise<{
  resolvedConfigsMap: Map<string, StackConfigFile[]>;
  resolvedDefinitions: Map<string, StackServiceDefinition>;
  serviceHashes: Map<string, string>;
}> {
  const resolvedConfigsMap = new Map<string, StackConfigFile[]>();
  const resolvedDefinitions = new Map<string, StackServiceDefinition>();
  const serviceHashes = new Map<string, string>();

  // Step 1 — convert each Prisma row into the portable definition shape
  // (with the optional addons block carried through). Configs files are
  // tracked in parallel so synthetic sidecars added by expandAddons can
  // pick up an empty bucket without disturbing authored ones.
  //
  // The authored `addons:` block per service is captured separately so
  // we can re-attach it when hashing the rendered target — `expandAddons`
  // strips the field from its output (the rendered form has no authoring
  // artifact), but §7 of the Service Addons plan requires the hash to be
  // computed from the *authored* definition + addon-config, not the
  // rendered form, so addon-config changes still trigger a recreate.
  const authoredAddonsByName = new Map<string, Record<string, unknown> | undefined>();
  const authoredDefs: StackServiceDefinition[] = [];
  for (const svc of services) {
    const def = toServiceDefinition(svc);
    authoredAddonsByName.set(svc.serviceName, def.addons);
    authoredDefs.push(def);
    resolvedConfigsMap.set(
      svc.serviceName,
      resolveStackConfigFiles(
        (svc.configFiles as unknown as StackConfigFile[]) ?? [],
        templateContext,
      ),
    );
  }

  // Step 2 — addon expansion. With the production registry empty (Phase 1),
  // this is a pass-through that just strips the (also-absent) `addons:`
  // field from each output service. Tests opt-in by passing a populated
  // registry via `options.addonRegistry`.
  const renderedDefs = await expandAddons(
    authoredDefs,
    {
      registry: options.addonRegistry ?? productionAddonRegistry,
      stack: {
        id: templateContext.stack.id ?? '',
        name: templateContext.stack.name,
      },
      environment: templateContext.environment
        ? {
            id: templateContext.environment.id,
            name: templateContext.environment.name,
            networkType: templateContext.environment.networkType,
          }
        : { id: '', name: '', networkType: 'local' },
      instance: options.instance,
      connectedServices: options.connectedServices,
      dryRun: options.dryRun,
    },
    options.expansionProgress,
  );

  // Step 3 — template-resolve and hash each rendered service. Synthetic
  // sidecars share the per-stack template context with the authored ones
  // they wrap.
  for (const def of renderedDefs) {
    const resolvedConfigs =
      resolvedConfigsMap.get(def.serviceName) ??
      resolveStackConfigFiles(def.configFiles ?? [], templateContext);
    if (!resolvedConfigsMap.has(def.serviceName)) {
      resolvedConfigsMap.set(def.serviceName, resolvedConfigs);
    }
    const resolvedDef = resolveServiceDefinition(def, templateContext);
    resolvedDefinitions.set(def.serviceName, resolvedDef);
    // Hash the resolved definition so parameter value changes trigger
    // recreates. Three cases:
    //
    // 1. Authored services: re-attach the authored `addons:` block (stripped
    //    on the render output) so addon-config changes recreate the target,
    //    without leaking provisioned values into the hash. Definition-hash.ts
    //    §7 invariant.
    // 2. Synthetic sidecars: hash the *authoring intent* (synthetic info +
    //    target's authored addon configs). Hashing the rendered sidecar
    //    directly would include per-mint env (TS_AUTHKEY etc.) and drift
    //    every apply, so plan would always say "recreate".
    // 3. Pre-existing services with neither: hash the resolved def as-is.
    const authoredAddons = authoredAddonsByName.get(def.serviceName);
    if (def.synthetic) {
      const targetAuthoredAddons = authoredAddonsByName.get(def.synthetic.targetService);
      serviceHashes.set(
        def.serviceName,
        computeSyntheticDefinitionHash(def.synthetic, targetAuthoredAddons),
      );
    } else {
      const defForHash =
        authoredAddons !== undefined
          ? { ...resolvedDef, addons: authoredAddons }
          : resolvedDef;
      serviceHashes.set(
        def.serviceName,
        computeDefinitionHash(defForHash, resolvedConfigs),
      );
    }
  }

  return { resolvedConfigsMap, resolvedDefinitions, serviceHashes };
}

/**
 * Convert a Prisma service record to a StackServiceDefinition.
 */
export function toServiceDefinition(svc: {
  serviceName: string;
  serviceType: string;
  dockerImage: string;
  dockerTag: string;
  containerConfig: unknown;
  configFiles: unknown;
  initCommands: unknown;
  dependsOn: unknown;
  order: number;
  routing: unknown;
  adoptedContainer?: unknown;
  poolConfig?: unknown;
  jobPoolConfig?: unknown;
  vaultAppRoleId?: string | null;
  vaultAppRoleRef?: string | null;
  natsCredentialId?: string | null;
  addons?: unknown;
}): StackServiceDefinition {
  return {
    serviceName: svc.serviceName,
    serviceType: svc.serviceType as StackServiceDefinition['serviceType'],
    dockerImage: svc.dockerImage,
    dockerTag: svc.dockerTag,
    containerConfig: svc.containerConfig as StackContainerConfig,
    configFiles: (svc.configFiles as unknown as StackConfigFile[]) ?? undefined,
    initCommands: (svc.initCommands as unknown as StackServiceDefinition['initCommands']) ?? undefined,
    dependsOn: svc.dependsOn as string[],
    order: svc.order,
    routing: (svc.routing as unknown as StackServiceDefinition['routing']) ?? undefined,
    adoptedContainer: (svc.adoptedContainer as unknown as StackServiceDefinition['adoptedContainer']) ?? undefined,
    poolConfig: (svc.poolConfig as unknown as StackServiceDefinition['poolConfig']) ?? undefined,
    jobPoolConfig: (svc.jobPoolConfig as unknown as StackServiceDefinition['jobPoolConfig']) ?? undefined,
    vaultAppRoleId: svc.vaultAppRoleId ?? undefined,
    vaultAppRoleRef: svc.vaultAppRoleRef ?? undefined,
    natsCredentialId: svc.natsCredentialId ?? undefined,
    addons:
      svc.addons && typeof svc.addons === 'object'
        ? (svc.addons as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Name of the network mini-infra synthesises for multi-service stacks that
 * declare `networks: []`. Mirrors docker-compose's `<project>_default` so
 * services can reach each other by service name on a shared bridge network.
 */
export const DEFAULT_STACK_NETWORK_NAME = 'default';

/**
 * If a stack has 2+ container-bearing services and no declared networks,
 * synthesise a single `default` network so the services share a bridge with
 * DNS by service name. Single-service and Pool-only stacks keep `networks: []`
 * unchanged — they have no DNS resolution problem to solve.
 */
export function synthesiseDefaultNetworkIfNeeded(
  declaredNetworks: StackNetwork[],
  services: Array<{ serviceType: string }>,
  log?: { info: (obj: object, msg: string) => void },
): StackNetwork[] {
  if (declaredNetworks.length > 0) return declaredNetworks;
  // Pool services don't run a container at apply time; AdoptedWeb attaches
  // to an externally-managed container. Only count types whose containers
  // mini-infra creates and that would otherwise land on the host bridge.
  const containerBearing = services.filter(
    (s) => s.serviceType === 'Stateful' || s.serviceType === 'StatelessWeb',
  );
  if (containerBearing.length < 2) return declaredNetworks;
  log?.info(
    { serviceCount: containerBearing.length },
    `Synthesising '${DEFAULT_STACK_NETWORK_NAME}' network for multi-service stack`,
  );
  return [{ name: DEFAULT_STACK_NETWORK_NAME, driver: 'bridge' }];
}

/**
 * Pull image, run init commands, and write config files for a service.
 * Common preparation step before creating a container.
 *
 * Takes the *resolved* service definition (post template-substitution) so
 * `dockerImage` / `dockerTag` references like `{{params.foo}}` are expanded
 * before the pull is dispatched to Docker.
 */
export async function prepareServiceContainer(
  containerManager: StackContainerManager,
  serviceDef: Pick<StackServiceDefinition, 'dockerImage' | 'dockerTag' | 'initCommands'>,
  resolvedConfigs: StackConfigFile[],
  projectName: string
): Promise<void> {
  await containerManager.pullImage(serviceDef.dockerImage, serviceDef.dockerTag);

  const initCmds = serviceDef.initCommands ?? [];
  if (initCmds.length > 0) {
    await containerManager.runInitCommands(initCmds, projectName);
  }

  if (resolvedConfigs.length > 0) {
    await containerManager.writeConfigFiles(resolvedConfigs, projectName);
  }
}
