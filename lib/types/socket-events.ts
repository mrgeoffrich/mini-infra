import type {
  ContainerInfo,
  ContainerStatus,
  ContainerLogLine,
} from "./containers";
import type {
  DeploymentInfo,
  DeploymentStatus,
  DeploymentStepInfo,
  RemovalOperationInfo,
} from "./deployments";
import type { ConnectivityStatusInfo } from "./settings";
import type { BackupHealthStatus } from "./self-backup";
import type { UserEventInfo } from "./user-events";
import type { ServiceApplyResult, ApplyResult, DestroyResult } from "./stacks";
import type { MigrationStep, MigrationResult } from "./deployments";

// ====================
// Socket Channel Constants & Types
// ====================

/** All static (non-parameterized) channel names as a runtime array */
export const STATIC_SOCKET_CHANNELS = [
  "containers",
  "deployments",
  "postgres",
  "monitoring",
  "events",
  "connectivity",
  "logs",
  "stacks",
  "volumes",
  "networks",
  "backup-health",
] as const;

/** Static (non-parameterized) channels */
export type StaticSocketChannel = (typeof STATIC_SOCKET_CHANNELS)[number];

/** Prefixes for parameterized channels */
export const PARAMETERIZED_CHANNEL_PREFIXES = [
  "container:",
  "deployment:",
  "removal:",
] as const;

/** Parameterized channels with entity IDs */
export type ParameterizedSocketChannel =
  | `container:${string}`
  | `deployment:${string}`
  | `removal:${string}`;

/** All valid channel names that clients can subscribe to */
export type SocketChannel = StaticSocketChannel | ParameterizedSocketChannel;

/** Named constants for static channels */
export const Channel = {
  CONTAINERS: "containers",
  DEPLOYMENTS: "deployments",
  POSTGRES: "postgres",
  MONITORING: "monitoring",
  EVENTS: "events",
  CONNECTIVITY: "connectivity",
  LOGS: "logs",
  STACKS: "stacks",
  VOLUMES: "volumes",
  NETWORKS: "networks",
  BACKUP_HEALTH: "backup-health",
} as const satisfies Record<string, StaticSocketChannel>;

/** Helpers to build parameterized channel names */
export const ParameterizedChannel = {
  container: (id: string): SocketChannel => `container:${id}`,
  deployment: (id: string): SocketChannel => `deployment:${id}`,
  removal: (id: string): SocketChannel => `removal:${id}`,
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
  // Deployments
  DEPLOYMENT_STATUS: "deployment:status",
  DEPLOYMENT_STEP: "deployment:step",
  DEPLOYMENT_COMPLETED: "deployment:completed",
  DEPLOYMENTS_ACTIVE: "deployments:active",
  // Removal
  REMOVAL_STATUS: "removal:status",
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
  // HAProxy Migration
  MIGRATION_STARTED: "migration:started",
  MIGRATION_STEP: "migration:step",
  MIGRATION_COMPLETED: "migration:completed",
  // Volumes
  VOLUMES_LIST: "volumes:list",
  // Networks
  NETWORKS_LIST: "networks:list",
  // Backup Health
  BACKUP_HEALTH_STATUS: "backup-health:status",
  // Logs (Loki)
  LOGS_ENTRIES: "logs:entries",
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

  // ── Deployments ─────────────────────────────────────
  /** Deployment status changed */
  "deployment:status": (data: {
    id: string;
    configurationId: string;
    status: DeploymentStatus;
    currentState: string;
  }) => void;
  /** Deployment step progress */
  "deployment:step": (data: DeploymentStepInfo) => void;
  /** Deployment completed (success or failure) */
  "deployment:completed": (data: DeploymentInfo) => void;
  /** Active deployments list update */
  "deployments:active": (data: DeploymentInfo[]) => void;

  // ── Removal Operations ──────────────────────────────
  /** Removal operation progress */
  "removal:status": (data: RemovalOperationInfo) => void;

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
  }) => void;
  /** Individual service within a stack apply completed */
  "stack:apply:service-result": (data: ServiceApplyResult & {
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
