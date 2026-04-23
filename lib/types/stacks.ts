// ====================
// Stack Types
// ====================

// Status and service type unions (mirror Prisma enums)
export type StackStatus = 'synced' | 'drifted' | 'pending' | 'error' | 'undeployed' | 'removed';
export const STACK_SERVICE_TYPES = ['Stateful', 'StatelessWeb', 'AdoptedWeb'] as const;
export type StackServiceType = typeof STACK_SERVICE_TYPES[number];
export type ServiceActionType = 'create' | 'recreate' | 'remove' | 'no-op';

// Stack parameter types

export const STACK_PARAMETER_TYPES = ['string', 'number', 'boolean'] as const;
export type StackParameterType = typeof STACK_PARAMETER_TYPES[number];

export type StackParameterValue = string | number | boolean;

export interface StackParameterDefinition {
  name: string;
  type: StackParameterType;
  description?: string;
  default: StackParameterValue;
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    options?: StackParameterValue[];
  };
}

// JSON field shape interfaces

export const RESTART_POLICIES = ['no', 'always', 'unless-stopped', 'on-failure'] as const;
export const BALANCE_ALGORITHMS = ['roundrobin', 'leastconn', 'source'] as const;
export const NETWORK_PROTOCOLS = ['tcp', 'udp'] as const;
export const MOUNT_TYPES = ['volume', 'bind'] as const;

/**
 * Source of a dynamically-resolved environment variable, resolved at apply time
 * by the stack reconciler (NOT at template/plan time). Vault-backed dynamic
 * values never appear in the stack definition hash or applied snapshot.
 *
 * Also re-exported from `./vault` for consumers that import vault types.
 */
export type DynamicEnvSource =
  | { kind: 'vault-addr' }
  | { kind: 'vault-role-id' }
  | { kind: 'vault-wrapped-secret-id'; ttlSeconds?: number };

// Numeric fields in stack definitions may be literal integers *or* a
// "{{params.name}}" template reference that gets resolved at instantiation.
// The resolved runtime value is always a number.
export type NumOrTemplate = number | string;

export interface StackContainerConfig {
  command?: string[];
  entrypoint?: string[];
  user?: string;
  env?: Record<string, string>;
  /**
   * Environment variables resolved at apply time (e.g. vault wrapped secret_id).
   * Keys must NOT overlap with `env`. These values are:
   *  - excluded from `definition-hash.ts` so they don't spuriously mark drift;
   *  - preserved as-is (not resolved) in the applied snapshot;
   *  - materialised into real env vars between image pull and container start.
   */
  dynamicEnv?: Record<string, DynamicEnvSource>;
  ports?: { containerPort: NumOrTemplate; hostPort: NumOrTemplate; protocol: 'tcp' | 'udp'; exposeOnHost?: boolean | string }[];
  mounts?: { source: string; target: string; type: typeof MOUNT_TYPES[number]; readOnly?: boolean }[];
  labels?: Record<string, string>;
  joinNetworks?: string[];
  joinResourceNetworks?: string[];
  restartPolicy?: typeof RESTART_POLICIES[number];
  healthcheck?: {
    test: string[];
    interval: NumOrTemplate;
    timeout: NumOrTemplate;
    retries: NumOrTemplate;
    startPeriod: NumOrTemplate;
  };
  logConfig?: {
    type: string;
    maxSize: string;
    maxFile: string;
  };
}

export interface StackConfigFile {
  volumeName: string;
  path: string;
  content: string;
  permissions?: string;
  ownerUid?: number;
  ownerGid?: number;
}

export interface StackInitCommand {
  volumeName: string;
  mountPath: string;
  commands: string[];
}

export interface AdoptedContainerRef {
  containerName: string;
  listeningPort: number;
}

export interface StackServiceRouting {
  hostname: string;
  listeningPort: NumOrTemplate;
  healthCheckEndpoint?: string;
  tlsCertificate?: string;
  dnsRecord?: string;
  tunnelIngress?: string;
  backendOptions?: {
    balanceAlgorithm?: typeof BALANCE_ALGORITHMS[number];
    checkTimeout?: NumOrTemplate;
    connectTimeout?: NumOrTemplate;
    serverTimeout?: NumOrTemplate;
  };
}

export interface StackNetwork {
  name: string;
  driver?: string;
  options?: Record<string, any>;
}

export interface StackResourceOutput {
  type: string;
  purpose: string;
  joinSelf?: boolean;
}

export interface StackResourceInput {
  type: string;
  purpose: string;
  optional?: boolean;
}

