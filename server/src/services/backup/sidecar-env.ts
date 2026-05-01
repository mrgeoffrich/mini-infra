/**
 * Helpers that translate provider-agnostic upload/download handles minted by
 * a `StorageBackend` into the environment variables consumed by the
 * `pg-az-backup` sidecar.
 *
 * Why: Phase 1 hardcoded `AZURE_SAS_URL` in three call sites (backup-executor,
 * restore-runner, rollback-manager). Phase 3 introduces a second sidecar
 * protocol — Google Drive resumable upload — and we need to branch in all
 * three call sites without copy-pasting a switch statement.
 *
 * The sidecar reads `STORAGE_PROVIDER` first and dispatches to the right
 * upload/download protocol on its end. The env shape:
 *
 *   STORAGE_PROVIDER = "azure" | "google-drive"
 *
 *   azure:
 *     AZURE_SAS_URL                     — full SAS URL with write/read perms
 *
 *   google-drive (upload):
 *     STORAGE_GDRIVE_ACCESS_TOKEN       — short-lived OAuth access token
 *     STORAGE_GDRIVE_FOLDER_ID          — destination folder id
 *     STORAGE_GDRIVE_FILE_NAME          — filename to write within that folder
 *     STORAGE_GDRIVE_TOKEN_EXPIRES_AT   — ISO timestamp; sidecar bails if the
 *                                          upload runs past this (informational)
 *
 *   google-drive (download):
 *     STORAGE_GDRIVE_ACCESS_TOKEN       — short-lived OAuth access token
 *     STORAGE_GDRIVE_FILE_ID            — source file id (resolved via
 *                                          `findFileIdByName` server-side)
 *     STORAGE_GDRIVE_FILE_NAME          — display-only, for logging
 *     STORAGE_GDRIVE_TOKEN_EXPIRES_AT   — ISO timestamp
 */

import type {
  StorageBackend,
  StorageLocationRef,
  UploadHandle,
  AzureSasUploadPayload,
  GoogleDriveUploadPayload,
} from "@mini-infra/types";

/**
 * Public env shape consumed by `pg-az-backup`. Fields are optional because
 * the active provider only sets the relevant subset; the sidecar's
 * `run.sh` enforces presence based on `STORAGE_PROVIDER`.
 */
export interface SidecarStorageEnv {
  STORAGE_PROVIDER: "azure" | "google-drive";
  AZURE_SAS_URL?: string;
  STORAGE_GDRIVE_ACCESS_TOKEN?: string;
  STORAGE_GDRIVE_FOLDER_ID?: string;
  STORAGE_GDRIVE_FILE_NAME?: string;
  STORAGE_GDRIVE_FILE_ID?: string;
  STORAGE_GDRIVE_TOKEN_EXPIRES_AT?: string;
}

// Note: a redacted env shares `SidecarStorageEnv`'s type. The redaction is
// purely a runtime concern — `redactSidecarEnv()` swaps secret values for
// `[REDACTED]` strings, then callers feed the result straight into a logger
// where everything is `string | undefined` anyway. Keeping the same type
// avoids the no-op duplicate interface that previously offered no compile-
// time enforcement.

const REDACTED = "[REDACTED]";

export function buildSidecarUploadEnv(handle: UploadHandle): SidecarStorageEnv {
  if (handle.kind === "azure-sas-url") {
    const payload = handle.payload as AzureSasUploadPayload;
    return {
      STORAGE_PROVIDER: "azure",
      AZURE_SAS_URL: payload.sasUrl,
    };
  }
  if (handle.kind === "google-drive-token") {
    const payload = handle.payload as GoogleDriveUploadPayload;
    return {
      STORAGE_PROVIDER: "google-drive",
      STORAGE_GDRIVE_ACCESS_TOKEN: payload.accessToken,
      STORAGE_GDRIVE_FOLDER_ID: payload.folderId,
      STORAGE_GDRIVE_FILE_NAME: payload.fileName,
      STORAGE_GDRIVE_TOKEN_EXPIRES_AT: handle.expiresAt.toISOString(),
    };
  }
  // Exhaustive switch — TypeScript surfaces missing branches.
  const _never: never = handle.kind;
  throw new Error(`Unsupported upload handle kind: ${String(_never)}`);
}

export function redactSidecarEnv(
  env: SidecarStorageEnv,
): SidecarStorageEnv {
  return {
    ...env,
    AZURE_SAS_URL: env.AZURE_SAS_URL ? REDACTED : undefined,
    STORAGE_GDRIVE_ACCESS_TOKEN: env.STORAGE_GDRIVE_ACCESS_TOKEN
      ? REDACTED
      : undefined,
  };
}

/**
 * Build sidecar env for a download. Azure uses a SAS URL via
 * `getDownloadHandle`; Drive resolves the file id server-side and ships an
 * access token + file id to the sidecar.
 *
 * Returns null if the backend cannot produce a download handle (for Azure)
 * AND cannot resolve a file id (for Drive). Callers fall through to
 * server-side streaming.
 */
export async function buildSidecarDownloadEnv(
  backend: StorageBackend,
  ref: StorageLocationRef,
  name: string,
  ttlMinutes: number,
): Promise<SidecarStorageEnv | null> {
  if (backend.providerId === "azure" && backend.getDownloadHandle) {
    const handle = await backend.getDownloadHandle(ref, name, ttlMinutes);
    if (!handle.redirectUrl) return null;
    return {
      STORAGE_PROVIDER: "azure",
      AZURE_SAS_URL: handle.redirectUrl,
    };
  }
  if (backend.providerId === "google-drive") {
    // Drive needs a file id, not a name; the head() lookup resolves it.
    const meta = await backend.head(ref, name);
    if (!meta) return null;
    const fileId =
      typeof meta.metadata?.driveFileId === "string"
        ? meta.metadata.driveFileId
        : null;
    if (!fileId) return null;
    // Mint a token via the same path the upload uses — `mintUploadHandle`
    // returns a token bundle that the sidecar can use for download too.
    const handle = await backend.mintUploadHandle(ref, name, ttlMinutes);
    const payload = handle.payload as GoogleDriveUploadPayload;
    return {
      STORAGE_PROVIDER: "google-drive",
      STORAGE_GDRIVE_ACCESS_TOKEN: payload.accessToken,
      STORAGE_GDRIVE_FOLDER_ID: payload.folderId,
      STORAGE_GDRIVE_FILE_NAME: name,
      STORAGE_GDRIVE_FILE_ID: fileId,
      STORAGE_GDRIVE_TOKEN_EXPIRES_AT: handle.expiresAt.toISOString(),
    };
  }
  return null;
}
