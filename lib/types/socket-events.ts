import type {
  ContainerInfo,
  ContainerStatus,
  ContainerLogLine,
} from "./containers";
import type {
  MigrationStep,
  MigrationResult,
  ManualFrontendSetupStep,
  ManualFrontendSetupResult,
} from "./deployments";
import type { ConnectivityStatusInfo } from "./settings";
import type { BackupHealthStatus } from "./self-backup";
import type { UserEventInfo } from "./user-events";
import type { ServiceApplyResult, ResourceResult, ApplyResult, DestroyResult } from "./stacks";
import type { CertIssuanceStep, CertIssuanceResult } from "./tls";
import type { OperationStep } from "./operations";
import type {
  VaultBootstrapStartedEvent,
  VaultBootstrapStepEvent,
  VaultBootstrapCompletedEvent,
  VaultUnsealStartedEvent,
  VaultUnsealStepEvent,
  VaultUnsealCompletedEvent,
  VaultStatusChangedEvent,
  VaultPassphraseLockEvent,
  VaultPolicyAppliedEvent,
  VaultAppRoleAppliedEvent,
} from "./vault";
import type {
  EgressEventBroadcast,
  EgressPolicyUpdatedEvent,
  EgressRuleMutationEvent,
  EgressGatewayHealthEvent,
} from "./egress";

// ====================
// Socket Channel Constants & Types
// ====================

/** All static (non-parameterized) channel names as a runtime array */
export const STATIC_SOCKET_CHANNELS = [
  "containers",
  "postgres",
  "monitoring",
  "events",
  "connectivity",
  "logs",
  "stacks",
  "volumes",
  "networks",
  "backup-health",
  "tls",
  "haproxy",
  "agent-sidecar",
  "self-update",
  "vault",
  "pools",
  "egress",
  "egress-fw-agent",
] as const;

/** Static (non-parameterized) channels */
export type StaticSocketChannel = (typeof STATIC_SOCKET_CHANNELS)[number];

/** Prefixes for parameterized channels */
export const PARAMETERIZED_CHANNEL_PREFIXES = [
  "container:",
] as const;

/** Parameterized channels with entity IDs */
export type ParameterizedSocketChannel =
  | `container:${string}`;

/** All valid channel names that clients can subscribe to */
export type SocketChannel = StaticSocketChannel | ParameterizedSocketChannel;

/** Named constants for static channels */
export const Channel = {
  CONTAINERS: "containers",
  POSTGRES: "postgres",
  MONITORING: "monitoring",
  EVENTS: "events",
  CONNECTIVITY: "connectivity",
  LOGS: "logs",
  STACKS: "stacks",
  VOLUMES: "volumes",
  NETWORKS: "networks",
  BACKUP_HEALTH: "backup-health",
  TLS: "tls",
  HAPROXY: "haproxy",
  AGENT_SIDECAR: "agent-sidecar",
  SELF_UPDATE: "self-update",
  VAULT: "vault",
  POOLS: "pools",
  EGRESS: "egress",
  EGRESS_FW_AGENT: "egress-fw-agent",
} as const satisfies Record<string, StaticSocketChannel>;

/** Helpers to build parameterized channel names */
export const ParameterizedChannel = {
  container: (id: string): SocketChannel => `container:${id}`,
} as const;

/**
 * Runtime validator for channel names.
 * Use this on the server to reject arbitrary strings from untyped clients.
 */
export function isValidSocketChannel(channel: string): channel is SocketChannel {
  if ((STATIC_SOCKET_CHANNELS as readonly string[]).includes(channel)) {
    return true;
  }
  // Parameterized channels must have a prefix + a non-empty ID, capped at 128 chars total
  if (channel.length > 128) {
    return false;
  }
  return PARAMETERIZED_CHANNEL_PREFIXES.some(
    (prefix) => channel.startsWith(prefix) && channel.length > prefix.length,
  );
}

// ====================
// Shared Defaults
// ====================

/** Maximum channels a single socket can subscribe to */
export const MAX_SOCKET_SUBSCRIPTIONS = 50;

/** Default number of log tail lines */
export const DEFAULT_LOG_TAIL_LINES = 100;

/** Maximum allowed log tail lines */
export const MAX_LOG_TAIL_LINES = 5000;

/** Socket.IO transports in priority order (must match between client and server) */
export const SOCKET_TRANSPORTS = ["websocket", "polling"] as const;

