// ====================
// Pluggable Storage Backend Types
// ====================
//
// The single, provider-agnostic surface that postgres backups, self-backups,
// and TLS certificate storage consume. Concrete implementations (Azure Blob,
// Google Drive, etc.) live behind this interface; the operator picks one
// active provider via the Storage settings page.
//
// Notes:
//  - `mintUploadHandle` is REQUIRED on every backend because the
//    `pg-az-backup` sidecar uploads from inside the container directly. Each
//    provider returns a discriminated `UploadHandle` payload the sidecar can
//    consume (Azure SAS URL today, Google Drive token in Phase 3).
//  - `getDownloadHandle` is optional. Azure can mint a time-limited SAS URL;
//    Drive cannot, so callers fall back to streaming via `getDownloadStream`.

import type { ServiceHealthStatus, ValidationResult } from "./settings";

// ====================
// Provider identity
// ====================

export const STORAGE_PROVIDER_IDS = ["azure", "google-drive"] as const;
export type StorageProviderId = typeof STORAGE_PROVIDER_IDS[number];

// ====================
// Location + object metadata
// ====================

/**
 * A logical "where to put it" reference. The `id` is opaque per-provider:
 * an Azure container name, a Google Drive folder ID, etc. Callers never
 * interpret it.
 */
export interface StorageLocationRef {
  id: string;
  displayName?: string;
}

export interface LocationInfo {
  id: string;
  displayName: string;
  /** Provider-native last-modified timestamp, if available. */
  lastModified?: string;
  /** Whether the caller's credentials can read/write this location. */
  accessible: boolean;
  /** Free-form provider metadata (lease state, parent folder, etc.). */
  metadata?: Record<string, unknown>;
}

export interface StorageObjectMetadata {
  name: string;
  size: number;
  /** Provider's authoritative version/etag string, if any. */
  etag?: string;
  contentType?: string;
  contentMD5?: string;
  createdAt?: Date;
  lastModified?: Date;
  /** Object metadata as configured by `indexBackupMetadata` or upload opts. */
  metadata?: Record<string, string>;
}

export interface ListResult {
  objects: StorageObjectMetadata[];
  /** True if more pages exist beyond what was returned. */
  hasMore: boolean;
  /** Provider-specific cursor for the next page, if applicable. */
  nextCursor?: string;
}

// ====================
// Upload + download
// ====================

export interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface UploadResult {
  /** The provider's authoritative URL for the new object, if it has one. */
  objectUrl?: string;
  size: number;
  etag?: string;
}

/**
 * A streaming download result. The `stream` is a Node `Readable` (typed loosely
 * here so this types package stays free of Node-specific dependencies).
 */
export interface DownloadStream {
  stream: unknown;
  contentLength: number;
  contentType?: string;
  fileName: string;
}

/**
 * Time-limited download credential. Azure returns a SAS URL the caller can
 * 302 the user to; Drive returns `undefined` for `redirectUrl` so the caller
 * streams via `getDownloadStream`.
 */
export interface DownloadHandle {
  redirectUrl?: string;
  expiresAt?: Date;
}

/**
 * Per-provider payload that a sidecar (e.g. `pg-az-backup`) needs to upload
 * directly to the backend. The `kind` discriminator tells the sidecar which
 * upload protocol to drive.
 */
export interface AzureSasUploadPayload {
  /** Full Azure Blob SAS URL with write permission. */
  sasUrl: string;
  /** Original location and object name for logging. */
  containerName: string;
  blobName: string;
}

export interface GoogleDriveUploadPayload {
  accessToken: string;
  folderId: string;
  fileName: string;
}

export interface UploadHandle {
  kind: "azure-sas-url" | "google-drive-token";
  payload: AzureSasUploadPayload | GoogleDriveUploadPayload;
  expiresAt: Date;
}

// ====================
// Retention
// ====================

export interface RetentionPolicy {
  retentionDays: number;
  /**
   * Optional prefix filter. When set, only objects whose names start with
   * this prefix are eligible for deletion.
   */
  pathPrefix?: string;
  /**
   * Optional secondary scope used by postgres-backup retention to limit a
   * sweep to a single database directory.
   */
  databaseName?: string;
}

export interface RetentionEnforcementResult {
  deletedFiles: string[];
  deletedCount: number;
  totalSizeFreed: number;
  errors: string[];
}

// ====================
// Provider metadata
// ====================

export interface ProviderMetadata {
  /** Display label for the active account (e.g. Azure storage account name). */
  accountLabel: string;
  [key: string]: unknown;
}

// ====================
// Backend interface
// ====================

export interface StorageBackend {
  readonly providerId: StorageProviderId;

  /** Validate stored config (or `settings` override). Records connectivity. */
  validate(settings?: Record<string, string>): Promise<ValidationResult>;

  /** Latest cached health for the active provider. */
  getHealthStatus(): Promise<ServiceHealthStatus>;

  /** Lightweight metadata about the configured account. */
  getProviderMetadata(): Promise<ProviderMetadata>;

  /** List the locations (containers / folders) the operator can pick from. */
  listLocations(opts?: {
    search?: string;
    limit?: number;
  }): Promise<LocationInfo[]>;

  /** Verify the caller's credentials can access a specific location. */
  testLocationAccess(ref: StorageLocationRef): Promise<LocationInfo>;

  /** Enumerate objects within a location, optionally prefix-filtered. */
  list(
    ref: StorageLocationRef,
    opts?: { prefix?: string; limit?: number },
  ): Promise<ListResult>;

  /** Cheap existence + metadata fetch. Returns null if the object is gone. */
  head(
    ref: StorageLocationRef,
    name: string,
  ): Promise<StorageObjectMetadata | null>;

  /**
   * Buffered or streamed upload from the server itself. `body` is typed as
   * `unknown` to keep this types package node-free; concrete backends accept
   * `Buffer | NodeJS.ReadableStream` and document that contract.
   */
  upload(
    ref: StorageLocationRef,
    name: string,
    body: unknown,
    size: number,
    opts?: UploadOptions,
  ): Promise<UploadResult>;

  /** Open a streaming download (the server proxies bytes to the caller). */
  getDownloadStream(
    ref: StorageLocationRef,
    name: string,
  ): Promise<DownloadStream>;

  /**
   * Optional: mint a time-limited URL the client can fetch directly.
   * Drive doesn't support this, so callers must always tolerate `undefined`.
   */
  getDownloadHandle?(
    ref: StorageLocationRef,
    name: string,
    ttlMinutes: number,
  ): Promise<DownloadHandle>;

  /**
   * Mint a credential bundle a sidecar container can use to upload directly.
   * Required: every provider must support the pg-az-backup sidecar flow.
   */
  mintUploadHandle(
    ref: StorageLocationRef,
    name: string,
    ttlMinutes: number,
  ): Promise<UploadHandle>;

  /** Permanent (or soft-) delete; idempotent. */
  delete(ref: StorageLocationRef, name: string): Promise<void>;

  /** Apply a retention sweep — Azure does it server-side, Drive client-side. */
  enforceRetention(
    ref: StorageLocationRef,
    policy: RetentionPolicy,
  ): Promise<RetentionEnforcementResult>;

  /** Optional: index/tag a stored object's metadata after upload. */
  indexBackupMetadata?(
    ref: StorageLocationRef,
    name: string,
    metadata: Record<string, string>,
  ): Promise<void>;
}
