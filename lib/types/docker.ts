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

// ====================
// Docker Volume Inspection Types
// ====================

export type VolumeInspectionStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface VolumeFileInfo {
  path: string; // File path within the volume
  size: number; // File size in bytes
  permissions: string; // File permissions (e.g., "755", "644")
  owner: string; // Owner in format "user:group"
  modifiedAt: string; // ISO string for JSON serialization (timestamp)
}

export interface VolumeInspection {
  id: string;
  volumeName: string;
  status: VolumeInspectionStatus;
  inspectedAt: string; // ISO string for JSON serialization
  completedAt: string | null; // ISO string for JSON serialization
  durationMs: number | null; // Inspection duration in milliseconds
  fileCount: number | null; // Total number of files found
  totalSize: number | null; // Total size in bytes (bigint as number)
  files: VolumeFileInfo[] | null; // Array of file information
  stdout: string | null; // Standard output from inspection container
  stderr: string | null; // Standard error from inspection container
  errorMessage: string | null; // Error message if failed
  createdAt: string; // ISO string for JSON serialization
  updatedAt: string; // ISO string for JSON serialization
}

export interface VolumeInspectionResponse {
  success: boolean;
  data: VolumeInspection;
  message?: string;
}

export interface VolumeInspectionStartResponse {
  success: boolean;
  data: {
    volumeName: string;
    status: VolumeInspectionStatus;
    message: string;
  };
  message?: string;
}

// ====================
// Docker Volume File Content Types
// ====================

export interface VolumeFileContent {
  id: string;
  volumeName: string;
  filePath: string; // File path within the volume (e.g., "/app/config.json")
  content: string; // Text content (up to 1MB)
  size: number; // Original file size in bytes
  fetchedAt: string; // ISO string for JSON serialization
  errorMessage: string | null; // Error message if fetch failed
  createdAt: string; // ISO string for JSON serialization
  updatedAt: string; // ISO string for JSON serialization
}

export interface FetchFileContentsRequest {
  filePaths: string[]; // Array of file paths to fetch
}

export interface FetchFileContentsResponse {
  success: boolean;
  data: {
    fetched: number; // Number of files successfully fetched
    skipped: number; // Number of files skipped (binary, too large, etc.)
    errors: string[]; // Array of error messages for failed files
  };
  message?: string;
}

export interface VolumeFileContentResponse {
  success: boolean;
  data: VolumeFileContent;
  message?: string;
}
