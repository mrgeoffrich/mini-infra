const DEFAULT_BACKUP_IMAGE = "ghcr.io/mrgeoffrich/mini-infra-pg-backup:dev";

/**
 * Get the Docker image for PostgreSQL backup/restore operations.
 * Resolved from PG_BACKUP_IMAGE_TAG env var (baked in at Docker build time),
 * falling back to the hardcoded default.
 */
export function getPgBackupImage(): string {
  return process.env.PG_BACKUP_IMAGE_TAG || DEFAULT_BACKUP_IMAGE;
}
