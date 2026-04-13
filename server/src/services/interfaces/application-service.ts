/**
 * Application Service Interface
 *
 * Standardized interface for application services that can be managed
 * centrally with consistent lifecycle management and status reporting.
 */

import {
  ServiceStatus,
  ServiceStatusValues,
  ApplicationServiceHealthStatus as HealthStatus,
  ApplicationServiceHealthStatusValues as HealthStatusValues,
  ServiceHealth,
  NetworkRequirement,
  VolumeRequirement,
  PortRequirement,
  ServiceMetadata,
  StartupResult,
  ServiceStatusInfo,
} from '@mini-infra/types';

// Re-export values under canonical names used by this module's consumers
export { ServiceStatusValues, HealthStatusValues };

// Re-export types (interfaces and type aliases)
export type {
  ServiceStatus,
  HealthStatus,
  ServiceHealth,
  NetworkRequirement,
  VolumeRequirement,
  PortRequirement,
  ServiceMetadata,
  StartupResult,
  ServiceStatusInfo,
};

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
