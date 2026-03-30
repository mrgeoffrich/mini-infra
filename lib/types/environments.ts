export type EnvironmentType = 'production' | 'nonproduction';
export type EnvironmentNetworkType = 'local' | 'internet';
export type EnvironmentNetworkPurpose = 'applications' | 'tunnel' | 'custom';

export interface Environment {
  id: string;
  name: string;
  description?: string;
  type: EnvironmentType;
  networkType: EnvironmentNetworkType;
  tunnelId?: string;
  tunnelServiceUrl?: string;
  networks: EnvironmentNetwork[];
  volumes: EnvironmentVolume[];
  createdAt: Date;
  updatedAt: Date;
}

export interface EnvironmentNetwork {
  id: string;
  environmentId: string;
  name: string;
  purpose: EnvironmentNetworkPurpose;
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
  tunnelId?: string;
  tunnelServiceUrl?: string;
}

export interface ServiceConfiguration {
  serviceName: string;
  serviceType: string;
  config?: Record<string, any>;
}

// Operation result types
export interface EnvironmentOperationResult {
  success: boolean;
  message?: string;
  details?: Record<string, any>;
  duration?: number;
}

// List and pagination types
export interface ListEnvironmentsRequest {
  type?: EnvironmentType;
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