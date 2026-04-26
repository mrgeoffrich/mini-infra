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
} from '@mini-infra/types';
import { buildTemplateContext, resolveStackConfigFiles, resolveServiceDefinition } from './template-engine';
import { computeDefinitionHash } from './definition-hash';
import { StackContainerManager } from './stack-container-manager';

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
  template?: { currentVersion?: { version: number } | null } | null;
  tlsCertificates?: unknown;
  dnsRecords?: unknown;
  tunnelIngress?: unknown;
  lastAppliedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  services?: SerializableService[];
  [key: string]: unknown;
};

type SerializableService = {
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
};

/**
 * Serialize a Prisma stack (with Date objects) to the API response shape (ISO strings).
 */
export function serializeStack(stack: SerializableStack): StackInfo {
  return {
    ...stack,
    parameters: stack.parameters ?? [],
    parameterValues: stack.parameterValues ?? {},
    resourceOutputs: stack.resourceOutputs ?? [],
    resourceInputs: stack.resourceInputs ?? [],
    templateId: stack.templateId ?? null,
    templateVersion: stack.templateVersion ?? null,
    templateUpdateAvailable: computeTemplateUpdateAvailable(stack),
    tlsCertificates: stack.tlsCertificates ?? [],
    dnsRecords: stack.dnsRecords ?? [],
    tunnelIngress: stack.tunnelIngress ?? [],
    lastAppliedAt: stack.lastAppliedAt?.toISOString() ?? null,
    createdAt: stack.createdAt.toISOString(),
    updatedAt: stack.updatedAt.toISOString(),
    services: stack.services?.map(serializeService),
  } as StackInfo;
}

function computeTemplateUpdateAvailable(stack: SerializableStack): boolean {
  if (!stack.templateVersion || !stack.template?.currentVersion) return false;
  return stack.template.currentVersion.version > stack.templateVersion;
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
    vaultAppRoleId: s.vaultAppRoleId ?? null,
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

/**
 * Resolve config files and compute definition hashes for all services in a stack.
 */
export function resolveServiceConfigs(
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
    vaultAppRoleId?: string | null;
  }>,
  templateContext: ReturnType<typeof buildTemplateContext>
): {
  resolvedConfigsMap: Map<string, StackConfigFile[]>;
  resolvedDefinitions: Map<string, StackServiceDefinition>;
  serviceHashes: Map<string, string>;
} {
  const resolvedConfigsMap = new Map<string, StackConfigFile[]>();
  const resolvedDefinitions = new Map<string, StackServiceDefinition>();
  const serviceHashes = new Map<string, string>();

  for (const svc of services) {
    const resolvedConfigs = resolveStackConfigFiles(
      (svc.configFiles as unknown as StackConfigFile[]) ?? [],
      templateContext
    );
    resolvedConfigsMap.set(svc.serviceName, resolvedConfigs);

    const def = toServiceDefinition(svc);
    const resolvedDef = resolveServiceDefinition(def, templateContext);
    resolvedDefinitions.set(svc.serviceName, resolvedDef);

    // Hash the resolved definition so parameter value changes trigger recreates
    serviceHashes.set(svc.serviceName, computeDefinitionHash(resolvedDef, resolvedConfigs));
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
  vaultAppRoleId?: string | null;
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
    vaultAppRoleId: svc.vaultAppRoleId ?? undefined,
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
