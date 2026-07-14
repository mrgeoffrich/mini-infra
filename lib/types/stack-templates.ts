// ====================
// Stack Template Types
// ====================

import type {
  TemplateVersionRelation,
  StackParameterDefinition,
  StackParameterValue,
  StackNetwork,
  StackNetworkEntry,
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
  JobPoolConfig,
} from './stacks';
import type { EnvironmentNetworkType } from './environments';
import type { StackTemplatePrerequisite } from './template-prerequisites';

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
  /** Cross-stack prerequisites declared by the template author (Phase 1).
   *  Soft-warned at instantiate; hard-blocks `apply` with a 409
   *  `PREREQUISITES_NOT_MET` until satisfied. Persisted on the version
   *  row so prereqs can change between template versions. */
  requires?: StackTemplatePrerequisite[];
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
  /** The template version this stack was born from / last upgraded to. */
  templateVersion: number | null;
  /** The template's current published version number (for installed-vs-latest). */
  templateCurrentVersion: number | null;
  /** True when the template's current published version is newer than the stack's. */
  templateUpdateAvailable: boolean;
  /** How the installed version relates to the current one, with direction. */
  templateVersionRelation: TemplateVersionRelation;
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
  /**
   * App-declared JetStream streams owned by this role. Stream subjects are
   * written *relative* to the stack's subjectPrefix; the orchestrator
   * prepends `<prefix>.` at apply time so every stream's subject filter
   * lives inside the stack's namespace. The stream is created on the
   * shared system account (same prefix-only isolation as roles), and
   * the role's credentials automatically retain pub/sub on the role's
   * own subject tree — so a service bound to this role can publish to
   * the stream and subscribe through any consumer it declares without
   * extra plumbing.
   */
  streams?: TemplateNatsRoleStream[];
  /**
   * Consumers attached to one of this role's `streams[]`. The `stream`
   * field references the role-stream by its declared `name`; it is NOT
   * prefixed (it's a logical reference within the role). `filterSubject`
   * is relative to the stack's subjectPrefix and gets prepended at apply
   * time.
   */
  consumers?: TemplateNatsRoleConsumer[];
  /** Credential JWT TTL. Defaults to NatsCredentialProfile system default (3600s). */
  ttlSeconds?: number;
}

/**
 * App-author-facing JetStream stream declaration nested inside a role.
 * Mirrors `TemplateNatsStream` but drops `account` (always the shared
 * system account) and `scope` (always stack-scoped) — both implied by
 * the prefix-only isolation model. Subjects are relative to the stack's
 * subjectPrefix; the orchestrator builds the absolute form at apply.
 */
export interface TemplateNatsRoleStream {
  name: string;
  description?: string;
  subjects: string[];
  retention?: 'limits' | 'interest' | 'workqueue';
  storage?: 'file' | 'memory';
  maxMsgs?: number | null;
  maxBytes?: number | null;
  maxAgeSeconds?: number | null;
}

/**
 * App-author-facing JetStream consumer attached to a role's stream.
 * Mirrors `TemplateNatsConsumer` but `stream` references one of the
 * containing role's `streams[]` by declared name (not the materialized
 * concrete name) and `filterSubject` is relative to the subjectPrefix.
 */
export interface TemplateNatsRoleConsumer {
  name: string;
  stream: string;
  durableName?: string;
  description?: string;
  filterSubject?: string;
  deliverPolicy?: 'all' | 'last' | 'new' | 'by_start_sequence' | 'by_start_time' | 'last_per_subject';
  ackPolicy?: 'none' | 'all' | 'explicit';
  maxDeliver?: number | null;
  ackWaitSeconds?: number | null;
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

/**
 * The NATS section of a stack template.
 *
 * This is the *only* NATS authoring surface. An earlier low-level surface
 * (`accounts` / `credentials` / `streams` / `consumers`, plus a per-service
 * `natsCredentialRef`) declared absolute subjects against an explicitly-named
 * account; it was replaced by the prefix-isolated role model and removed once
 * every system template had migrated. Templates still carrying those keys are
 * now rejected at validation with a migration message rather than being
 * silently stripped — see `REMOVED_NATS_TEMPLATE_FIELDS` on the server.
 *
 * Note this says nothing about NATS accounts/streams/consumers as *runtime*
 * entities: those still exist, are managed via `/api/nats`, and are created by
 * the control plane and system bootstrap. What went away is a template's
 * ability to declare them directly.
 */
export interface TemplateNatsSection {
  /** Defaults to `app.{{stack.id}}`. Non-default values require an admin allowlist entry. */
  subjectPrefix?: string;
  roles?: TemplateNatsRole[];
  signers?: TemplateNatsSigner[];
  /** Subjects relative to subjectPrefix that this stack publishes for cross-app consumption. */
  exports?: string[];
  imports?: TemplateNatsImport[];
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
  /** Cross-stack prerequisites — see `StackTemplateVersion.requires`. */
  requires?: StackTemplatePrerequisite[];
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
  /** JobPool authoring block; null/undefined when the service is not a JobPool. */
  jobPoolConfig?: JobPoolConfig | null;
  vaultAppRoleId?: string | null;
  /** Symbolic AppRole name from vault.appRoles[]; resolved to vaultAppRoleId at apply time (PR 2). */
  vaultAppRoleRef?: string | null;
  natsCredentialId?: string | null;
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
  networks: StackNetworkEntry[];
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
  /** Cross-stack prerequisites declared on the initial v0 draft. */
  requires?: StackTemplatePrerequisite[];
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
  /** Soft-archive toggle. Hides the template from the default list; linked stacks are untouched. */
  isArchived?: boolean;
}

export interface DraftVersionInput {
  parameters?: StackParameterDefinition[];
  defaultParameterValues?: Record<string, StackParameterValue>;
  networkTypeDefaults?: Record<string, Record<string, StackParameterValue>>;
  resourceOutputs?: StackResourceOutput[];
  resourceInputs?: StackResourceInput[];
  networks: StackNetworkEntry[];
  volumes: StackVolume[];
  services: StackServiceDefinition[];
  configFiles?: StackTemplateConfigFileInput[];
  notes?: string;
  inputs?: TemplateInputDeclaration[];
  vault?: TemplateVaultSection;
  nats?: TemplateNatsSection;
  /** Cross-stack prerequisites — see `StackTemplateVersion.requires`. */
  requires?: StackTemplatePrerequisite[];
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
