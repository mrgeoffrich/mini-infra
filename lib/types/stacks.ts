// ====================
// Stack Types
// ====================

// Status and service type unions (mirror Prisma enums)
export type StackStatus = 'synced' | 'drifted' | 'pending' | 'error' | 'undeployed';
export type StackServiceType = 'Stateful' | 'StatelessWeb';
export type ServiceActionType = 'create' | 'recreate' | 'remove' | 'no-op';

// JSON field shape interfaces

export interface StackContainerConfig {
  command?: string[];
  entrypoint?: string[];
  user?: string;
  env?: Record<string, string>;
  ports?: { containerPort: number; hostPort: number; protocol: 'tcp' | 'udp' }[];
  mounts?: { source: string; target: string; type: 'volume' | 'bind'; readOnly?: boolean }[];
  labels?: Record<string, string>;
  restartPolicy?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  healthcheck?: {
    test: string[];
    interval: number;
    timeout: number;
    retries: number;
    startPeriod: number;
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

export interface StackServiceRouting {
  hostname: string;
  listeningPort: number;
  enableSsl?: boolean;
  tlsCertificateId?: string;
  backendOptions?: {
    balanceAlgorithm?: 'roundrobin' | 'leastconn' | 'source';
    checkTimeout?: number;
    connectTimeout?: number;
    serverTimeout?: number;
  };
  dns?: {
    provider: 'cloudflare' | 'external';
    zoneId?: string;
    recordType?: 'A' | 'CNAME';
    proxied?: boolean;
  };
}

export interface StackNetwork {
  name: string;
  driver?: string;
  options?: Record<string, any>;
}

export interface StackVolume {
  name: string;
  driver?: string;
  options?: Record<string, any>;
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
  networks: StackNetwork[];
  volumes: StackVolume[];
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
  networks: StackNetwork[];
  volumes: StackVolume[];
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
}

export interface StackDefinition {
  name: string;
  description?: string;
  networks: StackNetwork[];
  volumes: StackVolume[];
  services: StackServiceDefinition[];
}

// Serialize/deserialize helpers

export function serializeStack(
  stack: Stack & { services: StackService[] }
): StackDefinition {
  return {
    name: stack.name,
    description: stack.description ?? undefined,
    networks: stack.networks,
    volumes: stack.volumes,
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
    })),
  };
}

export interface CreateStackInput {
  name: string;
  description?: string;
  environmentId?: string;
  networks: StackNetwork[];
  volumes: StackVolume[];
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
    networks: definition.networks,
    volumes: definition.volumes,
    services: definition.services,
  };
}

// Reconciler types

export interface StackPlan {
  stackId: string;
  stackName: string;
  stackVersion: number;
  planTime: string;
  actions: ServiceAction[];
  hasChanges: boolean;
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

// Apply types

export interface ApplyOptions {
  serviceNames?: string[];
  dryRun?: boolean;
  triggeredBy?: string;
}

export interface ApplyResult {
  success: boolean;
  stackId: string;
  appliedVersion: number;
  serviceResults: ServiceApplyResult[];
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

// Deployment history

export interface StackDeploymentRecord {
  id: string;
  stackId: string;
  action: 'apply' | 'stop';
  success: boolean;
  version: number | null;
  status: StackStatus;
  duration: number | null;
  serviceResults: ServiceApplyResult[] | null;
  error: string | null;
  triggeredBy: string | null;
  createdAt: string;
}

// API request types

export interface CreateStackRequest {
  name: string;
  description?: string;
  environmentId?: string;
  networks: StackNetwork[];
  volumes: StackVolume[];
  services: StackServiceDefinition[];
}

export interface UpdateStackRequest {
  name?: string;
  description?: string;
  networks?: StackNetwork[];
  volumes?: StackVolume[];
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
