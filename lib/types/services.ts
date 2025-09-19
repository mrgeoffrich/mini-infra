// Re-export the service types from the application service interface
export type ServiceStatus =
  | 'uninitialized'
  | 'initializing'
  | 'initialized'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'degraded';

export const ServiceStatusValues = {
  UNINITIALIZED: 'uninitialized' as const,
  INITIALIZING: 'initializing' as const,
  INITIALIZED: 'initialized' as const,
  STARTING: 'starting' as const,
  RUNNING: 'running' as const,
  STOPPING: 'stopping' as const,
  STOPPED: 'stopped' as const,
  FAILED: 'failed' as const,
  DEGRADED: 'degraded' as const,
};

export type ApplicationServiceHealthStatus =
  | 'healthy'
  | 'unhealthy'
  | 'unknown';

export const ApplicationServiceHealthStatusValues = {
  HEALTHY: 'healthy' as const,
  UNHEALTHY: 'unhealthy' as const,
  UNKNOWN: 'unknown' as const,
};

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