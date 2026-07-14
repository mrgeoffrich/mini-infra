// ====================
// Stack Types
// ====================

import type { NetworkDriftItem } from './docker';

// Status and service type unions (mirror Prisma enums)
export type StackStatus = 'synced' | 'drifted' | 'pending' | 'error' | 'undeployed';
export const STACK_SERVICE_TYPES = ['Stateful', 'StatelessWeb', 'AdoptedWeb', 'Pool', 'JobPool'] as const;
export type StackServiceType = typeof STACK_SERVICE_TYPES[number];
export type ServiceActionType = 'create' | 'recreate' | 'remove' | 'no-op';

/**
 * Docker network `purpose` for an environment's HAProxy "applications"
 * network — the network every HAProxy-routed backend must join so HAProxy can
 * reach it. Resolves per environment to `<environment>-applications` (see
 * `resourceNetworkName()` server-side). Declared here so the client authoring
 * flows and the server-side apply-time invariant agree on the one literal
 * instead of re-typing `'applications'` in a dozen places.
 */
export const APPLICATIONS_NETWORK_PURPOSE = 'applications';

/**
 * Service types that sit behind HAProxy and therefore must be members of the
 * environment's `applications` network for traffic to flow. Used by both the
 * client app-authoring flows (to declare the membership) and the server
 * reconciler invariant (to guarantee it regardless of authoring surface).
 */
export const HAPROXY_ROUTED_SERVICE_TYPES = ['StatelessWeb', 'AdoptedWeb'] as const satisfies readonly StackServiceType[];

/** True when a service type routes through HAProxy (see {@link HAPROXY_ROUTED_SERVICE_TYPES}). */
export function isHaproxyRoutedServiceType(serviceType: StackServiceType): boolean {
  return (HAPROXY_ROUTED_SERVICE_TYPES as readonly StackServiceType[]).includes(serviceType);
}

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
  | { kind: 'vault-wrapped-secret-id'; ttlSeconds?: number }
  | { kind: 'pool-management-token'; poolService: string }
  | { kind: 'nats-url' }
  | { kind: 'nats-creds' }
  /**
   * File-based variant of `nats-creds` (egress NATS cred-resilience plan,
   * Phase 5, §4.3). The minted `.creds` blob is written to a per-stack file
   * (`<stackId>.creds`) on a named docker volume the consuming stack declares
   * and mounts read-only; the env var receives the *file path*, never the
   * secret. Unlike `nats-creds` (which bakes the blob into the env once at
   * container create), nats.go re-reads the file on every reconnect via
   * `nats.UserCredentials`, so a rotated credential is picked up without a
   * container recreate. Opt-in and currently scoped to the two egress agents —
   * generic NATS consumers keep `nats-creds` (see plan §3 non-goals).
   */
  | { kind: 'nats-creds-file' }
  /**
   * Cloudflare tunnel connector token for the stack's environment. Resolved
   * at apply time from the managed-tunnel store (the token issued when the
   * managed tunnel was created) and injected as a plain env var — cloudflared
   * reads `TUNNEL_TOKEN` natively. Resolving dynamically (rather than baking
   * the token into a stack parameter) means the instantiate / create-tunnel /
   * deploy steps are order-independent: the live token is always read fresh on
   * each apply. Fails closed if no managed tunnel exists for the environment.
   */
  | { kind: 'cloudflare-tunnel-token' }
  /**
   * Ephemeral, pre-authorized Tailscale authkey minted at apply time via the
   * `tailscale` connected service (OAuth client credentials → the tailnet's
   * `POST /tailnet/-/keys`). Injected as a plain env var — `tailscaled` reads
   * `TS_AUTHKEY` natively on first boot to register the device, then persists
   * its node key on the state volume so subsequent restarts don't need it.
   *
   * Resolving dynamically (rather than baking a key into a stack parameter)
   * means the key is always fresh, single-use, and never appears in the stack
   * definition hash or applied snapshot. Used by the `tailscale-ingress`
   * host-scoped stack, which fronts Mini Infra's own control-plane container.
   * Fails closed if the `tailscale` connected service isn't configured.
   */
  | { kind: 'tailscale-authkey' }
  /**
   * Read a single field from a Vault KV v2 path at apply time using the
   * Mini Infra admin token. The container receives the value as a plain
   * env var — no Vault client SDK or AppRole needed by the running app.
   * Apply re-runs re-read; KV updates do not propagate until the next apply.
   */
  | { kind: 'vault-kv'; path: string; field: string }
  /**
   * Seed (NKey, base32) of a *scoped signing key* on the shared NATS account.
   * Distinct from `nats-creds` — this is NOT used to connect to NATS; it is
   * used by the service to mint downstream user JWTs in-process. Server-side
   * NATS enforces the signer's subjectScope at JWT-validation time, so a
   * compromised signer cannot escape its declared sub-tree.
   *
   * Auto-wired by the apply orchestrator when a service declares
   * `natsSigner: '<name>'` against a `nats.signers[]` entry — apps don't write
   * this dynamicEnv kind by hand. Resolved at apply time from Vault KV at
   * `shared/nats-signers/<stackId>-<signerName>`.
   */
  | { kind: 'nats-signer-seed'; signer: string }
  /**
   * Public key of the NATS account that owns the named signing key. Required
   * by `nats-jwt`'s `encodeUser` as the `issuer_account` claim whenever a
   * scoped signing key (rather than the account key itself) signs a user JWT
   * — without it the server rejects the JWT. Pair with `nats-signer-seed`
   * for any service that mints user JWTs in-process.
   */
  | { kind: 'nats-account-public'; signer: string };

