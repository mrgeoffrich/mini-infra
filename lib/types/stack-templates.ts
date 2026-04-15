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
}

export interface PublishDraftRequest {
  notes?: string;
}

export interface CreateStackFromTemplateRequest {
  templateId: string;
  name?: string;
  environmentId?: string;
  parameterValues?: Record<string, StackParameterValue>;
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
