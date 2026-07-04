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
// Docker Network GC Types (network overhaul Phase 4 — label-driven GC)
// ====================

export type DockerNetworkGcOwnerKind = 'stack' | 'environment' | 'host';

/** A `mini-infra.managed=true` network whose owner (stack/environment) no longer exists in the DB. */
export interface DockerNetworkGcOrphan {
  name: string;
  ownerKind: DockerNetworkGcOwnerKind;
  ownerId?: string;
  purpose: string;
  connectedContainerCount: number;
  /** Owner gone AND zero attached containers — the two conditions GC requires before it will ever remove a network. */
  eligibleForRemoval: boolean;
  /** Only set when a real (non-dry-run) removal was attempted this run. */
  removed?: boolean;
}

export interface DockerNetworkGcReport {
  dryRun: boolean;
  scannedCount: number;
  orphans: DockerNetworkGcOrphan[];
  removedCount: number;
  ranAt: string; // ISO string for JSON serialization
}

export interface DockerNetworkGcRequest {
  /** Defaults to true (report-only, no Docker mutation) when omitted. */
  dryRun?: boolean;
}

export interface DockerNetworkGcResponse {
  success: boolean;
  data: DockerNetworkGcReport;
  message?: string;
}

// ====================
// Network Membership Backfill Types (network overhaul Phase 6)
// ====================

/** Summary counters from a `backfillNetworkMemberships()` run — see `services/networks/membership-backfill.ts`. */
export interface NetworkMembershipBackfillSummary {
  infraResourcesScanned: number;
  stacksScanned: number;
  servicesScanned: number;
  danglingSkipped: number;
  managedNetworksTotal: number;
  networkMembershipsTotal: number;
}

export interface NetworkMembershipBackfillResponse {
  success: boolean;
  data: NetworkMembershipBackfillSummary;
  message?: string;
}

// ====================
// Network Reconciler Types (network overhaul Phase 7 — dry-run diff)
// ====================

/**
 * Diff between an existing Docker network's driver/labels/options and the
 * desired spec computed from its `ManagedNetwork` row. Shared between
 * `NetworkManager` (which only *logs* a mismatch — see `ensure()`) and the
 * Phase 7 `NetworkReconciler` (which *reports* it as a `spec-mismatch` drift
 * item) so both consumers agree on exactly one mismatch shape.
 */
export interface NetworkSpecMismatch {
  driver?: { expected: string; actual: string };
  labels?: {
    expected: Record<string, string>;
    actual: Record<string, string>;
    missing: string[];
    changed: string[];
  };
  options?: { expected: Record<string, string>; actual: Record<string, string> };
}

export type NetworkDriftItemType = 'network-missing' | 'membership-missing' | 'membership-stale' | 'spec-mismatch';

/** Which desired-state row a `membership-missing`/`membership-stale` item concerns. */
export interface NetworkDriftTarget {
  /** Set when resolved via a `NetworkMembership.stackServiceId` row. */
  stackServiceId?: string;
  /** The service's own name, resolved for display — the row itself only stores the id. */
  serviceName?: string;
  /** Set when resolved via a `NetworkMembership.containerName` row (adopted/external container, or the `'self'` sentinel). */
  containerName?: string;
}

export interface NetworkDriftContainerRef {
  id: string;
  name: string;
}

/**
 * One unit of network drift, as produced by the Phase 7 `NetworkReconciler`
 * and consumed by the stack plan computer (`StackPlan.networkActions`) and,
 * later, by Phase 8 (enforcement) and Phase 9 (the networks visibility UI).
 * Never implies a mutation was made — Phase 7 is report-only.
 */
export interface NetworkDriftItem {
  type: NetworkDriftItemType;
  /** Docker network name. */
  networkName: string;
  purpose: string;
  scope: 'host' | 'environment' | 'stack';
  /** `ManagedNetwork.id` this item concerns. */
  managedNetworkId: string;
  /** Set for `membership-missing`/`membership-stale`. */
  target?: NetworkDriftTarget;
  /**
   * For `membership-missing`: the live container(s) that should be attached
   * but aren't. For `membership-stale`: the one unexpectedly-attached
   * container. Always contains real Docker container ids/names — never a
   * container that only exists as a desired-state row.
   */
  containers?: NetworkDriftContainerRef[];
  /** Set for `spec-mismatch`. */
  mismatch?: NetworkSpecMismatch;
  message: string;
}

/**
 * A live container attached to a `mini-infra.managed=true` network with no
 * matching desired-state row — but one the reconciler is NOT confident
 * enough to call `membership-stale` (see `NetworkReconciler`'s conservative
 * rule doc comment). Purely informational: never counted in
 * `NetworkReconcileReport.items`, never folds into `StackPlan.hasChanges`,
 * and must never be treated as an input to a future Phase 8 disconnect.
 */
export interface NetworkUnmanagedAttachmentNote {
  networkName: string;
  containerId: string;
  containerName: string;
  reason: string;
}

export type NetworkReconcileScopeKind = 'stack' | 'environment' | 'all';

export interface NetworkReconcileScope {
  kind: NetworkReconcileScopeKind;
  /** Set when `kind === 'stack'`. */
  stackId?: string;
  /** Set when `kind === 'environment'`. */
  environmentId?: string;
}

export interface NetworkReconcileReport {
  scope: NetworkReconcileScope;
  ranAt: string; // ISO string for JSON serialization
  networksChecked: number;
  membershipsChecked: number;
  items: NetworkDriftItem[];
  notes: NetworkUnmanagedAttachmentNote[];
}

export interface NetworkReconcileResponse {
  success: boolean;
  data: NetworkReconcileReport;
  message?: string;
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
  /**
   * The inspection record, or `null` when no inspection has been started for
   * this volume yet. The route returns 200 with `data: null` rather than 404
   * so list views that probe inspection state on every render don't generate
   * noise.
   */
  data: VolumeInspection | null;
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