/**
 * Per-service configuration for a `Pool` service. Pools are container
 * blueprints; instances are created on demand via the pool API.
 */
export interface PoolConfig {
  /** Default idle timeout for instances when the caller doesn't override. */
  defaultIdleTimeoutMinutes: number;
  /** Hard cap on simultaneous instances. `null` = unlimited. */
  maxInstances: number | null;
  /** Name of the caller service in the stack that gets the pool management token. */
  managedBy: string | null;
}

/**
 * Per-service configuration for a `JobPool` service. JobPools spawn one-shot
 * containers in response to triggers (cron, NATS request, manual HTTP), reusing
 * the Pool spawn / `PoolInstance` lifecycle machinery but driven by container
 * exit rather than idle timers (exit watcher lands in Phase 2; Phase 1 only
 * defines the type, validates it, persists it, and offers a direct
 * `runJobPool()` entry point).
 */
export interface JobPoolConfig {
  /** Hard cap on simultaneous in-flight runs. `null` = unlimited. */
  maxConcurrent: number | null;

  /** Reserved — name of a caller service that holds the spawn token. Unused in v1. */
  managedBy: string | null;

  /** Triggers declared by the template. At least one required. */
  triggers: JobPoolTrigger[];

  /** Per-pool JetStream history stream config. */
  history: { retainDays: number; maxBytes?: string };

  /** Safety: kill a runaway run after N seconds. Replaces Pool's idle timer. */
  killAfterSeconds?: number | null;

  /** In-job retry policy on non-zero exit. Optional. */
  onFailure?: { retries: number; backoff: 'fixed' | 'exponential' };
}

/**
 * Optional structured identification carried alongside a trigger's
 * human-readable `name`. Authors (templates / materialisers) stash domain
 * keys like `databaseId` here so the runtime env resolver can read them
 * structurally rather than parsing them out of the `name` field — the
 * `cron-<databaseId>` positional convention used by pg-az-backup at Phase 4
 * is brittle the moment a UI lets operators rename triggers (MINI-50 review
 * finding M8).
 *
 * Values are restricted to strings so the field round-trips cleanly through
 * Zod, JSON, and Docker labels without surprise coercion. Keep the map
 * small — it rides on every history publish and every container spawn.
 */
export type JobPoolTrigger =
  | { kind: 'cron'; schedule: string; timezone?: string; name: string; metadata?: Record<string, string> }
  | { kind: 'nats-request'; subject: string; ackWithRunId: boolean; name: string; metadata?: Record<string, string> }
  | { kind: 'manual'; name: string; metadata?: Record<string, string> };

/**
 * Lifecycle statuses for a pool instance row.
 *
 * Pool instances use a subset: `starting`/`running`/`stopping`/`stopped`/`error`.
 * JobPool instances additionally transition to terminal `completed` (exit 0)
 * or `failed` (non-zero exit, killed by `killAfterSeconds`, or exit watcher
 * surfacing). The exit watcher (Phase 2) is the only thing that ever writes
 * `completed` / `failed`; pre-Phase-2 rows never hold those values.
 */
