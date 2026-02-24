import { RestoreOperationStatus } from "@mini-infra/types";

/**
 * Job data structure for restore operations
 */
export interface RestoreJobData {
  restoreOperationId: string;
  databaseId: string;
  backupUrl: string;
  userId: string;
}

/**
 * Progress update data for restore operations
 */
export interface RestoreProgressData {
  status: RestoreOperationStatus;
  progress: number;
  message?: string;
  errorMessage?: string;
}

/**
 * Backup file validation result
 */
export interface BackupValidationResult {
  isValid: boolean;
  error?: string;
  sizeBytes?: number;
  lastModified?: Date;
  metadata?: Record<string, any>;
}
