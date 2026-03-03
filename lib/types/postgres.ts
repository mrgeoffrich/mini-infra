// ====================
// PostgreSQL Server Management Types
// ====================

import type { ContainerStatus } from "./containers";

// PostgreSQL Server type (matches Prisma schema)
export interface PostgresServer {
  id: string;
  name: string;
  host: string;
  port: number;
  adminUsername: string;
  connectionString: string; // Encrypted
  sslMode: string;
  tags: string | null; // JSON array
  healthStatus: string;
  lastHealthCheck: Date | null;
  serverVersion: string | null;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
}

// PostgreSQL Server for API responses (frontend-friendly with date strings)
export interface PostgresServerInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  adminUsername: string;
  sslMode: string;
  tags: string[];
  healthStatus: "healthy" | "unhealthy" | "unknown";
  lastHealthCheck: string | null;
  serverVersion: string | null;
  linkedContainerId: string | null;
  linkedContainerName: string | null;
  linkedContainerInfo?: LinkedContainerInfo; // Fetched from Docker API
  createdAt: string;
  updatedAt: string;
  _count?: {
    databases: number;
    users: number;
  };
}

// Container information for linked containers
export interface LinkedContainerInfo {
  id: string;
  name: string;
  state: ContainerStatus; // From containers.ts
  status: string; // Full status message
  image: string;
  created: string;
}

// PostgreSQL Server API Request Types
export interface CreatePostgresServerRequest {
  name: string;
  host: string;
  port: number;
  adminUsername: string;
  adminPassword: string; // Will be encrypted and stored in connectionString
  sslMode: "prefer" | "require" | "disable";
  tags?: string[];
  linkedContainerId?: string;
  linkedContainerName?: string;
}

export interface UpdatePostgresServerRequest {
  name?: string;
  host?: string;
  port?: number;
  adminUsername?: string;
  adminPassword?: string; // Will be encrypted and stored in connectionString
  sslMode?: "prefer" | "require" | "disable";
  tags?: string[];
  linkedContainerId?: string | null;
  linkedContainerName?: string | null;
}

export interface TestServerConnectionRequest {
  host: string;
  port: number;
  username: string;
  password: string;
  sslMode: "prefer" | "require" | "disable";
}

// PostgreSQL Server API Response Types
export interface PostgresServerSyncResults {
  databasesSync: {
    success: boolean;
    count: number;
    error?: string;
  };
  usersSync: {
    success: boolean;
    count: number;
    error?: string;
  };
}

export interface PostgresServerResponse {
  success: boolean;
  data: PostgresServerInfo;
  message?: string;
}

export interface PostgresServerCreateResponse {
  success: boolean;
  data: {
    server: PostgresServerInfo;
    syncResults: PostgresServerSyncResults;
  };
  message?: string;
}

export interface PostgresServerListResponse {
  success: boolean;
  data: PostgresServerInfo[];
  message?: string;
}

export interface PostgresServerDeleteResponse {
  success: boolean;
  message: string;
}

export interface ServerConnectionTestResponse {
  success: boolean;
  message?: string;
  version?: string;
  error?: string;
}

// ====================
// PostgreSQL Database Management Types
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