export const POOL_INSTANCE_STATUSES = [
  'starting',
  'running',
  'stopping',
  'stopped',
  'error',
  'completed',
  'failed',
] as const;
export type PoolInstanceStatus = typeof POOL_INSTANCE_STATUSES[number];

/** DB shape for a pool instance (Date fields). */
export interface PoolInstance {
  id: string;
  stackId: string;
  serviceName: string;
  instanceId: string;
  containerId: string | null;
  status: PoolInstanceStatus;
  idleTimeoutMinutes: number;
  lastActive: Date;
  createdAt: Date;
  stoppedAt: Date | null;
  errorMessage: string | null;
  /**
   * Container exit code captured by the JobPool exit watcher when status is
   * `completed` (always 0) or `failed` (non-zero, or `-1` when the row was
   * forced failed without a real exit — e.g. kill-after-seconds overrun).
   * `null` on Pool rows and on JobPool rows that haven't terminated yet.
   */
  exitCode: number | null;
  /**
   * Wall-clock time the JobPool run finished (success or failure). `null`
   * on Pool rows and on still-running JobPool rows.
   */
  finishedAt: Date | null;
}

/** API response shape for a pool instance (string dates). */
export interface PoolInstanceInfo {
  id: string;
  stackId: string;
  serviceName: string;
  instanceId: string;
  containerId: string | null;
  status: PoolInstanceStatus;
  idleTimeoutMinutes: number;
  lastActive: string;
  createdAt: string;
  stoppedAt: string | null;
  errorMessage: string | null;
  exitCode: number | null;
  finishedAt: string | null;
}

/** Request body for POST /api/stacks/:stackId/pools/:serviceName/instances */
export interface EnsurePoolInstanceRequest {
  instanceId: string;
  env?: Record<string, string>;
  idleTimeoutMinutes?: number;
}

// Numeric fields in stack definitions may be literal integers *or* a
// "{{params.name}}" template reference that gets resolved at instantiation.
// The resolved runtime value is always a number.
export type NumOrTemplate = number | string;

