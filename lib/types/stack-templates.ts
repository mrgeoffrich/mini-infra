// ====================
// Stack Template Types
// ====================

import type {
  StackParameterDefinition,
  StackParameterValue,
  StackNetwork,
  StackVolume,
  StackContainerConfig,
  StackInitCommand,
  StackServiceRouting,
  StackServiceType,
  StackServiceDefinition,
  StackResourceOutput,
  StackResourceInput,
  AdoptedContainerRef,
  PoolConfig,
} from './stacks';
import type { EnvironmentNetworkType } from './environments';

// Enum mirrors
export type StackTemplateSource = 'system' | 'user';
export const STACK_TEMPLATE_SCOPES = ['host', 'environment', 'any'] as const;
export type StackTemplateScope = typeof STACK_TEMPLATE_SCOPES[number];
export type StackTemplateVersionStatus = 'draft' | 'published' | 'archived';

// DB model types (Date fields)

export interface StackTemplate {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  source: StackTemplateSource;
  scope: StackTemplateScope;
  networkType: EnvironmentNetworkType | null;
  category: string | null;
  environmentId: string | null;
  isArchived: boolean;
  currentVersionId: string | null;
  draftVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: string | null;
  currentVersion?: StackTemplateVersion | null;
  draftVersion?: StackTemplateVersion | null;
  versions?: StackTemplateVersion[];
}

export interface StackTemplateVersion {
  id: string;
  templateId: string;
  version: number;
  status: StackTemplateVersionStatus;
  notes: string | null;
  parameters: StackParameterDefinition[];
  defaultParameterValues: Record<string, StackParameterValue>;
  networkTypeDefaults?: Record<string, Record<string, StackParameterValue>>;
  resourceOutputs?: StackResourceOutput[];
  resourceInputs?: StackResourceInput[];
  networks: StackNetwork[];
  volumes: StackVolume[];
  publishedAt: Date | null;
  createdAt: Date;
  createdById: string | null;
  services?: StackTemplateService[];
  configFiles?: StackTemplateConfigFile[];
}

export interface StackTemplateService {
  id: string;
  versionId: string;
  serviceName: string;
  serviceType: StackServiceType;
  dockerImage: string;
  dockerTag: string;
  containerConfig: StackContainerConfig;
  initCommands: StackInitCommand[] | null;
  dependsOn: string[];
  order: number;
  routing: StackServiceRouting | null;
}

export interface StackTemplateConfigFile {
  id: string;
  versionId: string;
  serviceName: string;
  fileName: string;
  volumeName: string;
  mountPath: string;
  content: string;
  permissions: string | null;
  owner: string | null;
}

// API response types (string dates)

export interface StackTemplateLinkedStack {
  id: string;
  name: string;
  status: string;
  version: number;
  lastAppliedVersion: number | null;
  lastAppliedAt: string | null;
  environmentId: string | null;
}

export interface StackTemplateInfo {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  source: StackTemplateSource;
  scope: StackTemplateScope;
  networkType: EnvironmentNetworkType | null;
  category: string | null;
  environmentId: string | null;
  isArchived: boolean;
  currentVersionId: string | null;
  draftVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  createdById: string | null;
  currentVersion?: StackTemplateVersionInfo | null;
  draftVersion?: StackTemplateVersionInfo | null;
  linkedStacks?: StackTemplateLinkedStack[];
}

// Input declarations that template authors include in a template draft.
// Sensitive values are encrypted at rest on the Stack row when instantiated.
export interface TemplateInputDeclaration {
  name: string;
  description?: string;
  sensitive: boolean;
  required: boolean;
  rotateOnUpgrade: boolean;
}

// Vault dependency surface declared by a template author.
export interface TemplateVaultPolicy {
  name: string;
  body: string;
  scope: 'host' | 'environment' | 'stack';
  description?: string;
}

export interface TemplateVaultAppRole {
  name: string;
  policy: string;
  scope: 'host' | 'environment' | 'stack';
  tokenPeriod?: string;
  tokenTtl?: string;
  tokenMaxTtl?: string;
  secretIdNumUses?: number;
  secretIdTtl?: string;
}

export type TemplateKvFieldValue =
  | { fromInput: string }
  | { value: string };

export interface TemplateVaultKv {
  path: string;
  fields: Record<string, TemplateKvFieldValue>;
}

export interface TemplateVaultSection {
  policies?: TemplateVaultPolicy[];
  appRoles?: TemplateVaultAppRole[];
  kv?: TemplateVaultKv[];
}

export interface TemplateNatsAccount {
  name: string;
  displayName?: string;
  description?: string;
  scope: 'host' | 'environment' | 'stack';
}

export interface TemplateNatsCredential {
  name: string;
  account: string;
  displayName?: string;
  description?: string;
  publishAllow: string[];
  subscribeAllow: string[];
  ttlSeconds?: number;
  scope: 'host' | 'environment' | 'stack';
}

export interface TemplateNatsStream {
  name: string;
  account: string;
  description?: string;
  subjects: string[];
  retention?: 'limits' | 'interest' | 'workqueue';
  storage?: 'file' | 'memory';
  maxMsgs?: number | null;
  maxBytes?: number | null;
  maxAgeSeconds?: number | null;
  scope: 'host' | 'environment' | 'stack';
}

