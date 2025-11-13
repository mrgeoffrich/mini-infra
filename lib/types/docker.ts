// ====================
// Docker Network Types
// ====================

export interface DockerNetworkContainer {
  name: string;
  endpointId: string;
  macAddress: string;
  ipv4Address: string;
  ipv6Address: string;
}

export interface DockerNetworkIPAM {
  driver: string;
  config: Array<{
    subnet: string;
    gateway?: string;
  }>;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string; // 'bridge', 'host', 'overlay', 'macvlan', etc.
  scope: string; // 'local', 'global', 'swarm'
  internal: boolean;
  attachable: boolean;
  ipam: DockerNetworkIPAM;
  containers: DockerNetworkContainer[];
  createdAt: string; // ISO string for JSON serialization
  labels: Record<string, string>;
  options: Record<string, string>;
}

export interface DockerNetworkListResponse {
  networks: DockerNetwork[];
  totalCount: number;
  lastUpdated: string; // ISO string for JSON serialization
}

export interface DockerNetworkApiResponse {
  success: boolean;
  data: DockerNetworkListResponse;
  message?: string;
}

export interface DockerNetworkDeleteResponse {
  success: boolean;
  message: string;
  networkId: string;
}

// ====================
// Docker Volume Types
// ====================

export interface DockerVolumeUsageData {
  size: number; // Size in bytes
  refCount: number; // Number of containers using this volume
}

export interface DockerVolume {
  name: string;
  driver: string; // 'local', 'nfs', etc.
  mountpoint: string; // Path on the host where volume is mounted
  createdAt: string; // ISO string for JSON serialization
  scope: string; // 'local', 'global'
  labels: Record<string, string>;
  options: Record<string, string> | null;
  usageData?: DockerVolumeUsageData; // Optional, may not be available
  // Derived fields
  inUse: boolean; // Whether any containers are using this volume
  containerCount: number; // Number of containers using this volume
}

export interface DockerVolumeListResponse {
  volumes: DockerVolume[];
  totalCount: number;
  lastUpdated: string; // ISO string for JSON serialization
}

export interface DockerVolumeApiResponse {
  success: boolean;
  data: DockerVolumeListResponse;
  message?: string;
}

export interface DockerVolumeDeleteResponse {
  success: boolean;
  message: string;
  volumeName: string;
}

// ====================
// Docker Query Types
// ====================

export interface DockerNetworkFilters {
  name?: string;
  driver?: string;
}

export interface DockerVolumeFilters {
  name?: string;
  driver?: string;
}