export interface StackContainerConfig {
  command?: string[];
  entrypoint?: string[];
  capAdd?: string[];
  /**
   * Host devices to expose into the container (Docker `HostConfig.Devices`).
   * Each entry is a path on the host (e.g. `/dev/net/tun`) — the container
   * sees the device at the same path with default cgroup permissions.
   * Currently populated only by env-injection addons (e.g. `claude-shell`)
   * that need to bring up kernel-mode networking inside the workload
   * container. Operator-authored values flow through the reconciler the
   * same way; the container-create path picks the field up as it lands.
   */
  devices?: string[];
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
  /**
   * Docker network mode. Defaults to bridge (the only mode the reconciler
   * could express before this field existed). `host` puts the container in
   * the host's network namespace — needed by services that manipulate the
   * host's nftables/iptables (egress-fw-agent) or otherwise require direct
   * host networking. Templates that set `networkMode: "host"` MUST also
   * leave `ports`, `joinNetworks`, and `joinResourceNetworks` empty: in
   * host mode there are no per-container ports to bind and the container
   * cannot also join a docker bridge network. Validated at template-load.
   */
  networkMode?: 'bridge' | 'host';
  restartPolicy?: typeof RESTART_POLICIES[number];
  /**
   * Container healthcheck. **All durations are in milliseconds.**
   *
   * This is the canonical unit for the whole stack surface — the authoring UIs,
   * the built-in template JSONs, the DB columns, and the deploy-wait path all
   * agree on it. Docker's API wants nanoseconds; that conversion happens in
   * exactly one place, `healthcheckToDocker()` in
   * `server/src/services/stacks/healthcheck-config.ts`. Do not convert units
   * anywhere else.
   *
   * `retries` is a count, not a duration.
   */
  healthcheck?: {
    test: string[];
    /** Milliseconds between checks. */
    interval: NumOrTemplate;
    /** Milliseconds before a single check is considered failed. */
    timeout: NumOrTemplate;
    /** Consecutive failures before the container is marked unhealthy. */
    retries: NumOrTemplate;
    /** Milliseconds of boot grace before failures start counting. */
    startPeriod: NumOrTemplate;
  };
  logConfig?: {
    type: string;
    maxSize: string;
    maxFile: string;
  };
  /**
   * When true, the container's HostConfig.Dns is NOT pointed at the egress
   * gateway. Treat undefined as false. Intended for sidecar/infra containers
   * that must reach upstream DNS directly (e.g., the egress gateway itself).
   */
  egressBypass?: boolean;
  /**
   * Domains the service needs to reach. Used to auto-allow egress when the
   * stack is deployed in an environment. Patterns follow the same shape as
   * EgressRule — FQDN (e.g. "api.example.com") or wildcard (e.g. "*.example.com").
   * Each entry creates an EgressRule with source='template' scoped to the
   * declaring service's name.
   */
  requiredEgress?: string[];
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

/**
 * Phase 10 — unified network declaration. One shape for declaring a
 * stack-owned or shared/resource-scoped network, instead of choosing
 * between stack-level `networks[]` (stack scope) and
 * `resourceOutputs[]`/`resourceInputs[]` (environment/host scope for the
 * `docker-network` resource type).
 *
 * Accepted anywhere a `StackNetwork` is accepted in an authoring payload
 * (the `networks[]` field on stack/template create + draft requests) —
 * see `StackNetworkEntry`. Distinguished from `StackNetwork` at runtime by
 * the presence of `purpose` (vs `name`); see
 * `isUnifiedStackNetworkDeclaration()` in
 * `server/src/services/networks/unified-network-declarations.ts`.
 *
 * Translated to the legacy shapes as early as possible (template/stack
 * creation time) — every stored/resolved definition
 * (`StackTemplateVersion`, `Stack`, `StackDefinition`) only ever contains
 * the legacy shapes. See `translateUnifiedNetworkDeclarations()` in the
 * same module for the full mixing/precedence rule.
 */
export interface UnifiedStackNetworkDeclaration {
  purpose: string;
  /**
   * Defaults to `'stack'`. `'environment'` and `'host'` both translate to a
   * `resourceOutputs[]` entry — the network's real resulting scope is still
   * governed by whether the *owning* stack itself is environment- or
   * host-scoped (unchanged existing `resourceOutputs` behavior), not by
   * this field's literal value.
   */
  scope?: 'stack' | 'environment' | 'host';
}

/** Either shape may appear in an authored `networks[]` array. */
export type StackNetworkEntry = StackNetwork | UnifiedStackNetworkDeclaration;

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
  poolConfig: PoolConfig | null;
  jobPoolConfig: JobPoolConfig | null;
  vaultAppRoleId: string | null;
  lastAppliedVaultAppRoleId: string | null;
  natsCredentialId: string | null;
  natsCredentialRef: string | null;
  poolManagementTokenHash: string | null;
  /** Service Addons authoring block; null when no addons declared. */
  addons: Record<string, unknown> | null;
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
  /** 'system' (infrastructure) or 'user' (application); null for templateless/manual stacks. Present when the query includes the template relation. */
  templateSource?: 'system' | 'user' | null;
  /** The template's current published version number — for showing installed-vs-latest. Present when the query includes the template relation. */
  templateCurrentVersion?: number | null;
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
  /** Names of input values that have been supplied and encrypted at rest. Never the values themselves. */
  inputValueKeys?: string[];
  /** Human-readable reason the last apply failed; null when the last apply succeeded. */
  lastFailureReason?: string | null;
  /**
   * NATS-section drift report. Populated when the stack has a NATS section
   * AND a `lastAppliedNatsSnapshot`; otherwise `null`. The detector compares
   * the current template's raw NATS fields (`natsRoles`, `natsSigners`,
   * `natsExports`, `natsImports`, `natsSubjectPrefix`) against the snapshot
   * — independent of stack-level container drift, so a stack can be `synced`
   * status-wise yet still report `natsDrift.drifted = true` if the template
   * was edited since the last NATS apply.
   */
  natsDrift?: NatsDriftInfo | null;
  /**
   * What the background status monitor last found wrong with the stack's live
   * containers. Empty/absent means the last check was clean. Distinct from
   * `status`: `status` is the coarse lifecycle field, this is the specifics.
   */
  runtimeIssues?: StackRuntimeIssue[] | null;
  /**
   * Server-computed "does this stack need a human?" rollup. Folds status, live
   * runtime issues, NATS drift and template-update-available into one signal so
   * every consumer — the UI, the agent sidecar, API-key integrations — gets the
   * same answer instead of each reimplementing it.
   */
  needsAttention?: StackAttention;
}

/** A specific thing the status monitor found wrong with a stack's live containers. */
export type StackRuntimeIssue =
  /** The service has no container at all. */
  | { kind: 'missing'; serviceName: string }
  /** The container exists but is not running — it crashed, or was stopped. */
  | { kind: 'not-running'; serviceName: string; status: string }
  /** The container is running but is not what we applied (replaced/edited out of band). */
  | { kind: 'hash-mismatch'; serviceName: string };

