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
      throw new Error("Empty container or blob path component");
    }
    return { containerName, blobName };
  } catch {
    // Path-only fallback — no scheme, no `?` query, just `<location>/<object>`.
    const trimmed = backupUrl.replace(/^\/+/, "").split("?")[0];
    const parts = trimmed.split("/");
    const containerName = parts[0];
    const blobName = parts.slice(1).join("/");
    if (!containerName || !blobName) {
      throw new Error(`Invalid backup URL format: ${backupUrl}`);
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
 * Extract storage account name from connection string
 */
export function getStorageAccountFromConnectionString(
  connectionString: string,
): string {
  try {
    const accountNameMatch = connectionString.match(/AccountName=([^;]+)/);
    if (accountNameMatch) {
      return accountNameMatch[1];
    }
    throw new Error("AccountName not found in connection string");
  } catch (error) {
    throw new Error("Failed to parse Azure storage account name", {
      cause: error,
    });
  }
}
