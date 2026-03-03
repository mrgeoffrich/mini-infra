/**
 * Parse backup URL to extract container name and blob name
 */
export function parseBackupUrl(backupUrl: string): {
  containerName: string;
  blobName: string;
} {
  try {
    const url = new URL(backupUrl);
    const pathParts = url.pathname.substring(1).split("/"); // Remove leading slash
    const containerName = pathParts[0];
    const blobName = pathParts.slice(1).join("/");

    return { containerName, blobName };
  } catch (error) {
    throw new Error(`Invalid backup URL format: ${backupUrl}`);
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
    throw new Error("Failed to parse Azure storage account name");
  }
}
