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

/**
 * `'container'` is a Phase 8 (`network-converger.ts`) addition — `reconcileStack`/
 * `reconcileEnvironment`/`reconcileAll` (Phase 7) never produce it; only
 * `convergeContainer()`'s `NetworkConvergeResult.scope` does, for the
 * single-container convergence primitive triggered by a Docker container
 * `start` event.
 */
export type NetworkReconcileScopeKind = 'stack' | 'environment' | 'all' | 'container';

export interface NetworkReconcileScope {
  kind: NetworkReconcileScopeKind;
  /** Set when `kind === 'stack'`. */
  stackId?: string;
  /** Set when `kind === 'environment'`. */
  environmentId?: string;
  /** Set when `kind === 'container'`. */
  containerId?: string;
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
// Network Convergence Types (network overhaul Phase 8 — enforcement + boot convergence)
// ====================

/**
 * Result of an actual convergence pass (as opposed to `NetworkReconcileReport`,
 * which is report-only). Produced by `convergeStack`/`convergeEnvironment`/
 * `convergeAll` in `server/src/services/networks/network-converger.ts` after
 * acting on a fresh `NetworkReconcileReport`'s drift items:
 *
 * - `network-missing` → `NetworkManager.ensure()` (create-if-missing, labels only).
 * - `membership-missing` → `NetworkManager.connect()` for each missing container.
 *   Always performed — this is the "connect-only by default" behavior.
 * - `membership-stale` → `NetworkManager.disconnect()`, but ONLY when the
 *   owning `ManagedNetwork.enforceMemberships` is `true`; otherwise counted in
 *   `skippedDisconnects` and left alone.
 * - `spec-mismatch` → never acted on (matches `NetworkManager.ensure()`'s own
 *   "never recreate" policy — unchanged from Phase 1/7).
 */
export interface NetworkConvergeResult {
  scope: NetworkReconcileScope;
  ranAt: string; // ISO string for JSON serialization
  /** `network-missing` items where `NetworkManager.ensure()` was invoked. */
  networksEnsured: number;
  /** Subset of `networksEnsured` where `ensure()` reported `created: true`. */
  networksCreated: number;
  /** Successful `connect()` calls for `membership-missing` containers. */
  membershipsConnected: number;
  /** Successful `disconnect()` calls for `membership-stale` containers (only ever non-zero when `enforceMemberships` is true on that network). */
  membershipsDisconnected: number;
  /** `membership-stale` items found but left alone because the network's `enforceMemberships` is false — the default-safe outcome. */
  skippedDisconnects: number;
  /** `membership-stale` containers whose disconnect was deferred because the container was created too recently (grace window) — a race-with-creation guard, not a permanent skip; the next sweep re-evaluates them. */
  skippedRecentContainers: number;
  /** Count of individual per-item action failures — logged and swallowed, never thrown (mirrors the rest of this subsystem's non-fatal error handling). */
  errors: number;
}

export interface NetworkConvergeResponse {
  success: boolean;
  data: NetworkConvergeResult;
  message?: string;
}

/**
 * Per-network `enforceMemberships` gate, set by Docker network `name` (the
 * identifier operators already see via `GET /api/docker/networks` and
 * `docker network ls` — no separate "list managed networks" surface exists
 * yet; that's the Phase 9 networks tab). Phase 8 ships the API only; Phase 9
 * adds the UI toggle that calls it.
 */
export interface SetNetworkEnforceMembershipsRequest {
  name: string;
  enforceMemberships: boolean;
}

export interface ManagedNetworkSummary {
  id: string;
  name: string;
  scope: string;
  purpose: string;
  enforceMemberships: boolean;
}

export interface SetNetworkEnforceMembershipsResponse {
  success: boolean;
  data: ManagedNetworkSummary;
  message?: string;
}

// ====================
// Managed Network Listing Types (network overhaul Phase 9 — visibility UI)
// ====================

/** Provenance values a `NetworkMembership` row can carry (Phase 5 schema; see `server/src/services/networks/membership-store.ts`). */
export type NetworkMembershipSource = 'template' | 'user' | 'egress' | 'haproxy' | 'system';

/**
 * Whether a desired-state membership is actually satisfied right now:
 * - `connected`: every live container resolved for this target is attached.
 * - `missing`: the target resolves to at least one live container, but at
 *   least one of them isn't attached (mirrors the Phase 7 reconciler's
 *   `membership-missing` drift item).
 * - `not-deployed`: the target (a `StackService`) has no live container at
 *   all yet — not drift, just "nothing to attach to yet".
 */
export type ManagedNetworkMembershipStatus = 'connected' | 'missing' | 'not-deployed';

export interface ManagedNetworkContainerRef {
  id: string;
  name: string;
}

/**
 * One desired-state `NetworkMembership` row, resolved for display: who it
 * targets, why (`source`/creator), and whether it's actually attached right
 * now. This is the "why is this container on this network" answer the Phase
 * 9 UI surfaces.
 */
export interface ManagedNetworkMembershipView {
  id: string;
  /** Set when the target is a managed `StackService` — resolved to live container(s) by label at read time. */
  stackServiceId?: string;
  /** The owning stack's id, resolved from `stackServiceId` — lets a caller filter "this application's own membership" out of a shared network's full membership list without a name-matching heuristic. */
  stackId?: string;
  /** The service's own name, resolved for display — the row itself only stores the id. */
  serviceName?: string;
  /** The owning stack's name, resolved for display. */
  stackName?: string;
  /** Set when the target is an adopted/external container, or the `'self'` sentinel for the mini-infra server itself. */
  containerName?: string;
  source: NetworkMembershipSource;
  /** userId, set only when `source === 'user'`. */
  createdBy?: string;
  /** Resolved display name/email for `createdBy`, when resolvable. */
  createdByName?: string;
  aliases?: string[];
  staticIp?: string;
  status: ManagedNetworkMembershipStatus;
  /** Live container(s) currently satisfying this membership. Empty when `status !== 'connected'`. */
  connectedContainers: ManagedNetworkContainerRef[];
}

/**
 * A live container attached to a managed network with no matching
 * desired-state row — surfaced for visibility. Same spirit as the Phase 7
 * reconciler's unmanaged-attachment notes, but without that module's
 * stale-eligibility restrictions (this is a read-only listing, not a drift
 * alarm, so it's safe to show every unattributed attachment rather than only
 * the ones the reconciler is confident enough to flag).
 */
export type ManagedNetworkUnattributedContainer = ManagedNetworkContainerRef;

/**
 * One `ManagedNetwork` row plus its resolved owner, live Docker state, and
 * full desired-vs-actual membership table. The Phase 9 networks tab,
 * environment detail networks panel, and application detail connected-networks
 * list all read from this.
 */
export interface ManagedNetworkView {
  id: string;
  name: string;
  scope: 'host' | 'environment' | 'stack';
  environmentId?: string;
  /** Resolved environment name, when `environmentId` is set. */
  environmentName?: string;
  stackId?: string;
  /** Resolved stack name, when `stackId` is set. */
  stackName?: string;
  purpose: string;
  driver: string;
  /** `ManagedNetwork.status` — the DB-cached status column (see Phase 5 schema; not the same as the live `existence` check below). */
  dbStatus: string;
  /** Live tri-state existence, from an `inspectForReconcile()` call made for this listing. */
  existence: 'present' | 'absent' | 'unknown';
  dockerId?: string;
  subnet?: string;
  enforceMemberships: boolean;
  /**
   * Whether the Phase 7 reconciler currently reports any drift item for this
   * network — reused from `reconcileStack`/`reconcileEnvironment`/
   * `reconcileAll`, never re-derived here, so this view can never disagree
   * with the stack plan's own network-drift reporting.
   */
  driftStatus: 'synced' | 'drifted';
  driftItemCount: number;
  memberships: ManagedNetworkMembershipView[];
  unattributedContainers: ManagedNetworkUnattributedContainer[];
}

export interface ManagedNetworkListQuery {
  scope?: 'host' | 'environment' | 'stack';
  environmentId?: string;
  stackId?: string;
}

export interface ManagedNetworkListResponse {
  success: boolean;
  data: ManagedNetworkView[];
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