/**
 * How loudly a stack is asking for a human.
 *
 * - `critical` — the app is down (a service is not running or has no container),
 *   or the last apply failed.
 * - `warning`  — something diverged but the app is still up (drift, unapplied
 *   edits, NATS drift).
 * - `info`     — an opportunity, not a problem (a newer template version).
 * - `none`     — nothing to do.
 */
export type StackAttentionLevel = 'none' | 'info' | 'warning' | 'critical';

export interface StackAttention {
  level: StackAttentionLevel;
  /** True when the stack has one or more unresolved conditions. */
  needsAttention: boolean;
  /** Human-readable reasons, each phrased as "what's wrong → what to do". */
  reasons: string[];
  /** True when a newer template version is available (a softer signal). */
  updateAvailable: boolean;
}

/** The subset of a stack `computeStackAttention` reads. */
export interface StackAttentionInput {
  status?: StackStatus;
  lastFailureReason?: string | null;
  runtimeIssues?: StackRuntimeIssue[] | null;
  natsDrift?: { drifted?: boolean } | null;
  templateUpdateAvailable?: boolean;
}

function describeRuntimeIssue(issue: StackRuntimeIssue): string {
  switch (issue.kind) {
    case 'missing':
      return `Service '${issue.serviceName}' has no container — run Apply to recreate it.`;
    case 'not-running':
      return `Service '${issue.serviceName}' is not running (${issue.status}) — run Apply to restart it.`;
    case 'hash-mismatch':
      return `Service '${issue.serviceName}' no longer matches the applied definition — run Apply to reconcile.`;
  }
}

/**
 * Roll every "needs attention" signal for a stack into one shape.
 *
 * This is the single implementation: the server calls it inside
 * `serializeStack()` so the rollup ships on the API (an agent or API-key caller
 * should not have to reimplement it), and the client prefers that server value,
 * falling back to computing locally.
 *
 * The important honesty property: a stack whose service has died reports
 * `critical` with the service named, not the generic drift copy. `status` alone
 * cannot express that — it is a coarse lifecycle field, and a crashed container
 * lands there as `drifted`, which undersells "your app is down".
 */
export function computeStackAttention(stack: StackAttentionInput): StackAttention {
  const reasons: string[] = [];
  let level: StackAttentionLevel = 'none';

  const raise = (next: StackAttentionLevel) => {
    const order: StackAttentionLevel[] = ['none', 'info', 'warning', 'critical'];
    if (order.indexOf(next) > order.indexOf(level)) level = next;
  };

  if (stack.status === 'error') {
    reasons.push(
      stack.lastFailureReason
        ? `Last apply failed: ${stack.lastFailureReason}`
        : 'The last apply failed — retry Apply.',
    );
    raise('critical');
  } else if (stack.status === 'pending') {
    reasons.push("The definition changed but hasn't been applied — run Apply.");
    raise('warning');
  }

  // Specific runtime findings replace the generic `drifted` copy — "api is not
  // running" is the thing the operator actually needs to know.
  const issues = stack.runtimeIssues ?? [];
  for (const issue of issues) {
    reasons.push(describeRuntimeIssue(issue));
    // A dead or missing container means the app is down. A hash mismatch means
    // it is up, but not running what we think it is.
    raise(issue.kind === 'hash-mismatch' ? 'warning' : 'critical');
  }

  // Only fall back to the generic message when the monitor has no specifics —
  // e.g. drift a human found by opening the plan, which the cheap check cannot see.
  if (stack.status === 'drifted' && issues.length === 0) {
    reasons.push('Live containers have drifted from the definition — run Apply to reconcile.');
    raise('warning');
  }

  if (stack.natsDrift?.drifted) {
    reasons.push('NATS configuration has drifted from the last applied snapshot.');
    raise('warning');
  }

  const updateAvailable = stack.templateUpdateAvailable === true;
  if (updateAvailable) {
    reasons.push('A newer template version is available — Upgrade & deploy to adopt it.');
    raise('info');
  }

  return { level, needsAttention: reasons.length > 0, reasons, updateAvailable };
}