/** Docker container IDs are 12 (short) or 64 (full) hex characters */
const DOCKER_ID_RE = /^[a-f0-9]{12,64}$/;

/** Validate that a string looks like a Docker container ID */
export function isValidContainerId(id: string): boolean {
  return DOCKER_ID_RE.test(id);
}

// ====================
// Socket Event Name Constants
// ====================

/** Server → Client event names */
export const ServerEvent = {
  // Containers
  CONTAINERS_LIST: "containers:list",
  CONTAINER_STATUS: "container:status",
  CONTAINER_REMOVED: "container:removed",
  CONTAINER_LOG: "container:log",
  CONTAINER_LOG_END: "container:log:end",
  CONTAINER_LOG_ERROR: "container:log:error",
  // Postgres
  POSTGRES_OPERATION: "postgres:operation",
  POSTGRES_OPERATION_COMPLETED: "postgres:operation:completed",
  // Monitoring
  MONITORING_STATUS: "monitoring:status",
  // Events
  EVENT_CREATED: "event:created",
  EVENT_UPDATED: "event:updated",
  // Connectivity
  CONNECTIVITY_STATUS: "connectivity:status",
  CONNECTIVITY_ALL: "connectivity:all",
  // Stacks
  STACK_STATUS: "stack:status",
  STACK_APPLY_STARTED: "stack:apply:started",
  STACK_APPLY_SERVICE_RESULT: "stack:apply:service-result",
  STACK_APPLY_COMPLETED: "stack:apply:completed",
  STACK_DESTROY_STARTED: "stack:destroy:started",
  STACK_DESTROY_COMPLETED: "stack:destroy:completed",
  // HAProxy
  HAPROXY_BACKENDS_LIST: "haproxy:backends:list",
  HAPROXY_FRONTENDS_LIST: "haproxy:frontends:list",
  // HAProxy Migration
  MIGRATION_STARTED: "migration:started",
  MIGRATION_STEP: "migration:step",
  MIGRATION_COMPLETED: "migration:completed",
  // Volumes
  VOLUMES_LIST: "volumes:list",
  VOLUME_INSPECTION_COMPLETED: "volume:inspection:completed",
  // Networks
  NETWORKS_LIST: "networks:list",
  // Backup Health
  BACKUP_HEALTH_STATUS: "backup-health:status",
  // Logs (Loki)
  LOGS_ENTRIES: "logs:entries",
  // TLS Certificate Issuance
  CERT_ISSUANCE_STARTED: "cert:issuance:started",
  CERT_ISSUANCE_STEP: "cert:issuance:step",
  CERT_ISSUANCE_COMPLETED: "cert:issuance:completed",
  // Manual Frontend Setup
  FRONTEND_SETUP_STARTED: "frontend:setup:started",
  FRONTEND_SETUP_STEP: "frontend:setup:step",
  FRONTEND_SETUP_COMPLETED: "frontend:setup:completed",
  // Agent Sidecar Startup
  SIDECAR_STARTUP_STARTED: "sidecar:startup:started",
  SIDECAR_STARTUP_STEP: "sidecar:startup:step",
  SIDECAR_STARTUP_COMPLETED: "sidecar:startup:completed",
  // Self-Update Launch
  SELF_UPDATE_LAUNCH_STARTED: "self-update:launch:started",
  SELF_UPDATE_LAUNCH_STEP: "self-update:launch:step",
  SELF_UPDATE_LAUNCH_COMPLETED: "self-update:launch:completed",
  // Pool Instances
  POOL_INSTANCE_STARTING: "pool:instance:starting",
  POOL_INSTANCE_STARTED: "pool:instance:started",
  POOL_INSTANCE_FAILED: "pool:instance:failed",
  POOL_INSTANCE_IDLE_STOPPED: "pool:instance:idle-stopped",
  POOL_INSTANCE_STOPPED: "pool:instance:stopped",
  // Vault
  VAULT_BOOTSTRAP_STARTED: "vault:bootstrap:started",
  VAULT_BOOTSTRAP_STEP: "vault:bootstrap:step",
  VAULT_BOOTSTRAP_COMPLETED: "vault:bootstrap:completed",
  VAULT_UNSEAL_STARTED: "vault:unseal:started",
  VAULT_UNSEAL_STEP: "vault:unseal:step",
  VAULT_UNSEAL_COMPLETED: "vault:unseal:completed",
  VAULT_STATUS_CHANGED: "vault:status:changed",
  VAULT_PASSPHRASE_UNLOCKED: "vault:passphrase:unlocked",
  VAULT_PASSPHRASE_LOCKED: "vault:passphrase:locked",
  VAULT_POLICY_APPLIED: "vault:policy:applied",
  VAULT_APPROLE_APPLIED: "vault:approle:applied",
  // Egress Firewall
  EGRESS_EVENT: "egress:event",
  EGRESS_POLICY_UPDATED: "egress:policy:updated",
  EGRESS_RULE_MUTATION: "egress:rule:mutation",
  EGRESS_GATEWAY_HEALTH: "egress:gateway:health",
  // Egress Firewall Agent (sidecar lifecycle)
  EGRESS_FW_AGENT_STARTUP_STARTED: "egress-fw-agent:startup:started",
  EGRESS_FW_AGENT_STARTUP_STEP: "egress-fw-agent:startup:step",
  EGRESS_FW_AGENT_STARTUP_COMPLETED: "egress-fw-agent:startup:completed",
} as const;