export interface StackVolume {
  name: string;
  driver?: string;
  options?: Record<string, any>;
}

export interface StackTlsCertificate {
  name: string;
  fqdn: string;
}

export interface StackDnsRecord {
  name: string;
  fqdn: string;
  recordType: 'A';
  target: string;
  ttl?: number;
  proxied?: boolean;
}

export interface StackTunnelIngress {
  name: string;
  fqdn: string;
  service: string;
}

// DB model types (Date fields)

export interface Stack {
  id: string;
  name: string;
  description: string | null;
  environmentId: string | null;
  version: number;
  status: StackStatus;
  lastAppliedVersion: number | null;
  lastAppliedAt: Date | null;
  lastAppliedSnapshot: StackDefinition | null;
  builtinVersion: number | null;
  templateId: string | null;
  templateVersion: number | null;
  parameters: StackParameterDefinition[];
  parameterValues: Record<string, StackParameterValue>;
  resourceOutputs: StackResourceOutput[];
  resourceInputs: StackResourceInput[];
  networks: StackNetwork[];
  volumes: StackVolume[];
  tlsCertificates: StackTlsCertificate[];
  dnsRecords: StackDnsRecord[];
  tunnelIngress: StackTunnelIngress[];
  createdAt: Date;
  updatedAt: Date;
  services?: StackService[];
}

export interface StackService {
  id: string;
  stackId: string;
  serviceName: string;
  serviceType: StackServiceType;
  dockerImage: string;
  dockerTag: string;
  containerConfig: StackContainerConfig;
  configFiles: StackConfigFile[] | null;
  initCommands: StackInitCommand[] | null;
  dependsOn: string[];
  order: number;
  routing: StackServiceRouting | null;
  adoptedContainer: AdoptedContainerRef | null;
  createdAt: Date;
  updatedAt: Date;
}

// API response types (string dates)

export interface StackInfo {
  id: string;
  name: string;
  description: string | null;
  environmentId: string | null;
  version: number;
  status: StackStatus;
  lastAppliedVersion: number | null;
  lastAppliedAt: string | null;
  lastAppliedSnapshot: StackDefinition | null;
  builtinVersion: number | null;
  templateId: string | null;
  templateVersion: number | null;
  templateUpdateAvailable?: boolean;
  parameters: StackParameterDefinition[];
  parameterValues: Record<string, StackParameterValue>;
  resourceOutputs: StackResourceOutput[];
  resourceInputs: StackResourceInput[];
  networks: StackNetwork[];
  volumes: StackVolume[];
  tlsCertificates: StackTlsCertificate[];
  dnsRecords: StackDnsRecord[];
  tunnelIngress: StackTunnelIngress[];
  createdAt: string;
  updatedAt: string;
  services?: StackServiceInfo[];
}

export interface StackServiceInfo {
  id: string;
  stackId: string;
  serviceName: string;
  serviceType: StackServiceType;
  dockerImage: string;
  dockerTag: string;
  containerConfig: StackContainerConfig;
  configFiles: StackConfigFile[] | null;
  initCommands: StackInitCommand[] | null;
  dependsOn: string[];
  order: number;
  routing: StackServiceRouting | null;
  adoptedContainer: AdoptedContainerRef | null;
  createdAt: string;
  updatedAt: string;
}

// Portable definition types (no DB fields — used for snapshots/export)

export interface StackServiceDefinition {
  serviceName: string;
  serviceType: StackServiceType;
  dockerImage: string;
  dockerTag: string;
  containerConfig: StackContainerConfig;
  configFiles?: StackConfigFile[];
  initCommands?: StackInitCommand[];
  dependsOn: string[];
  order: number;
  routing?: StackServiceRouting;
  adoptedContainer?: AdoptedContainerRef;
}

export interface StackDefinition {
  name: string;
  description?: string;
  parameters?: StackParameterDefinition[];
  resourceOutputs?: StackResourceOutput[];
  resourceInputs?: StackResourceInput[];
  networks: StackNetwork[];
  volumes: StackVolume[];
  tlsCertificates?: StackTlsCertificate[];
  dnsRecords?: StackDnsRecord[];
  tunnelIngress?: StackTunnelIngress[];
  services: StackServiceDefinition[];
}

// Serialize/deserialize helpers

