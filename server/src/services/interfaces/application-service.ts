/**
 * Application Service Interface
 *
 * Standardized interface for application services that can be managed
 * centrally with consistent lifecycle management and status reporting.
 */

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

export enum HealthStatus {
  HEALTHY = 'healthy',
  UNHEALTHY = 'unhealthy',
  UNKNOWN = 'unknown'
}

export interface ServiceHealth {
  status: HealthStatus;
  message?: string;
  lastChecked: Date;
  details?: Record<string, unknown>;
}

export interface NetworkRequirement {
  name: string;
  driver?: string;
  options?: Record<string, unknown>;
}

export interface VolumeRequirement {
  name: string;
  driver?: string;
  options?: Record<string, unknown>;
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
  details?: Record<string, unknown>;
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
    details?: Record<string, unknown>;
  };
}

export interface IApplicationService {
  /**
   * Service metadata
   */
  readonly metadata: ServiceMetadata;

  /**
   * Initialize the service - prepare resources but don't start
   * @param networks - List of networks that have been created for this service
   * @param volumes - List of volumes that have been created for this service
   */
  initialize(networks?: NetworkRequirement[], volumes?: VolumeRequirement[]): Promise<void>;

  /**
   * Start the service and return when it's fully operational
   */
  start(): Promise<StartupResult>;

  /**
   * Stop the service gracefully
   */
  stopAndCleanup(): Promise<void>;

  /**
   * Get current service status
   */
  getStatus(): Promise<ServiceStatusInfo>;

  /**
   * Check if service is ready to start (dependencies met)
   */
  isReadyToStart(): Promise<boolean>;
}

export interface ServiceDependency {
  serviceName: string;
  required: boolean;
  minimumStatus: ServiceStatus;
}

export interface ServiceRegistrationOptions {
  autoStart?: boolean;
  startTimeout?: number;
  healthCheckInterval?: number;
  retryAttempts?: number;
}