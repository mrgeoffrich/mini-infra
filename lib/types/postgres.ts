// ====================
// PostgreSQL Management Types
// ====================

// Database PostgresDatabase type (matches Prisma schema)
export interface PostgresDatabase {
  id: string;
  name: string;
  connectionString: string; // Encrypted
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: string;
  tags: string; // JSON array
  createdAt: Date;
  updatedAt: Date;
  lastHealthCheck: Date | null;
  healthStatus: string;
  userId: string;
}

// PostgresDatabase for API responses (frontend-friendly with date strings)
export interface PostgresDatabaseInfo {
  id: string;
  name: string;
  connectionString: string; // Encrypted - never exposed in API responses
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastHealthCheck: string | null;
  healthStatus: DatabaseHealthStatus;
  userId: string;
}

// ====================
// Database Health Status
// ====================

export type DatabaseHealthStatus = "healthy" | "unhealthy" | "unknown";

export type PostgreSSLMode = "require" | "disable" | "prefer";

// ====================
// API Request Types
// ====================

export interface CreatePostgresDatabaseRequest {
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string; // Will be encrypted and stored in connectionString
  sslMode: PostgreSSLMode;
  tags?: string[];
}

export interface UpdatePostgresDatabaseRequest {
  name?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string; // Will be encrypted and stored in connectionString
  sslMode?: PostgreSSLMode;
  tags?: string[];
}

export interface TestDatabaseConnectionRequest {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: PostgreSSLMode;
}

// ====================
// API Response Types
// ====================

export interface PostgresDatabaseResponse {
  success: boolean;
  data: PostgresDatabaseInfo;
  message?: string;
}

export interface PostgresDatabaseListResponse {
  success: boolean;
  data: PostgresDatabaseInfo[];
  message?: string;
  pagination?: {
    page: number;
    limit: number;
    totalCount: number;
    hasMore: boolean;
  };
}

export interface PostgresDatabaseDeleteResponse {
  success: boolean;
  message: string;
  timestamp: string;
  requestId?: string;
}

export interface DatabaseConnectionTestResponse {
  success: boolean;
  data: {
    isConnected: boolean;
    responseTimeMs: number;
    error?: string;
    errorCode?: string;
    serverVersion?: string;
    databaseName?: string;
    testedAt: string;
  };
  message: string;
  timestamp: string;
  requestId?: string;
}

// ====================
// Database Configuration Filter Types
// ====================

export interface PostgresDatabaseFilter {
  name?: string;
  host?: string;
  healthStatus?: DatabaseHealthStatus;
  tags?: string[];
}

export interface PostgresDatabaseSortOptions {
  field: keyof PostgresDatabaseInfo;
  order: "asc" | "desc";
}

// ====================
// Database Configuration Service Types
// ====================

export interface DatabaseConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: PostgreSSLMode;
}

export interface DatabaseValidationResult {
  isValid: boolean;
  message: string;
  errorCode?: string;
  responseTimeMs?: number;
  serverVersion?: string;
  databaseName?: string;
  metadata?: Record<string, any>;
}

export interface DatabaseHealthCheckResult {
  databaseId: string;
  healthStatus: DatabaseHealthStatus;
  lastChecked: Date;
  responseTime?: number;
  errorMessage?: string;
  errorCode?: string;
  serverVersion?: string;
  metadata?: Record<string, any>;
}

// ====================
// Error Types
// ====================

export interface PostgresApiError {
  error: string;
  message: string;
  details?: any;
  timestamp: string;
  requestId?: string;
}

// ====================
// Backup Configuration Types
// ====================

export interface BackupConfiguration {
  id: string;
  databaseId: string;
  schedule: string | null; // Cron expression
  azureContainerName: string;
  azurePathPrefix: string;
  retentionDays: number;
  backupFormat: BackupFormat;
  compressionLevel: number;
  isEnabled: boolean;
  lastBackupAt: Date | null;
  nextScheduledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BackupConfigurationInfo {
  id: string;
  databaseId: string;
  schedule: string | null; // Cron expression
  azureContainerName: string;
  azurePathPrefix: string;
  retentionDays: number;
  backupFormat: BackupFormat;
  compressionLevel: number;
  isEnabled: boolean;
  lastBackupAt: string | null;
  nextScheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BackupFormat = "custom" | "plain" | "tar";

// ====================
// Backup Operation Types
// ====================

export interface BackupOperation {
  id: string;
  databaseId: string;
  operationType: BackupOperationType;
  status: BackupOperationStatus;
  startedAt: Date;
  completedAt: Date | null;
  sizeBytes: bigint | null;
  azureBlobUrl: string | null;
  errorMessage: string | null;
  progress: number;
  metadata: string | null; // JSON
}

export interface BackupOperationInfo {
  id: string;
  databaseId: string;
  operationType: BackupOperationType;
  status: BackupOperationStatus;
  startedAt: string;
  completedAt: string | null;
  sizeBytes: number | null;
  azureBlobUrl: string | null;
  errorMessage: string | null;
  progress: number;
  metadata: Record<string, any> | null;
}

export type BackupOperationType = "manual" | "scheduled";

export type BackupOperationStatus = "pending" | "running" | "completed" | "failed";

// ====================
// Restore Operation Types
// ====================

export interface RestoreOperation {
  id: string;
  databaseId: string;
  backupUrl: string;
  status: RestoreOperationStatus;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  progress: number;
}

export interface RestoreOperationInfo {
  id: string;
  databaseId: string;
  backupUrl: string;
  status: RestoreOperationStatus;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  progress: number;
}

export type RestoreOperationStatus = "pending" | "running" | "completed" | "failed";

// ====================
// Backup Configuration API Request Types
// ====================

export interface CreateBackupConfigurationRequest {
  databaseId: string;
  schedule?: string; // Cron expression
  azureContainerName: string;
  azurePathPrefix?: string;
  retentionDays?: number;
  backupFormat?: BackupFormat;
  compressionLevel?: number;
  isEnabled?: boolean;
}

export interface UpdateBackupConfigurationRequest {
  schedule?: string | null; // Cron expression
  azureContainerName?: string;
  azurePathPrefix?: string;
  retentionDays?: number;
  backupFormat?: BackupFormat;
  compressionLevel?: number;
  isEnabled?: boolean;
}

// ====================
// Backup Configuration API Response Types
// ====================

export interface BackupConfigurationResponse {
  success: boolean;
  data: BackupConfigurationInfo;
  message?: string;
  timestamp: string;
  requestId?: string;
}

export interface BackupConfigurationDeleteResponse {
  success: boolean;
  message: string;
  timestamp: string;
  requestId?: string;
}

// ====================
// Backup Configuration Service Types
// ====================

export interface BackupScheduleValidationResult {
  isValid: boolean;
  message: string;
  nextScheduledAt?: Date;
}

export interface BackupConfigurationServiceResult<T = BackupConfigurationInfo> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}