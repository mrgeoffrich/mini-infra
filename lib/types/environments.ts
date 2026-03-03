import { ServiceStatus, ApplicationServiceHealthStatus } from './services';

export type EnvironmentType = 'production' | 'nonproduction';
export type EnvironmentNetworkType = 'local' | 'internet';

export interface Environment {
  id: string;
  name: string;
  description?: string;
  type: EnvironmentType;
  networkType: EnvironmentNetworkType;
  status: ServiceStatus;
  isActive: boolean;
  services: EnvironmentService[];
  networks: EnvironmentNetwork[];
  volumes: EnvironmentVolume[];
  createdAt: Date;
  updatedAt: Date;
}

export interface EnvironmentService {
  id: string;
  environmentId: string;
  serviceName: string;
  serviceType: string;
  status: ServiceStatus;
  health: ApplicationServiceHealthStatus;
  config: Record<string, any>;
  startedAt?: Date;
  stoppedAt?: Date;
  lastError?: {
    message: string;
    timestamp: Date;
    details?: Record<string, any>;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface EnvironmentNetwork {
  id: string;
  environmentId: string;
  name: string;
  driver: string;
  options?: Record<string, any>;
  dockerId?: string;
  createdAt: Date;
}

export interface EnvironmentVolume {
  id: string;
  environmentId: string;
  name: string;
  driver: string;
  options?: Record<string, any>;
  dockerId?: string;
  createdAt: Date;
}

// Request/Response types
export interface CreateEnvironmentRequest {
  name: string;
  description?: string;
  type: EnvironmentType;
  networkType?: EnvironmentNetworkType;
  services?: ServiceConfiguration[];
}

export interface UpdateEnvironmentRequest {
  description?: string;
  type?: EnvironmentType;
  networkType?: EnvironmentNetworkType;
  isActive?: boolean;
}

export interface ServiceConfiguration {
  serviceName: string;
  serviceType: string;
  config?: Record<string, any>;
}

export interface AddServiceToEnvironmentRequest {
  serviceName: string;
  serviceType: string;
  config?: Record<string, any>;
}

export interface UpdateEnvironmentServiceRequest {
  config?: Record<string, any>;
}

// Status and health response types
export interface EnvironmentStatusResponse {
  environment: Environment;
  servicesHealth: Array<{
    serviceName: string;
    status: ServiceStatus;
    health: ApplicationServiceHealthStatus;
    healthDetails?: Record<string, any>;
  }>;
  networksStatus: Array<{
    name: string;
    exists: boolean;
    dockerId?: string;
  }>;
  volumesStatus: Array<{
    name: string;
    exists: boolean;
    dockerId?: string;
  }>;
}

export interface ServiceTypeMetadata {
  serviceType: string;
  description: string;
  version: string;
  requiredNetworks: Array<{
    name: string;
    driver?: string;
  }>;
  requiredVolumes: Array<{
    name: string;
    driver?: string;
  }>;
  exposedPorts: Array<{
    name: string;
    containerPort: number;
    hostPort: number;
    protocol?: 'tcp' | 'udp';
    description?: string;
  }>;
  dependencies: string[];
  tags: string[];
}

export interface AvailableServicesResponse {
  services: ServiceTypeMetadata[];
}

// Operation result types
export interface EnvironmentOperationResult {
  success: boolean;
  message?: string;
  details?: Record<string, any>;
  duration?: number;
}

export interface ServiceOperationResult {
  success: boolean;
  serviceName: string;
  message?: string;
  details?: Record<string, any>;
  duration?: number;
}

// List and pagination types
export interface ListEnvironmentsRequest {
  type?: EnvironmentType;
  status?: ServiceStatus;
  page?: number;
  limit?: number;
}

export interface ListEnvironmentsResponse {
  environments: Environment[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

// Network management types
export interface CreateNetworkRequest {
  name: string;
  driver?: string;
  options?: Record<string, any>;
}

export interface UpdateNetworkRequest {
  driver?: string;
  options?: Record<string, any>;
}

export interface NetworksResponse {
  networks: EnvironmentNetwork[];
}

// Volume management types
export interface CreateVolumeRequest {
  name: string;
  driver?: string;
  options?: Record<string, any>;
}

export interface UpdateVolumeRequest {
  driver?: string;
  options?: Record<string, any>;
}

export interface VolumesResponse {
  volumes: EnvironmentVolume[];
}