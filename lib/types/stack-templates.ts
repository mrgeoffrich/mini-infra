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

/**
 * App-author-facing role declaration. Materializes into a NatsCredentialProfile
 * row at apply time, with the stack's resolved subjectPrefix prepended to every
 * publish/subscribe entry. Subject patterns are written *relative* to the
 * prefix — the orchestrator does the prepend.
 */
export interface TemplateNatsRole {
  name: string;
  publish?: string[];
  subscribe?: string[];
  /**
   * Controls `_INBOX.>` auto-injection for NATS request/reply ergonomics.
   * Default `'both'` injects in pub and sub (right for roles that initiate
   * AND respond to request/reply). `'reply'` = pub only (pure responder).
   * `'request'` = sub only (pure requester). `'none'` = no injection.
   */
  inboxAuto?: 'both' | 'reply' | 'request' | 'none';
  /**
   * NATS JetStream KV buckets the role needs read/write access to. Each
   * bucket `B` materializes into `$KV.B.>` on **both** publishAllow and
   * subscribeAllow — KV ops need pub (Put) and sub (Get/watch). KV
   * subjects live in the `$KV.>` system tree so they can't be expressed
   * via the relative `publish` / `subscribe` lists. Bucket names refer
   * to live JS KV buckets; they are NOT prefixed by the stack's
   * subjectPrefix.
   *
   * Used by the egress-fw-agent (ALT-27) for its 5 s health heartbeat
   * bucket. Future system templates use the same mechanism.
   */
  kvBuckets?: string[];
  /** Credential JWT TTL. Defaults to NatsCredentialProfile system default (3600s). */
  ttlSeconds?: number;
}

/**
 * App-author-facing signer declaration. Materializes a scoped signing key on
 * the shared NATS account; the seed is injected into the named service via
 * the `nats-signer-seed` dynamicEnv kind so the service can mint per-user
 * JWTs in-process. The server cryptographically constrains anything signed
 * with this key to the declared subject scope.
 */
export interface TemplateNatsSigner {
  name: string;
  /**
   * Subject sub-tree the signing key is constrained to, *relative* to the
   * stack's subjectPrefix. E.g. `agent.worker` → minted JWTs cannot exceed
   * `<prefix>.agent.worker.>`.
   */
  subjectScope: string;
  /** Hard cap (NATS-enforced) on TTL of any JWT the signer can mint. Defaults to 3600s. */
  maxTtlSeconds?: number;
}

/**
 * App-author-facing cross-stack subject import. Resolved at apply time
 * against the producer stack's latest applied version's exports.
 */
export interface TemplateNatsImport {
  /** Structural reference to another stack (by name). Resolved at apply time. */
  fromStack: string;
  /** Subjects relative to the *producer's* subjectPrefix. Must match producer's exports. */
  subjects: string[];
  /** Roles in *this* stack that get the imported subjects added to their subscribe list. Required (per-role binding only). */
  forRoles: string[];
}

export interface TemplateNatsSection {
  // App-author surface (safe-by-default; auto-prefixed; validated at publish).
  /** Defaults to `app.{{stack.id}}`. Non-default values require an admin allowlist entry. */
  subjectPrefix?: string;
  roles?: TemplateNatsRole[];
  signers?: TemplateNatsSigner[];
  /** Subjects relative to subjectPrefix that this stack publishes for cross-app consumption. */
  exports?: string[];
  imports?: TemplateNatsImport[];

  // Low-level surface (system templates and advanced/internal use).
  // App templates use the role/signer surface above; mixing the two within
  // one template is rejected at validation time.
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
  /** Symbolic role name from nats.roles[]; resolved to a materialized NatsCredentialProfile at apply time. */
  natsRole?: string | null;
  /** Symbolic signer name from nats.signers[]; auto-injects NATS_SIGNER_SEED dynamicEnv at apply time. */
  natsSigner?: string | null;
  /** Service Addons authoring block; null when no addons declared on this template service. */
  addons?: Record<string, unknown> | null;
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