export function serializeStack(
  stack: Stack & { services: StackService[] }
): StackDefinition {
  return {
    name: stack.name,
    description: stack.description ?? undefined,
    parameters: stack.parameters?.length > 0 ? stack.parameters : undefined,
    resourceOutputs: stack.resourceOutputs?.length > 0 ? stack.resourceOutputs : undefined,
    resourceInputs: stack.resourceInputs?.length > 0 ? stack.resourceInputs : undefined,
    networks: stack.networks,
    volumes: stack.volumes,
    tlsCertificates: stack.tlsCertificates?.length > 0 ? stack.tlsCertificates : undefined,
    dnsRecords: stack.dnsRecords?.length > 0 ? stack.dnsRecords : undefined,
    tunnelIngress: stack.tunnelIngress?.length > 0 ? stack.tunnelIngress : undefined,
    services: stack.services.map((s) => ({
      serviceName: s.serviceName,
      serviceType: s.serviceType,
      dockerImage: s.dockerImage,
      dockerTag: s.dockerTag,
      containerConfig: s.containerConfig,
      configFiles: s.configFiles ?? undefined,
      initCommands: s.initCommands ?? undefined,
      dependsOn: s.dependsOn,
      order: s.order,
      routing: s.routing ?? undefined,
      adoptedContainer: s.adoptedContainer ?? undefined,
    })),
  };
}

export interface CreateStackInput {
  name: string;
  description?: string;
  environmentId?: string;
  parameters?: StackParameterDefinition[];
  parameterValues?: Record<string, StackParameterValue>;
  resourceOutputs?: StackResourceOutput[];
  resourceInputs?: StackResourceInput[];
  networks: StackNetwork[];
  volumes: StackVolume[];
  tlsCertificates?: StackTlsCertificate[];
  dnsRecords?: StackDnsRecord[];
  tunnelIngress?: StackTunnelIngress[];
  services: StackServiceDefinition[];
}

export function deserializeStack(
  definition: StackDefinition,
  environmentId?: string
): CreateStackInput {
  return {
    name: definition.name,
    description: definition.description,
    environmentId,
    parameters: definition.parameters,
    resourceOutputs: definition.resourceOutputs,
    resourceInputs: definition.resourceInputs,
    networks: definition.networks,
    volumes: definition.volumes,
    tlsCertificates: definition.tlsCertificates,
    dnsRecords: definition.dnsRecords,
    tunnelIngress: definition.tunnelIngress,
    services: definition.services,
  };
}

// Plan warnings

export interface PortConflictWarning {
  type: 'port-conflict';
  serviceName: string;
  hostPort: number;
  protocol: 'tcp' | 'udp';
  conflictingContainerName: string;
  conflictingStackName?: string;
  message: string;
}

export interface NameConflictWarning {
  type: 'name-conflict';
  serviceName: string;
  desiredContainerName: string;
  conflictingContainerId: string;
  conflictingStackName?: string;
  message: string;
}

export interface ResourceReferenceWarning {
  type: 'resource-reference';
  serviceName: string;
  resourceName: string;
  resourceType: ResourceType;
  message: string;
}

export interface AdoptedContainerWarning {
  type: 'adopted-container';
  serviceName: string;
  containerName: string;
  issue: 'missing' | 'not-running';
  message: string;
}

export type PlanWarning = PortConflictWarning | NameConflictWarning | ResourceReferenceWarning | AdoptedContainerWarning;

// Reconciler types

export interface StackPlan {
  stackId: string;
  stackName: string;
  stackVersion: number;
  planTime: string;
  actions: ServiceAction[];
  resourceActions: ResourceAction[];
  hasChanges: boolean;
  templateUpdateAvailable?: boolean;
  warnings?: PlanWarning[];
}

export interface ServiceAction {
  serviceName: string;
  action: ServiceActionType;
  reason?: string;
  diff?: FieldDiff[];
  currentImage?: string;
  desiredImage?: string;
}

export interface FieldDiff {
  field: string;
  old: string | null;
  new: string | null;
}

export type ResourceType = 'tls' | 'dns' | 'tunnel';

export interface ResourceAction {
  resourceType: ResourceType;
  resourceName: string;
  action: 'create' | 'update' | 'remove' | 'no-op';
  reason?: string;
  diff?: FieldDiff[];
}

export interface ResourceResult {
  resourceType: ResourceType;
  resourceName: string;
  action: string;
  success: boolean;
  error?: string;
}

// Apply types

export interface ApplyOptions {
  serviceNames?: string[];
  dryRun?: boolean;
  /** Pull all images and recreate containers whose image digest changed */
  forcePull?: boolean;
  triggeredBy?: string;
  /** Pre-computed plan to avoid re-computing inside apply() */
  plan?: StackPlan;
  /** Called after each service or resource action completes */
  onProgress?: (result: ServiceApplyResult | ResourceResult, completedCount: number, totalActions: number) => void;
}