/** Client → Server event names */
export const ClientEvent = {
  SUBSCRIBE: "subscribe",
  UNSUBSCRIBE: "unsubscribe",
  CONTAINER_LOGS_START: "container:logs:start",
  CONTAINER_LOGS_STOP: "container:logs:stop",
} as const;

// ====================
// Server → Client Events
// ====================

export interface ServerToClientEvents {
  // ── Containers ──────────────────────────────────────
  /** Full container list update */
  "containers:list": (data: { containers: ContainerInfo[]; totalCount: number }) => void;
  /** Single container status change */
  "container:status": (data: { id: string; name: string; status: ContainerStatus }) => void;
  /** Container removed from Docker */
  "container:removed": (data: { id: string; name: string }) => void;
  /** Container log line (replaces SSE stream) */
  "container:log": (data: { containerId: string; line: ContainerLogLine }) => void;
  /** Container log stream ended */
  "container:log:end": (data: { containerId: string }) => void;
  /** Container log stream error */
  "container:log:error": (data: { containerId: string; error: string }) => void;

  // ── Postgres Operations ─────────────────────────────
  /** Backup/restore operation progress */
  "postgres:operation": (data: {
    operationId: string;
    type: "backup" | "restore";
    status: string;
    progress: number;
    message?: string;
  }) => void;
  /** Operation completed */
  "postgres:operation:completed": (data: {
    operationId: string;
    type: "backup" | "restore";
    success: boolean;
    error?: string;
  }) => void;

  // ── Monitoring ──────────────────────────────────────
  /** Monitoring stack status update */
  "monitoring:status": (data: {
    available: boolean;
    services: Record<string, string>;
  }) => void;

  // ── Events ──────────────────────────────────────────
  /** New user event created */
  "event:created": (data: UserEventInfo) => void;
  /** User event status changed */
  "event:updated": (data: UserEventInfo) => void;

  // ── Connectivity ────────────────────────────────────
  /** Service connectivity status changed */
  "connectivity:status": (data: ConnectivityStatusInfo) => void;
  /** All connectivity statuses (batch update) */
  "connectivity:all": (data: ConnectivityStatusInfo[]) => void;

  // ── Stacks ──────────────────────────────────────────
  /** Stack status changed */
  "stack:status": (data: {
    stackId: string;
    status: string;
    containers: Array<{ name: string; status: string }>;
  }) => void;
  /** Stack apply operation started */
  "stack:apply:started": (data: {
    stackId: string;
    stackName: string;
    totalActions: number;
    actions: Array<{ serviceName: string; action: string }>;
    forcePull?: boolean;
  }) => void;
  /** Individual service or resource within a stack apply completed */
  "stack:apply:service-result": (data: (ServiceApplyResult | ResourceResult) & {
    stackId: string;
    completedCount: number;
    totalActions: number;
  }) => void;
  /** Stack apply operation completed (success or failure) */
  "stack:apply:completed": (data: ApplyResult & {
    error?: string;
    postApply?: { success: boolean; errors?: string[] };
  }) => void;
  /** Stack destroy started */
  "stack:destroy:started": (data: { stackId: string; stackName: string }) => void;
  /** Stack destroy completed */
  "stack:destroy:completed": (data: DestroyResult) => void;

