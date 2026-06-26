export const ENVIRONMENT_TYPES = ['production', 'nonproduction'] as const;
export type EnvironmentType = typeof ENVIRONMENT_TYPES[number];
export const ENVIRONMENT_NETWORK_TYPES = ['local', 'internet'] as const;
export type EnvironmentNetworkType = typeof ENVIRONMENT_NETWORK_TYPES[number];
export type EnvironmentNetworkPurpose = 'custom';

export interface Environment {
  id: string;
  name: string;
  description?: string;
  type: EnvironmentType;
  networkType: EnvironmentNetworkType;
  tunnelId?: string;
  tunnelServiceUrl?: string;
  egressFirewallEnabled: boolean;
  networks: EnvironmentNetwork[];
  stackCount: number;
  systemStackCount: number;
  /**
   * The environment's egress network (subnet, gateway, health). Only populated
   * on the single-environment detail response, not on list responses.
   */
  egressNetwork?: EgressNetworkInfo;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Health of the per-environment egress network.
 * - `present`: recorded and the Docker network is live.
 * - `missing`: no egress network has been provisioned.
 * - `error`: a subnet was recorded but the Docker network is gone (drift).
 */
export type EgressNetworkStatus = 'present' | 'missing' | 'error';

/**
 * The per-environment egress network as surfaced on the environment detail
 * screen. The subnet is chosen by Docker's IPAM at provisioning time and
 * recorded by the server; the values here are read back, not prescribed.
 */
export interface EgressNetworkInfo {
  /** Docker network name, e.g. `local-egress`. */
  name: string;
  /** Subnet Docker assigned, e.g. `172.24.0.0/16`. Null if not recorded. */
  subnet: string | null;
  /** Bridge gateway address (`.1`), e.g. `172.24.0.1`. Null if not recorded. */
  bridgeGateway: string | null;
  /** Egress gateway container's static IP, e.g. `172.24.0.3`. Null if not allocated. */
  gatewayContainerIp: string | null;
  /** Derived health of the egress network. */
  status: EgressNetworkStatus;
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
  egressFirewallEnabled?: boolean;
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
    haproxyFrontends: EnvironmentDependencyItem[];
    haproxyBackends: EnvironmentDependencyItem[];
  };
}