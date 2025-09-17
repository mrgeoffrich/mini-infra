// Re-export the service types from the application service interface
export enum ServiceStatus {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  INITIALIZED = 'initialized',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  FAILED = 'failed',
  DEGRADED = 'degraded'
}

export enum ApplicationServiceHealthStatus {
  HEALTHY = 'healthy',
  UNHEALTHY = 'unhealthy',
  UNKNOWN = 'unknown'
}

export interface ServiceHealth {
  status: ApplicationServiceHealthStatus;
  message?: string;
  lastChecked: Date;
  details?: Record<string, any>;
}

export interface NetworkRequirement {
  name: string;
  driver?: string;
  options?: Record<string, any>;
}

export interface VolumeRequirement {
  name: string;
  driver?: string;
  options?: Record<string, any>;
}

export interface PortRequirement {
  name: string;
  containerPort: number;
  hostPort: number;
  protocol?: 'tcp' | 'udp';
  description?: string;
}

export interface ServiceMetadata {
  name: string;
  version: string;
  description?: string;
  dependencies: string[];
  tags?: string[];
  requiredNetworks: NetworkRequirement[];
  requiredVolumes: VolumeRequirement[];
  exposedPorts: PortRequirement[];
}

export interface StartupResult {
  success: boolean;
  message?: string;
  details?: Record<string, any>;
  duration?: number;
}

export interface ServiceStatusInfo {
  status: ServiceStatus;
  health: ServiceHealth;
  startedAt?: Date;
  stoppedAt?: Date;
  metadata: ServiceMetadata;
  lastError?: {
    message: string;
    timestamp: Date;
    details?: Record<string, any>;
  };
}