  // ── HAProxy ────────────────────────────────────────
  /** HAProxy backends list updated */
  "haproxy:backends:list": (data: { count: number }) => void;
  /** HAProxy frontends list updated */
  "haproxy:frontends:list": (data: { count: number }) => void;

  // ── HAProxy Migration ──────────────────────────────
  /** HAProxy migration started */
  "migration:started": (data: {
    environmentId: string;
    environmentName: string;
    totalSteps: number;
  }) => void;
  /** Individual migration step completed */
  "migration:step": (data: {
    environmentId: string;
    step: MigrationStep;
    completedCount: number;
    totalSteps: number;
  }) => void;
  /** HAProxy migration completed (success or failure) */
  "migration:completed": (data: MigrationResult & {
    environmentId: string;
  }) => void;

  // ── Volumes ─────────────────────────────────────────
  /** Volume list updated */
  "volumes:list": (data: { count: number }) => void;
  /** Volume inspection completed or failed */
  "volume:inspection:completed": (data: { volumeName: string; status: "completed" | "failed" }) => void;

  // ── Networks ────────────────────────────────────────
  /** Network list updated */
  "networks:list": (data: { count: number }) => void;

  // ── Backup Health ───────────────────────────────────
  /** Self-backup health status */
  "backup-health:status": (data: BackupHealthStatus) => void;

  // ── Logs (Loki) ─────────────────────────────────────
  /** Loki log entries pushed (for tailing) */
  "logs:entries": (data: {
    entries: Array<{ timestamp: string; line: string; labels: Record<string, string> }>;
  }) => void;

  // ── TLS Certificate Issuance ─────────────────────────
  /** Certificate issuance started */
  "cert:issuance:started": (data: {
    operationId: string;
    domains: string[];
    primaryDomain: string;
    totalSteps: number;
    stepNames?: string[];
  }) => void;
  /** Certificate issuance step completed */
  "cert:issuance:step": (data: {
    operationId: string;
    step: CertIssuanceStep;
    completedCount: number;
    totalSteps: number;
  }) => void;
  /** Certificate issuance completed (success or failure) */
  "cert:issuance:completed": (data: CertIssuanceResult & {
    operationId: string;
  }) => void;

  // ── Manual Frontend Setup ────────────────────────────
  /** Manual frontend setup started */
  "frontend:setup:started": (data: {
    operationId: string;
    environmentId: string;
    hostname: string;
    totalSteps: number;
    stepNames?: string[];
  }) => void;
  /** Manual frontend setup step completed */
  "frontend:setup:step": (data: {
    operationId: string;
    step: ManualFrontendSetupStep;
    completedCount: number;
    totalSteps: number;
  }) => void;
  /** Manual frontend setup completed (success or failure) */
  "frontend:setup:completed": (data: ManualFrontendSetupResult & {
    operationId: string;
  }) => void;

  // ── Agent Sidecar Startup ──────────────────────────
  /** Agent sidecar startup started */
  "sidecar:startup:started": (data: {
    operationId: string;
    totalSteps: number;
    stepNames?: string[];
  }) => void;
  /** Agent sidecar startup step completed */
  "sidecar:startup:step": (data: {
    operationId: string;
    step: OperationStep;
    completedCount: number;
    totalSteps: number;
  }) => void;
  /** Agent sidecar startup completed (success or failure) */
  "sidecar:startup:completed": (data: {
    operationId: string;
    success: boolean;
    steps: OperationStep[];
    errors: string[];
  }) => void;

  // ── Self-Update Launch ─────────────────────────────
  /** Self-update sidecar launch started */
  "self-update:launch:started": (data: {
    operationId: string;
    totalSteps: number;
    stepNames?: string[];
    targetTag: string;
  }) => void;
  /** Self-update sidecar launch step completed */
  "self-update:launch:step": (data: {
    operationId: string;
    step: OperationStep;
    completedCount: number;
    totalSteps: number;
  }) => void;
  /** Self-update sidecar launch completed (success or failure) */
  "self-update:launch:completed": (data: {
    operationId: string;
    success: boolean;
    steps: OperationStep[];
    errors: string[];
  }) => void;

