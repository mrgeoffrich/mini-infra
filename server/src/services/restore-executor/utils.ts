import { InternalError } from "../../lib/errors";

/**
 * Parse a `storageObjectUrl` into its location id (Azure container / Drive
 * folder id) and object name (Azure blob name / Drive file name).
 *
 * Two shapes are supported:
 *   1. Full URL — Azure today: `https://acct.blob.core.windows.net/<container>/<blob>?...`.
 *      The first path segment is the container; everything after is the blob.
 *   2. Path-only — Drive (and rollback URLs that fall back to a raw locator):
 *      `<locationId>/<objectName>`. No scheme, no host. Used because Drive
 *      has no public URL we can hand a downloader.
 *
 * Every reachable caller (the restore HTTP route's Zod `refine`, the
 * restore-executor JobPool runtime env resolver) validates the URL shape
 * with the exact same two-shape rule *before* handing it to this parser —
 * see `validateBackupUrlForRestore()` in `routes/postgres-restore.ts`. A
 * parse failure here therefore means the two validators disagree, a genuine
 * internal invariant rather than a user-supplied bad URL.
 */
export function parseBackupUrl(backupUrl: string): {
  containerName: string;
  blobName: string;
} {
  // Try full URL first; fall back to path-only.
  try {
    const url = new URL(backupUrl);
    const pathParts = url.pathname.substring(1).split("/"); // Remove leading slash
    const containerName = pathParts[0];
    const blobName = pathParts.slice(1).join("/");
    if (!containerName || !blobName) {
      throw new InternalError("Empty container or blob path component");
    }
    return { containerName, blobName };
  } catch {
    // Path-only fallback — no scheme, no `?` query, just `<location>/<object>`.
    const trimmed = backupUrl.replace(/^\/+/, "").split("?")[0];
    const parts = trimmed.split("/");
    const containerName = parts[0];
    const blobName = parts.slice(1).join("/");
    if (!containerName || !blobName) {
      throw new InternalError(`Invalid backup URL format: ${backupUrl}`);
    }
    return { containerName, blobName };
  }
}

/**
 * Extract container name from backup URL
 */
export function extractContainerFromUrl(backupUrl: string): string {
  const { containerName } = parseBackupUrl(backupUrl);
  return containerName;
}

/**
 * Extract blob name from backup URL
 */
export function extractBlobNameFromUrl(backupUrl: string): string {
  const { blobName } = parseBackupUrl(backupUrl);
  return blobName;
}

/**
 * Extract storage account name from connection string. Parses our own
 * previously-validated `AzureStorageService` connection string (format
 * enforced at `setConnectionString()` time) — a failure here is an internal
 * invariant, not a user input problem.
 */
export function getStorageAccountFromConnectionString(
  connectionString: string,
): string {
  const accountNameMatch = connectionString.match(/AccountName=([^;]+)/);
  if (!accountNameMatch) {
    throw new InternalError("AccountName not found in connection string");
  }
  return accountNameMatch[1];
}
