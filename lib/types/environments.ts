export type EnvironmentType = 'production' | 'nonproduction';
export type EnvironmentNetworkType = 'local' | 'internet';
export type EnvironmentNetworkPurpose = 'custom';

export interface Environment {
  id: string;
  name: string;
  description?: string;
  type: EnvironmentType;
  networkType: EnvironmentNetworkType;
  tunnelId?: string;
  tunnelServiceUrl?: string;
  networks: EnvironmentNetwork[];
  stackCount: number;
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

// Request/Response types
export interface CreateEnvironmentRequest {
  name: string;
  description?: string;
  type: EnvironmentType;
  networkType?: EnvironmentNetworkType;
}

export interface UpdateEnvironmentRequest {
  description?: string;
  type?: EnvironmentType;
  networkType?: EnvironmentNetworkType;
  tunnelId?: string;
  tunnelServiceUrl?: string;
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

// Delete check types
export interface EnvironmentDependencyItem {
  id: string;
  name: string;
}

export interface EnvironmentDeleteCheck {
  canDelete: boolean;
  dependencies: {
    stacks: EnvironmentDependencyItem[];
    deploymentConfigurations: EnvironmentDependencyItem[];
    haproxyFrontends: EnvironmentDependencyItem[];
    haproxyBackends: EnvironmentDependencyItem[];
    stackTemplates: EnvironmentDependencyItem[];
  };
}