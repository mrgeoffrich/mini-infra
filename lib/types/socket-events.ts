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
import type { UserEventInfo } from "./user-events";

// ====================
// Socket Channel Types
// ====================

/** Static (non-parameterized) channels */
export type StaticSocketChannel =
  | "containers"
  | "deployments"
  | "postgres"
  | "monitoring"
  | "events"
  | "connectivity"
  | "logs"
  | "stacks"
  | "volumes"
  | "networks"
  | "backup-health";

/** Parameterized channels with entity IDs */
export type ParameterizedSocketChannel =
  | `container:${string}`
  | `deployment:${string}`
  | `removal:${string}`;

/** All valid channel names that clients can subscribe to */
export type SocketChannel = StaticSocketChannel | ParameterizedSocketChannel;

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

  // ── Volumes ─────────────────────────────────────────
  /** Volume list updated */
  "volumes:list": (data: { count: number }) => void;

  // ── Networks ────────────────────────────────────────
  /** Network list updated */
  "networks:list": (data: { count: number }) => void;

  // ── Backup Health ───────────────────────────────────
  /** Self-backup health status */
  "backup-health:status": (data: {
    healthy: boolean;
    lastBackupAt: string | null;
    nextBackupAt: string | null;
  }) => void;

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