export interface DiscoverDatabasesRequest {
  host: string;
  port: number;
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

export interface DatabaseInfo {
  name: string;
  isTemplate?: boolean;
  allowConnections?: boolean;
  encoding?: string;
  collation?: string;
  characterClassification?: string;
  sizePretty?: string;
  description?: string;
}

export interface DatabaseDiscoveryResponse {
  success: boolean;
  data: {
    databases: DatabaseInfo[];
    serverVersion?: string;
    responseTimeMs: number;
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
  timezone: string;
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
  timezone: string;
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
  timezone?: string;
  azureContainerName: string;
  azurePathPrefix?: string;
  retentionDays?: number;
  backupFormat?: BackupFormat;
  compressionLevel?: number;
  isEnabled?: boolean;
}

export interface UpdateBackupConfigurationRequest {
  schedule?: string | null; // Cron expression
  timezone?: string;
  azureContainerName?: string;
  azurePathPrefix?: string;
  retentionDays?: number;
  backupFormat?: BackupFormat;
  compressionLevel?: number;
  isEnabled?: boolean;
}

export interface QuickBackupSetupRequest {
  serverId: string;
  databaseName: string;
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

// ====================
// Backup Operations API Request Types
// ====================

export interface CreateManualBackupRequest {
  databaseId: string;
}

export interface BackupOperationFilter {
  status?: BackupOperationStatus;
  operationType?: BackupOperationType;
  startedAfter?: string; // ISO date string
  startedBefore?: string; // ISO date string
}

export interface BackupOperationSortOptions {
  field: keyof BackupOperationInfo;
  order: "asc" | "desc";
}

// ====================
// Backup Operations API Response Types
// ====================

export interface BackupOperationResponse {
  success: boolean;
  data: BackupOperationInfo;
  message?: string;
  timestamp: string;
  requestId?: string;
}

export interface BackupOperationListResponse {
  success: boolean;
  data: BackupOperationInfo[];
  message?: string;
  timestamp: string;
  requestId?: string;
  pagination?: {
    page: number;
    limit: number;
    totalCount: number;
    hasMore: boolean;
  };
}

export interface BackupOperationStatusResponse {
  success: boolean;
  data: {
    id: string;
    status: BackupOperationStatus;
    progress: number;
    startedAt: string;
    completedAt: string | null;
    errorMessage: string | null;
    sizeBytes: number | null;
    azureBlobUrl: string | null;
    metadata: Record<string, any> | null;
  };
  message?: string;
  timestamp: string;
  requestId?: string;
}

export interface BackupOperationDeleteResponse {
  success: boolean;
  message: string;
  timestamp: string;
  requestId?: string;
}

export interface ManualBackupResponse {
  success: boolean;
  data: {
    operationId: string;
    status: BackupOperationStatus;
    message: string;
  };
  timestamp: string;
  requestId?: string;
}

// ====================
// Progress Tracking Types
// ====================

export interface BackupProgressUpdate {
  operationId: string;
  progress: number;
  status: BackupOperationStatus;
  message?: string;
  timestamp: string;
}

export interface BackupOperationProgress {
  id: string;
  databaseId: string;
  status: BackupOperationStatus;
  progress: number;
  startedAt: string;
  estimatedCompletion?: string;
  currentStep?: string;
  totalSteps?: number;
  completedSteps?: number;
  errorMessage?: string;
  metadata?: Record<string, any>;
}

// ====================
// Restore Operations API Request Types
// ====================

export interface CreateRestoreOperationRequest {
  databaseId: string;
  backupUrl: string;
  confirmRestore?: boolean; // For confirmation workflow
  restoreToNewDatabase?: boolean; // If true, create a new database for restoration
  newDatabaseName?: string; // Required if restoreToNewDatabase is true
}

export interface RestoreOperationFilter {
  status?: RestoreOperationStatus;
  startedAfter?: string; // ISO date string
  startedBefore?: string; // ISO date string
}

export interface RestoreOperationSortOptions {
  field: keyof RestoreOperationInfo;
  order: "asc" | "desc";
}

export interface BackupBrowserFilter {
  createdAfter?: string; // ISO date string
  createdBefore?: string; // ISO date string
  sizeMin?: number; // Minimum size in bytes
  sizeMax?: number; // Maximum size in bytes
}

export interface BackupBrowserSortOptions {
  field: "createdAt" | "sizeBytes" | "name";
  order: "asc" | "desc";
}

// ====================
// Restore Operations API Response Types
// ====================

export interface RestoreOperationResponse {
  success: boolean;
  data: RestoreOperationInfo;
  message?: string;
  timestamp: string;
  requestId?: string;
}

export interface RestoreOperationListResponse {
  success: boolean;
  data: RestoreOperationInfo[];
  message?: string;
  timestamp: string;
  requestId?: string;
  pagination?: {
    page: number;
    limit: number;
    totalCount: number;
    hasMore: boolean;
  };
}

export interface RestoreOperationStatusResponse {
  success: boolean;
  data: {
    id: string;
    status: RestoreOperationStatus;
    progress: number;
    startedAt: string;
    completedAt: string | null;
    errorMessage: string | null;
    backupUrl: string;
    databaseName: string;
    currentStep?: string;
    totalSteps?: number;
    completedSteps?: number;
  };
  message?: string;
  timestamp: string;
  requestId?: string;
}

export interface CreateRestoreOperationResponse {
  success: boolean;
  data: {
    operationId: string;
    status: RestoreOperationStatus;
    message: string;
    backupUrl: string;
    databaseName: string;
  };
  timestamp: string;
  requestId?: string;
}

export interface BackupBrowserItem {
  name: string;
  url: string;
  sizeBytes: number;
  createdAt: string;
  lastModified: string;
  metadata?: {
    databaseName?: string;
    backupFormat?: BackupFormat;
    compressionLevel?: number;
    pgVersion?: string;
    [key: string]: any;
  };
}

export interface BackupBrowserResponse {
  success: boolean;
  data: BackupBrowserItem[];
  message?: string;
  timestamp: string;
  requestId?: string;
  pagination?: {
    page: number;
    limit: number;
    totalCount: number;
    hasMore: boolean;
  };
}

// ====================
// Restore Progress Tracking Types
// ====================

export interface RestoreProgressUpdate {
  operationId: string;
  progress: number;
  status: RestoreOperationStatus;
  message?: string;
  timestamp: string;
}

export interface RestoreOperationProgress {
  id: string;
  databaseId: string;
  status: RestoreOperationStatus;
  progress: number;
  startedAt: string;
  estimatedCompletion?: string;
  currentStep?: string;
  totalSteps?: number;
  completedSteps?: number;
  errorMessage?: string;
  backupUrl: string;
  metadata?: Record<string, any>;
}

// ====================
// Operation History Types
// ====================

export interface OperationHistoryItem {
  id: string;
  type: "backup" | "restore";
  databaseId: string;
  databaseName?: string;
  status: BackupOperationStatus | RestoreOperationStatus;
  progress: number;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  operationType?: string; // For backup operations: "manual" | "scheduled"
  backupUrl?: string; // For restore operations
  sizeBytes?: number | null; // For backup operations
}

// ====================
// PostgreSQL Server Management - Managed Databases
// ====================

// ManagedDatabase type (matches Prisma schema)
export interface ManagedDatabase {
  id: string;
  serverId: string;
  databaseName: string;
  owner: string;
  encoding: string;
  collation: string | null;
  template: string;
  sizeBytes: bigint | null;
  connectionLimit: number;
  createdAt: Date;
  updatedAt: Date;
  lastSyncedAt: Date | null;
}

// ManagedDatabase for API responses (frontend-friendly with date strings)
export interface ManagedDatabaseInfo {
  id: string;
  serverId: string;
  databaseName: string;
  owner: string;
  encoding: string;
  collation: string | null;
  template: string;
  sizeBytes: number | null;
  connectionLimit: number;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
  _count?: {
    grants: number;
  };
}

// Managed Database API Request Types
export interface CreateManagedDatabaseRequest {
  databaseName: string;
  owner?: string;
  encoding?: string;
  template?: string;
  connectionLimit?: number;
}

export interface UpdateManagedDatabaseRequest {
  databaseName?: string;
  owner?: string;
  connectionLimit?: number;
}

export interface ChangeDatabaseOwnerRequest {
  newOwner: string;
}

// Managed Database API Response Types
export interface ManagedDatabaseResponse {
  success: boolean;
  data: ManagedDatabaseInfo;
  message?: string;
}

export interface ManagedDatabaseListResponse {
  success: boolean;
  data: ManagedDatabaseInfo[];
  message?: string;
}

export interface ManagedDatabaseDeleteResponse {
  success: boolean;
  message: string;
}

export interface SyncDatabasesResponse {
  success: boolean;
  message: string;
  data: {
    synced: number;
    created: number;
    updated: number;
    failed: number;
  };
}

// ====================
// PostgreSQL Server Management - Managed Database Users
// ====================

// ManagedDatabaseUser type (matches Prisma schema)
export interface ManagedDatabaseUser {
  id: string;
  serverId: string;
  username: string;
  canLogin: boolean;
  isSuperuser: boolean;
  connectionLimit: number;
  passwordHash: string | null;
  passwordSetAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastSyncedAt: Date | null;
}

// ManagedDatabaseUser for API responses (frontend-friendly with date strings)
export interface ManagedDatabaseUserInfo {
  id: string;
  serverId: string;
  username: string;
  canLogin: boolean;
  isSuperuser: boolean;
  connectionLimit: number;
  passwordSetAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
  _count?: {
    grants: number;
  };
}

// Managed Database User API Request Types
export interface CreateManagedDatabaseUserRequest {
  username: string;
  password: string;
  canLogin?: boolean;
  isSuperuser?: boolean;
  connectionLimit?: number;
}

export interface UpdateManagedDatabaseUserRequest {
  canLogin?: boolean;
  isSuperuser?: boolean;
  connectionLimit?: number;
}

export interface ChangeUserPasswordRequest {
  password: string;
}

// Managed Database User API Response Types
export interface ManagedDatabaseUserResponse {
  success: boolean;
  data: ManagedDatabaseUserInfo;
  message?: string;
}

export interface ManagedDatabaseUserListResponse {
  success: boolean;
  data: ManagedDatabaseUserInfo[];
  message?: string;
}

export interface ManagedDatabaseUserDeleteResponse {
  success: boolean;
  message: string;
}

export interface SyncUsersResponse {
  success: boolean;
  message: string;
  data: {
    synced: number;
    created: number;
    updated: number;
    failed: number;
  };
}

// ====================
// PostgreSQL Server Management - Database Grants
// ====================

// DatabaseGrant type (matches Prisma schema)
export interface DatabaseGrant {
  id: string;
  databaseId: string;
  userId: string;
  canConnect: boolean;
  canCreate: boolean;
  canTemp: boolean;
  canCreateSchema: boolean;
  canUsageSchema: boolean;
  canSelect: boolean;
  canInsert: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// DatabaseGrant for API responses (frontend-friendly with date strings)
export interface DatabaseGrantInfo {
  id: string;
  databaseId: string;
  userId: string;
  canConnect: boolean;
  canCreate: boolean;
  canTemp: boolean;
  canCreateSchema: boolean;
  canUsageSchema: boolean;
  canSelect: boolean;
  canInsert: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  createdAt: string;
  updatedAt: string;
  database?: ManagedDatabaseInfo;
  user?: ManagedDatabaseUserInfo;
}

// Database Grant API Request Types
export interface CreateDatabaseGrantRequest {
  serverId: string;
  databaseId: string;
  managedUserId: string;
  canConnect?: boolean;
  canCreate?: boolean;
  canTemp?: boolean;
  canCreateSchema?: boolean;
  canUsageSchema?: boolean;
  canSelect?: boolean;
  canInsert?: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;
}

export interface UpdateDatabaseGrantRequest {
  canConnect?: boolean;
  canCreate?: boolean;
  canTemp?: boolean;
  canCreateSchema?: boolean;
  canUsageSchema?: boolean;
  canSelect?: boolean;
  canInsert?: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;
}

// Database Grant API Response Types
export interface DatabaseGrantResponse {
  success: boolean;
  data: DatabaseGrantInfo;
  message?: string;
}

export interface DatabaseGrantListResponse {
  success: boolean;
  data: DatabaseGrantInfo[];
  message?: string;
}

export interface DatabaseGrantDeleteResponse {
  success: boolean;
  message: string;
}

// Quick Setup API Types
export interface QuickSetupRequest {
  serverId: string;
  databaseName: string;
  username: string;
  password: string;
}

export interface QuickSetupResponse {
  success: boolean;
  message: string;
  data: {
    database: ManagedDatabaseInfo;
    user: ManagedDatabaseUserInfo;
    grant: DatabaseGrantInfo;
    connectionString: string;
  };
}

// ====================
// Database Table Data Types
// ====================

// Table metadata (from information_schema and pg_catalog)
export interface DatabaseTableInfo {
  name: string;
  schema: string;
  rowCount: number | null;
  sizeBytes: number | null;
  tableType: "BASE TABLE" | "VIEW" | "MATERIALIZED VIEW" | "FOREIGN TABLE";
  lastModified: string | null;
}

// Column metadata for a table
export interface TableColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  ordinalPosition: number;
  maxLength: number | null;
}

// Table data request parameters
export interface TableDataRequest {
  page?: number;
  pageSize?: number;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
  filters?: TableDataFilter[];
}

// Filter for table data
export interface TableDataFilter {
  column: string;
  operator: "=" | "!=" | ">" | "<" | ">=" | "<=" | "LIKE" | "ILIKE" | "IS NULL" | "IS NOT NULL";
  value?: string | number | boolean | null;
}

// Table data response (paginated)
export interface TableDataResponse {
  success: boolean;
  data: {
    columns: TableColumnInfo[];
    rows: Record<string, any>[];
    totalRows: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
  message?: string;
}

// Table list response
export interface DatabaseTableListResponse {
  success: boolean;
  data: DatabaseTableInfo[];
  message?: string;
}