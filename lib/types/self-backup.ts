/**
 * Self-backup database model
 */
export interface SelfBackup {
  id: string;
  startedAt: Date;
  completedAt: Date | null;
  status: 'in_progress' | 'completed' | 'failed';
  filePath: string | null;
  azureBlobUrl: string | null;
  azureContainerName: string;
  fileName: string;
  fileSize: number | null;
  errorMessage: string | null;
  errorCode: string | null;
  triggeredBy: 'scheduled' | 'manual';
  userId: string | null;
  durationMs: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * API response type (dates as strings)
 */
export interface SelfBackupInfo {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: 'in_progress' | 'completed' | 'failed';
  filePath: string | null;
  azureBlobUrl: string | null;
  azureContainerName: string;
  fileName: string;
  fileSize: number | null;
  errorMessage: string | null;
  errorCode: string | null;
  triggeredBy: 'scheduled' | 'manual';
  userId: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Self-backup configuration
 */
export interface SelfBackupConfig {
  cronSchedule: string;
  azureContainerName: string;
  timezone: string;
  enabled: boolean;
}

/**
 * Schedule information
 */
export interface ScheduleInfo {
  isEnabled: boolean;
  schedule: string;
  timezone: string;
  containerName: string;
  nextScheduledAt: string | null;
  isRegistered: boolean;
}

/**
 * Backup health status
 */
export interface BackupHealthStatus {
  status: 'healthy' | 'warning' | 'error' | 'not_configured';
  lastBackupAt: string | null;
  lastSuccessfulBackupAt: string | null;
  failureCount24h: number;
  message: string;
}

/**
 * Request types
 */
export interface UpdateSelfBackupConfigRequest {
  cronSchedule: string;
  azureContainerName: string;
  timezone: string;
}

/**
 * Response types
 */
export interface SelfBackupConfigResponse {
  success: boolean;
  config: SelfBackupConfig | null;
  scheduleInfo: ScheduleInfo | null;
}

export interface TriggerBackupResponse {
  success: boolean;
  backup?: SelfBackupInfo;
  error?: string;
}

export interface BackupHistoryResponse {
  success: boolean;
  backups: SelfBackupInfo[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface BackupHealthResponse {
  success: boolean;
  health: BackupHealthStatus;
}
