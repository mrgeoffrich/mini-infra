/**
 * "Load from Backup" onboarding restore — request/response shapes for the
 * public, setup-scoped restore flow (`/auth/setup/restore/*`). These run
 * before an admin account exists, so they intentionally live outside the
 * permission-gated storage API.
 */

import type { StorageProviderId } from "./storage";

/** Reported by GET /auth/setup/restore/status so the wizard can resume. */
export interface SetupRestoreStatus {
  /** Always true when reachable (the route 403s otherwise). */
  setupInProgress: boolean;
  /** Azure connection string has been entered + validated this session. */
  azureConfigured: boolean;
  /** Google Drive OAuth tokens have been stored (post-redirect). */
  googleDriveConnected: boolean;
}

/** A selectable storage location (Azure container / Drive folder). */
export interface SetupRestoreLocation {
  id: string;
  displayName: string;
}

export interface SetupRestoreLocationsResponse {
  locations: SetupRestoreLocation[];
}

/** A restorable self-backup artifact found in a location. */
export interface SetupRestoreBackupItem {
  /** Provider object name, e.g. `mini-infra-2026-07-07T00-00-00.db.zip`. */
  objectName: string;
  sizeBytes: number;
  /** ISO timestamp, or null when the provider doesn't report one. */
  lastModified: string | null;
}

export interface SetupRestoreBackupsRequest {
  providerId: StorageProviderId;
  locationId: string;
}

export interface SetupRestoreBackupsResponse {
  backups: SetupRestoreBackupItem[];
}

export interface SetupRestoreExecuteRequest {
  providerId: StorageProviderId;
  locationId: string;
  objectName: string;
}

export interface SetupRestoreExecuteResponse {
  /** The backup was staged and a restart has been scheduled. */
  staged: boolean;
  sizeBytes: number;
}