export interface TemplateNatsConsumer {
  name: string;
  stream: string;
  durableName?: string;
  description?: string;
  filterSubject?: string;
  deliverPolicy?: 'all' | 'last' | 'new' | 'by_start_sequence' | 'by_start_time' | 'last_per_subject';
  ackPolicy?: 'none' | 'all' | 'explicit';
  maxDeliver?: number | null;
  ackWaitSeconds?: number | null;
  scope: 'host' | 'environment' | 'stack';
}

export interface TemplateNatsSection {
  accounts?: TemplateNatsAccount[];
  credentials?: TemplateNatsCredential[];
  streams?: TemplateNatsStream[];
  consumers?: TemplateNatsConsumer[];
}

export interface StackTemplateVersionInfo {
  id: string;
  templateId: string;
  version: number;
  status: StackTemplateVersionStatus;
  notes: string | null;
  parameters: StackParameterDefinition[];
  defaultParameterValues: Record<string, StackParameterValue>;
  networkTypeDefaults?: Record<string, Record<string, StackParameterValue>>;
  resourceOutputs?: StackResourceOutput[];
  resourceInputs?: StackResourceInput[];
  networks: StackNetwork[];
  volumes: StackVolume[];
  publishedAt: string | null;
  createdAt: string;
  createdById: string | null;
  serviceCount?: number;
  serviceTypes?: StackServiceType[];
  services?: StackTemplateServiceInfo[];
  configFiles?: StackTemplateConfigFileInfo[];
  inputs?: TemplateInputDeclaration[];
  vault?: TemplateVaultSection;
  nats?: TemplateNatsSection;
}

export interface StackTemplateServiceInfo {
  id: string;
  versionId: string;
  serviceName: string;
  serviceType: StackServiceType;
  dockerImage: string;
  dockerTag: string;
  containerConfig: StackContainerConfig;
  initCommands: StackInitCommand[] | null;
  dependsOn: string[];
  order: number;
  routing: StackServiceRouting | null;
  adoptedContainer?: AdoptedContainerRef;
  poolConfig?: PoolConfig | null;
  vaultAppRoleId?: string | null;
  /** Symbolic AppRole name from vault.appRoles[]; resolved to vaultAppRoleId at apply time (PR 2). */
  vaultAppRoleRef?: string | null;
  natsCredentialId?: string | null;
  /** Symbolic credential name from nats.credentials[]; resolved to natsCredentialId at apply time. */
  natsCredentialRef?: string | null;
}

export interface StackTemplateConfigFileInfo {
  id: string;
  versionId: string;
  serviceName: string;
  fileName: string;
  volumeName: string;
  mountPath: string;
  content: string;
  permissions: string | null;
  owner: string | null;
}

// API request types

export interface CreateStackTemplateRequest {
  name: string;
  displayName: string;
  description?: string;
  scope: StackTemplateScope;
  networkType?: EnvironmentNetworkType;
  environmentId?: string;
  deployImmediately?: boolean;
  category?: string;
  parameters?: StackParameterDefinition[];
  defaultParameterValues?: Record<string, StackParameterValue>;
  networkTypeDefaults?: Record<string, Record<string, StackParameterValue>>;
  resourceOutputs?: StackResourceOutput[];
  resourceInputs?: StackResourceInput[];
  networks: StackNetwork[];
  volumes: StackVolume[];
  services: StackServiceDefinition[];
  configFiles?: StackTemplateConfigFileInput[];
  /** Optional input declarations persisted on the initial v0 draft. Matches
   *  DraftVersionInput.inputs — submit a complete spec in one request. */
  inputs?: TemplateInputDeclaration[];
  /** Optional vault section persisted on the initial v0 draft. Matches
   *  DraftVersionInput.vault. Triggers the template-vault:write permission
   *  gate at the route layer when non-empty. */
  vault?: TemplateVaultSection;
  /** Optional NATS section persisted on the initial v0 draft. Triggers the
   *  template-nats:write permission gate when non-empty. */
  nats?: TemplateNatsSection;
}

export interface StackTemplateConfigFileInput {
  serviceName: string;
  fileName: string;
  volumeName: string;
  mountPath: string;
  content: string;
  permissions?: string;
  owner?: string;
}

export interface UpdateStackTemplateRequest {
  displayName?: string;
  description?: string;
  category?: string;
}

export interface DraftVersionInput {
  parameters?: StackParameterDefinition[];
  defaultParameterValues?: Record<string, StackParameterValue>;
  networkTypeDefaults?: Record<string, Record<string, StackParameterValue>>;
  resourceOutputs?: StackResourceOutput[];
  resourceInputs?: StackResourceInput[];
  networks: StackNetwork[];
  volumes: StackVolume[];
  services: StackServiceDefinition[];
  configFiles?: StackTemplateConfigFileInput[];
  notes?: string;
  inputs?: TemplateInputDeclaration[];
  vault?: TemplateVaultSection;
  nats?: TemplateNatsSection;
}

export interface PublishDraftRequest {
  notes?: string;
}

export interface CreateStackFromTemplateRequest {
  templateId: string;
  name?: string;
  environmentId?: string;
  parameterValues?: Record<string, StackParameterValue>;
  inputValues?: Record<string, string>;
}

// API responses

export interface StackTemplateResponse {
  success: boolean;
  data: StackTemplateInfo;
  message?: string;
}

export interface StackTemplateListResponse {
  success: boolean;
  data: StackTemplateInfo[];
  message?: string;
}

export interface StackTemplateVersionResponse {
  success: boolean;
  data: StackTemplateVersionInfo;
  message?: string;
}

export interface StackTemplateVersionListResponse {
  success: boolean;
  data: StackTemplateVersionInfo[];
  message?: string;
}