export interface UpdateOptions {
  triggeredBy?: string;
  /** Force-recreate all services even when definitions haven't changed */
  forceRecreate?: boolean;
  /** Called after each service action completes */
  onProgress?: (result: ServiceApplyResult, completedCount: number, totalActions: number) => void;
}

export interface ApplyResult {
  success: boolean;
  stackId: string;
  appliedVersion: number;
  serviceResults: ServiceApplyResult[];
  resourceResults: ResourceResult[];
  duration: number;
}

export interface ServiceApplyResult {
  serviceName: string;
  action: string;
  success: boolean;
  duration: number;
  error?: string;
  containerId?: string;
}

export interface DestroyResult {
  success: boolean;
  stackId: string;
  containersRemoved: number;
  networksRemoved: string[];
  volumesRemoved: string[];
  duration: number;
  error?: string;
}

// Deployment history

export interface StackDeploymentRecord {
  id: string;
  stackId: string;
  action: 'apply' | 'stop' | 'destroy';
  success: boolean;
  version: number | null;
  status: StackStatus;
  duration: number | null;
  serviceResults: ServiceApplyResult[] | null;
  resourceResults: ResourceResult[] | null;
  error: string | null;
  triggeredBy: string | null;
  createdAt: string;
}

// API request types

export interface CreateStackRequest {
  name: string;
  description?: string;
  environmentId?: string;
  parameters?: StackParameterDefinition[];
  parameterValues?: Record<string, StackParameterValue>;
  resourceOutputs?: StackResourceOutput[];
  resourceInputs?: StackResourceInput[];
  networks: StackNetwork[];
  volumes: StackVolume[];
  tlsCertificates?: StackTlsCertificate[];
  dnsRecords?: StackDnsRecord[];
  tunnelIngress?: StackTunnelIngress[];
  services: StackServiceDefinition[];
}

export interface UpdateStackRequest {
  name?: string;
  description?: string;
  parameters?: StackParameterDefinition[];
  parameterValues?: Record<string, StackParameterValue>;
  resourceOutputs?: StackResourceOutput[];
  resourceInputs?: StackResourceInput[];
  networks?: StackNetwork[];
  volumes?: StackVolume[];
  tlsCertificates?: StackTlsCertificate[];
  dnsRecords?: StackDnsRecord[];
  tunnelIngress?: StackTunnelIngress[];
  services?: StackServiceDefinition[];
}

export interface UpdateStackServiceRequest {
  serviceType?: StackServiceType;
  dockerImage?: string;
  dockerTag?: string;
  containerConfig?: StackContainerConfig;
  configFiles?: StackConfigFile[];
  initCommands?: StackInitCommand[];
  dependsOn?: string[];
  order?: number;
  routing?: StackServiceRouting | null;
}

export interface ApplyStackRequest {
  serviceNames?: string[];
  dryRun?: boolean;
  /** Pull all images and recreate containers whose image digest changed */
  forcePull?: boolean;
}

// API response types

export interface StackResponse {
  success: boolean;
  data: StackInfo;
  message?: string;
}

export interface StackListResponse {
  success: boolean;
  data: StackInfo[];
  message?: string;
}

export interface StackPlanResponse {
  success: boolean;
  data: StackPlan;
  message?: string;
}

export interface StackApplyResponse {
  success: boolean;
  data: ApplyResult;
  message?: string;
}

export interface StackApplyStartedResponse {
  success: boolean;
  data: { started: true; stackId: string };
  message?: string;
}

export interface StackValidationError {
  name: string;
  description?: string;
  error: string;
}

export interface StackValidationResult {
  success: boolean;
  valid: boolean;
  errors: StackValidationError[];
}

// ====================
// Stack Adoption Types
// ====================

// Container eligible for adoption into an AdoptedWeb stack service.
// NOTE: This is distinct from EligibleContainer in deployments.ts, which is
// for the HAProxy manual-frontend context.
export interface StackAdoptionCandidate {
  id: string;
  name: string;
  image: string;
  imageTag: string;
  status: string;
  ports: Array<{ containerPort: number; protocol: string }>;
  isSelf: boolean;
  isManagedByStack: boolean;
  managedByStack?: string;
}

export interface StackAdoptionCandidatesResponse {
  success: boolean;
  data: StackAdoptionCandidate[];
  message?: string;
}