  // ── Pool Instances ─────────────────────────────────
  /** Pool instance spawn started */
  "pool:instance:starting": (data: {
    stackId: string;
    serviceName: string;
    instanceId: string;
  }) => void;
  /** Pool instance reached running state */
  "pool:instance:started": (data: {
    stackId: string;
    serviceName: string;
    instanceId: string;
    containerId: string;
  }) => void;
  /** Pool instance spawn or runtime failure */
  "pool:instance:failed": (data: {
    stackId: string;
    serviceName: string;
    instanceId: string;
    error: string;
  }) => void;
  /** Pool instance stopped by idle reaper */
  "pool:instance:idle-stopped": (data: {
    stackId: string;
    serviceName: string;
    instanceId: string;
    idleMinutes: number;
  }) => void;
  /** Pool instance stopped by caller or destroy */
  "pool:instance:stopped": (data: {
    stackId: string;
    serviceName: string;
    instanceId: string;
  }) => void;

  // ── Vault ──────────────────────────────────────────
  "vault:bootstrap:started": (data: VaultBootstrapStartedEvent) => void;
  "vault:bootstrap:step": (data: VaultBootstrapStepEvent) => void;
  "vault:bootstrap:completed": (data: VaultBootstrapCompletedEvent) => void;
  "vault:unseal:started": (data: VaultUnsealStartedEvent) => void;
  "vault:unseal:step": (data: VaultUnsealStepEvent) => void;
  "vault:unseal:completed": (data: VaultUnsealCompletedEvent) => void;
  "vault:status:changed": (data: VaultStatusChangedEvent) => void;
  "vault:passphrase:unlocked": (data: VaultPassphraseLockEvent) => void;
  "vault:passphrase:locked": (data: VaultPassphraseLockEvent) => void;
  "vault:policy:applied": (data: VaultPolicyAppliedEvent) => void;
  "vault:approle:applied": (data: VaultAppRoleAppliedEvent) => void;

  // ── Egress Firewall ─────────────────────────────────
  /** Single DNS query ingested into EgressEvent (live traffic feed) */
  "egress:event": (data: EgressEventBroadcast) => void;
  /** Policy mode/defaultAction/version/archivedAt changed */
  "egress:policy:updated": (data: EgressPolicyUpdatedEvent) => void;
  /** Rule created, updated, or deleted */
  "egress:rule:mutation": (data: EgressRuleMutationEvent) => void;
  /** Per-env gateway health snapshot — fires after each push attempt */
  "egress:gateway:health": (data: EgressGatewayHealthEvent) => void;

  // ── Egress Firewall Agent (sidecar lifecycle) ──────
  /** Egress fw-agent startup started */
  "egress-fw-agent:startup:started": (data: {
    operationId: string;
    totalSteps: number;
    stepNames?: string[];
  }) => void;
  /** Egress fw-agent startup step completed */
  "egress-fw-agent:startup:step": (data: {
    operationId: string;
    step: OperationStep;
    completedCount: number;
    totalSteps: number;
  }) => void;
  /** Egress fw-agent startup completed (success or failure) */
  "egress-fw-agent:startup:completed": (data: {
    operationId: string;
    success: boolean;
    steps: OperationStep[];
    errors: string[];
  }) => void;
}

// ====================
// Client → Server Events
// ====================

export interface ClientToServerEvents {
  /** Subscribe to a channel to receive updates */
  subscribe: (channel: SocketChannel) => void;
  /** Unsubscribe from a channel */
  unsubscribe: (channel: SocketChannel) => void;
  /** Start streaming container logs */
  "container:logs:start": (data: {
    containerId: string;
    tail?: number;
    timestamps?: boolean;
  }) => void;
  /** Stop streaming container logs */
  "container:logs:stop": (data: { containerId: string }) => void;
}

// ====================
// Inter-Server Events (unused — single-server deployment)
// ====================

export interface InterServerEvents {}

// ====================
// Socket Data (per-socket metadata set by auth middleware)
// ====================

export interface SocketData {
  /** Authenticated user ID */
  userId: string;
  /** User display name */
  userName: string;
  /** Channels this socket is subscribed to */
  subscribedChannels: Set<SocketChannel>;
}

// ====================
// Typed Socket.IO Generics (convenience re-exports)
// ====================

/**
 * Use these when creating the server or client instances:
 *
 * Server:
 *   const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer);
 *
 * Client:
 *   const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(url);
 */
