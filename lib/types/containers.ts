// ====================
// Container Core Types
// ====================

export type ContainerStatus =
  | "running"
  | "stopped"
  | "restarting"
  | "paused"
  | "exited";

export interface ContainerPort {
  private: number;
  public?: number;
  type: "tcp" | "udp";
}

export interface ContainerVolume {
  source: string;
  destination: string;
  mode: "rw" | "ro";
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: ContainerStatus;
  image: string;
  imageTag: string;
  ports: ContainerPort[];
  volumes: ContainerVolume[];
  ipAddress?: string;
  createdAt: string; // ISO string for JSON serialization
  startedAt?: string; // ISO string for JSON serialization
  labels: Record<string, string>;
  // Deployment association (optional, populated when deploymentId filter is used)
  deploymentInfo?: {
    deploymentId: string;
    applicationName: string;
    containerRole: string; // 'old', 'new', 'blue', 'green'
  };
  // Environment association (optional, populated from container labels)
  environmentInfo?: {
    id: string;
    name: string;
    type: string; // 'production' | 'nonproduction'
  };
  // Self-identification: set when this container is part of Mini Infra itself
  selfRole?: 'main' | 'agent-sidecar' | 'update-sidecar';
}

// ====================
// Container Query Types
// ====================

export interface ContainerFilters {
  status?: string;
  name?: string;
  image?: string;
  deploymentId?: string;
  deploymentManaged?: boolean; // Filter for containers managed by deployments
}

export interface ContainerQueryParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  status?: string;
  name?: string;
  image?: string;
  deploymentId?: string;
  deploymentManaged?: boolean;
  filters?: ContainerFilters;
}

// ====================
// Container API Response Types
// ====================

export interface ContainerListResponse {
  containers: ContainerInfo[];
  totalCount: number;
  lastUpdated: string; // ISO string for JSON serialization
  page?: number;
  limit?: number;
}

export interface ContainerResponse {
  success: boolean;
  data: ContainerInfo;
  message?: string;
}

export interface ContainerListApiResponse {
  success: boolean;
  data: ContainerListResponse;
  message?: string;
}

// ====================
// Container Cache Types
// ====================

export interface ContainerCacheStats {
  keys: number;
  stats: {
    hits: number;
    misses: number;
    keys: number;
    ksize: number;
    vsize: number;
  };
}

export interface ContainerCacheResponse {
  cache: ContainerCacheStats;
  dockerConnected: boolean;
  timestamp: string;
  requestId?: string;
}

// ====================
// Container Action Types
// ====================

export type ContainerAction = "start" | "stop" | "restart" | "remove";

export interface ContainerActionRequest {
  action: ContainerAction;
}

export interface ContainerActionResponse {
  success: boolean;
  message: string;
  containerId: string;
  action: ContainerAction;
  status?: ContainerStatus;
}

// ====================
// Container Log Types
// ====================

export interface ContainerLogOptions {
  tail?: number; // Number of lines to show from the end
  follow?: boolean; // Stream logs in real-time
  timestamps?: boolean; // Include timestamps
  since?: string; // Show logs since timestamp (Unix timestamp)
  until?: string; // Show logs until timestamp (Unix timestamp)
  stdout?: boolean; // Include stdout
  stderr?: boolean; // Include stderr
}

export interface ContainerLogLine {
  timestamp?: string;
  message: string;
  stream: "stdout" | "stderr";
}

export interface ContainerLogEvent {
  type: "log" | "error" | "end";
  data?: ContainerLogLine;
  error?: string;
}

// ====================
// Server-only Types
// ====================

// These types are used internally by the Docker service and should not be exposed to the client

export interface DockerContainerInfo {
  id: string;
  name: string;
  status: ContainerStatus;
  image: string;
  imageTag: string;
  ports: ContainerPort[];
  volumes: ContainerVolume[];
  ipAddress?: string;
  createdAt: Date; // Date object for server-side processing
  startedAt?: Date; // Date object for server-side processing
  labels: Record<string, string>;
  env?: Record<string, string>;
}