/** Reasons why the NATS section of a stack is out of sync with its last apply. */
export type NatsDriftReason =
  /** Resolved subject prefix differs (template edit, allowlist change, or param change). */
  | 'subject-prefix'
  /** `roles[]` array differs (added/removed roles, changed pub/sub patterns, etc.). */
  | 'roles'
  /** `signers[]` array differs (scope, TTL, or membership). */
  | 'signers'
  /** `exports[]` array differs. */
  | 'exports'
  /** `imports[]` array differs. */
  | 'imports'
  /**
   * The `lastAppliedNatsSnapshot` predates the v2 raw-fields schema. The
   * detector can't compare cleanly without re-rendering the template; the
   * UI surfaces this as "baseline incomplete — re-apply to refresh". A
   * single re-apply on an already-synced stack populates the missing fields
   * and clears the reason.
   */
  | 'baseline-incomplete';

export interface NatsDriftInfo {
  /** True if any reason fired. */
  drifted: boolean;
  /** Specific fields that differ. Empty when `drifted` is false. */
  reasons: NatsDriftReason[];
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
  poolConfig: PoolConfig | null;
  jobPoolConfig: JobPoolConfig | null;
  /** Service Addons authoring block; null when no addons declared. */
  addons: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

// Portable definition types (no DB fields — used for snapshots/export)

/**
 * Back-reference attached to rendered addon-derived services produced by the
 * Service Addons render pipeline (`server/src/services/stack-addons/`).
 * Authored services never carry this — its presence is the canonical
 * "synthetic" signal that downstream UI / RBAC code branches on.
 *
 * Declared here (rather than in `./addons.ts`) so `stacks.ts` has no inbound
 * dependency on the addon module — `addons.ts` re-exports this type for
 * addon-framework consumers.
 */
export interface SyntheticServiceInfo {
  /** Addon ids that produced this sidecar — multiple when merged by kind. */
  addonIds: string[];
  /** Merge-strategy kind for grouped addons; absent for solo applications. */
  kind?: string;
  /** Service name of the target this sidecar wraps. */
  targetService: string;
}

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
  poolConfig?: PoolConfig;
  jobPoolConfig?: JobPoolConfig | null;
  vaultAppRoleId?: string | null;
  /** Symbolic reference to a vault.appRoles[].name in the owning template draft.
   *  Resolved to a concrete vaultAppRoleId at apply time. */
  vaultAppRoleRef?: string | null;
  natsCredentialId?: string | null;
  /** Symbolic reference to a nats.credentials[].name in the owning template draft.
   *  Resolved to a concrete natsCredentialId at apply time. */
  natsCredentialRef?: string | null;
  /** Symbolic reference to a nats.roles[].name. Resolved at apply time to a
   *  materialized NatsCredentialProfile (auto-prefixed permissions). */
  natsRole?: string | null;
  /** Symbolic reference to a nats.signers[].name. Causes NATS_SIGNER_SEED to
   *  be auto-injected as dynamicEnv at apply time. */
  natsSigner?: string | null;
  /**
   * Service Addons declarations — a map of addon-id → addon-config. The
   * authored stack carries only this terse block; the render pipeline
   * (`server/src/services/stack-addons/expand-addons.ts`) materialises each
   * declaration into one or more synthetic sidecar definitions appended to
   * the rendered services list. With the production registry empty the
   * render pass is a no-op for every existing stack.
   */
  addons?: Record<string, unknown>;
  /**
   * Back-reference set on rendered addon-derived services. `undefined` on
   * authored services. See `SyntheticServiceInfo` above.
   */
  synthetic?: SyntheticServiceInfo;
  /**
   * Phase 10 — unified per-service network join list. Symbolic purpose
   * references, resolved against the stack-level `networks[]` declarations
   * (legacy `StackNetwork.name` or unified `UnifiedStackNetworkDeclaration.purpose`,
   * plus `resourceOutputs[]`/`resourceInputs[]` purposes) at translate time.
   * Replaces choosing between `containerConfig.joinNetworks` and
   * `containerConfig.joinResourceNetworks` for purposes declared via
   * `networks[]`. Authoring-time-only sugar: always translated away (merged
   * into `containerConfig.joinResourceNetworks`, or dropped as a no-op for
   * stack-scope purposes) before persistence — never populated on a
   * resolved/applied service definition. See
   * `translateUnifiedNetworkDeclarations()` in
   * `server/src/services/networks/unified-network-declarations.ts`.
   */
  networks?: string[];
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

/**
 * Service shape accepted by `serializeStack` — superset of `StackService` (the
 * Prisma row) and `StackServiceDefinition` (the post-expansion render output).
 * Keeping `addons` and `synthetic` optional here lets the apply pipeline pass
 * the rendered service list (including synthetic sidecars) so the resulting
 * `lastAppliedSnapshot` reflects what was actually deployed, not just what the
 * user authored. The `addon-endpoints` route iterates `snapshot.services`
 * looking for `synthetic` markers — without this, the snapshot is missing
 * every addon-derived sidecar.
 */
type SerializableStackService = {
  serviceName: string;
  serviceType: StackServiceType;
  dockerImage: string;
  dockerTag: string;
  containerConfig: StackContainerConfig;
  configFiles?: StackConfigFile[] | null;
  initCommands?: StackInitCommand[] | null;
  dependsOn: string[];
  order: number;
  routing?: StackServiceRouting | null;
  adoptedContainer?: AdoptedContainerRef | null;
  poolConfig?: PoolConfig | null;
  jobPoolConfig?: JobPoolConfig | null;
  vaultAppRoleId?: string | null;
  addons?: Record<string, unknown> | null;
  synthetic?: SyntheticServiceInfo;
};

export function serializeStack(
  stack: Omit<Stack, 'services'> & { services: SerializableStackService[] }
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
      poolConfig: s.poolConfig ?? undefined,
      jobPoolConfig: s.jobPoolConfig ?? undefined,
      vaultAppRoleId: s.vaultAppRoleId ?? undefined,
      addons: s.addons ?? undefined,
      synthetic: s.synthetic,
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
  networks: StackNetworkEntry[];
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
  /**
   * Network overhaul Phase 7 — drift between this stack's desired-state
   * `ManagedNetwork`/`NetworkMembership` rows and live Docker network state
   * (missing networks, unattached services, stale attachments, spec
   * mismatches). Always present (empty when networks are in sync), mirroring
   * `resourceActions`. Computed by `NetworkReconciler` — see
   * `services/networks/network-reconciler.ts`. Folds into `hasChanges`
   * exactly like `actions`/`resourceActions` do.
   */
  networkActions: NetworkDriftItem[];
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
  /**
   * Service Addons render-pass plumbing. Both fields are typed `unknown`
   * here so `lib/` stays runtime-dep-free; the server narrows them to
   * `ExpansionProgress` / connected-services lookup before invoking the
   * addon framework. Either field may be omitted — the addon framework
   * tolerates a missing progress callback (no fan-out) and a missing
   * connected-services lookup (any addon that requires one is rejected
   * at applicability check time).
   */
  addonExpansion?: {
    progress?: unknown;
    connectedServices?: unknown;
  };
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
  /**
   * True when an `update` (pull-latest-and-recreate) found every image already
   * current and did no work. Lets the client distinguish "nothing to pull" from
   * a real update that happened to touch zero services, so it can say "Already
   * up to date" instead of a generic success. Undefined on `apply` results.
   */
  upToDate?: boolean;
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

/**
 * Result of a stop (undeploy-but-keep) operation: the stack's containers are
 * stopped and removed, but its definition + DB row are kept and its status is
 * set to `undeployed` so it can be deployed again without re-instantiating.
 * Distinct from {@link DestroyResult}, which deletes the stack record.
 */
export interface StackStopResult {
  success: boolean;
  stackId: string;
  stoppedContainers: number;
  duration: number;
  error?: string;
}

// Live status (server response shape from GET /stacks/:id/status)

export interface StackContainerStatus {
  serviceName: string;
  containerId: string;
  containerName: string;
  image: string;
  /** Docker container state: e.g. "running", "exited". */
  state: string;
  /** Human-readable Docker status string: e.g. "Up 2 hours". */
  status: string;
  /** "tracked" when the container has a definition-hash label, otherwise "untracked". */
  health: string;
}

export interface StackStatusResponseData {
  stack: StackInfo;
  containerStatus: StackContainerStatus[];
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
  networks: StackNetworkEntry[];
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
  networks?: StackNetworkEntry[];
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
  poolConfig?: PoolConfig | null;
  vaultAppRoleId?: string | null;
  natsCredentialId?: string | null;
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

export interface StackValidationWarning {
  code: string;
  message: string;
}

export interface StackValidationResult {
  success: boolean;
  valid: boolean;
  errors: StackValidationError[];
  warnings?: StackValidationWarning[];
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
