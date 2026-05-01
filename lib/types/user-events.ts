// ====================
// User Event Types
// ====================

// Event type enumeration
export type UserEventType =
  | 'deployment'
  | 'deployment_rollback'
  | 'deployment_uninstall'
  | 'environment_start'
  | 'environment_stop'
  | 'environment_create'
  | 'environment_delete'
  | 'certificate_create'
  | 'certificate_renew'
  | 'certificate_revoke'
  | 'backup'
  | 'backup_cleanup'
  | 'restore'
  | 'container_cleanup'
  | 'database_create'
  | 'database_delete'
  | 'user_create'
  | 'user_delete'
  | 'system_maintenance'
  | 'stack_deploy'
  | 'stack_update'
  | 'stack_destroy'
  | 'vault_kv_write'
  | 'vault_kv_patch'
  | 'vault_kv_delete'
  | 'stack_vault_policy_apply'
  | 'stack_vault_approle_apply'
  | 'stack_vault_kv_apply'
  | 'stack_vault_policy_rollback'
  | 'stack_vault_approle_rollback'
  | 'stack_vault_kv_rollback'
  | 'stack_vault_policy_delete'
  | 'stack_vault_approle_delete'
  | 'stack_vault_kv_delete'
  | 'other';

// Event category enumeration
export type UserEventCategory =
  | 'infrastructure'
  | 'database'
  | 'security'
  | 'maintenance'
  | 'configuration';

// Event status enumeration
export const USER_EVENT_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped'] as const;
export type UserEventStatus = typeof USER_EVENT_STATUSES[number];

// Trigger type enumeration
export type UserEventTriggerType = 'manual' | 'scheduled' | 'webhook' | 'api' | 'system';

// Resource type enumeration
export type UserEventResourceType =
  | 'deployment'
  | 'deployment_config'
  | 'database'
  | 'container'
  | 'certificate'
  | 'environment'
  | 'user'
  | 'backup'
  | 'stack'
  | 'system';

// ====================
// Core UserEvent Types
// ====================

// Database model (matches Prisma schema with Date types)
export interface UserEvent {
  id: string;
  eventType: string; // UserEventType as string for flexibility
  eventCategory: string; // UserEventCategory as string
  eventName: string;
  userId: string | null;
  triggeredBy: string; // UserEventTriggerType as string
  status: string; // UserEventStatus as string
  progress: number; // 0-100
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  resourceId: string | null;
  resourceType: string | null; // UserEventResourceType as string
  resourceName: string | null;
  description: string | null;
  metadata: string | null; // JSON stringified
  resultSummary: string | null;
  errorMessage: string | null;
  errorDetails: string | null; // JSON stringified
  logs: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// API-friendly version with string dates
export interface UserEventInfo {
  id: string;
  eventType: string;
  eventCategory: string;
  eventName: string;
  userId: string | null;
  triggeredBy: string;
  status: string;
  progress: number;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  resourceId: string | null;
  resourceType: string | null;
  resourceName: string | null;
  description: string | null;
  metadata: any | null; // Parsed JSON
  resultSummary: string | null;
  errorMessage: string | null;
  errorDetails: any | null; // Parsed JSON
  logs: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Optional user info if populated
  user?: {
    id: string;
    email: string;
    name: string | null;
  };
}

// ====================
// Event Metadata Types
// ====================

// Generic metadata structure for events
export interface UserEventMetadata {
  [key: string]: any;
}

// Metadata for deployment events
export interface DeploymentEventMetadata extends UserEventMetadata {
  applicationName: string;
  dockerImage: string;
  environmentName?: string;
  deploymentId?: string;
  configurationId?: string;
  triggerType?: string;
  steps?: Array<{
    name: string;
    status: string;
    startedAt?: string;
    completedAt?: string;
    duration?: number;
    error?: string;
  }>;
}

// Metadata for environment events
export interface EnvironmentEventMetadata extends UserEventMetadata {
  environmentName: string;
  environmentType: 'production' | 'nonproduction';
  networkType: 'local' | 'internet';
  services?: string[];
}

// Metadata for certificate events
export interface CertificateEventMetadata extends UserEventMetadata {
  domains: string[];
  primaryDomain: string;
  certificateType: 'ACME' | 'MANUAL';
  acmeProvider?: string;
  expiresAt?: string;
}

// Metadata for backup events
export interface BackupEventMetadata extends UserEventMetadata {
  databaseName: string;
  backupType: 'full' | 'incremental';
  sizeBytes?: number;
  /** Provider-agnostic backend URL recorded by the backup executor. */
  storageObjectUrl?: string;
  /** Provider id captured at write time (e.g. 'azure'). */
  storageProviderAtCreation?: string;
}

// Metadata for container cleanup events
export interface ContainerCleanupEventMetadata extends UserEventMetadata {
  containersIdentified: number;
  containersRemoved: number;
  containersFailed: number;
  dryRun: boolean;
}

// ====================
// API Request Types
// ====================

export interface CreateUserEventRequest {
  eventType: UserEventType | string;
  eventCategory: UserEventCategory | string;
  eventName: string;
  userId?: string;
  triggeredBy: UserEventTriggerType | string;
  status?: UserEventStatus | string; // Defaults to 'pending'
  progress?: number; // Defaults to 0
  resourceId?: string;
  resourceType?: UserEventResourceType | string;
  resourceName?: string;
  description?: string;
  metadata?: UserEventMetadata;
  expiresAt?: Date | string;
}

export interface UpdateUserEventRequest {
  status?: UserEventStatus | string;
  progress?: number;
  completedAt?: Date | string;
  durationMs?: number;
  resultSummary?: string;
  errorMessage?: string;
  errorDetails?: any;
  logs?: string;
  metadata?: UserEventMetadata;
}

export interface AppendUserEventLogsRequest {
  logs: string; // Will be appended to existing logs
}

// ====================
// API Query/Filter Types
// ====================

export interface UserEventFilter {
  eventType?: UserEventType | UserEventType[];
  eventCategory?: UserEventCategory | UserEventCategory[];
  status?: UserEventStatus | UserEventStatus[];
  userId?: string;
  resourceType?: UserEventResourceType | UserEventResourceType[];
  resourceId?: string;
  startDate?: Date | string; // Filter by startedAt >= startDate
  endDate?: Date | string; // Filter by startedAt <= endDate
  search?: string; // Search in eventName, description, resourceName
}

export interface UserEventSortOptions {
  field: keyof UserEventInfo;
  order: 'asc' | 'desc';
}

export interface UserEventListQuery {
  filter?: UserEventFilter;
  sort?: UserEventSortOptions;
  limit?: number;
  offset?: number;
}

// ====================
// API Response Types
// ====================

export interface UserEventResponse {
  success: boolean;
  data: UserEventInfo;
  message?: string;
}

export interface UserEventListResponse {
  success: boolean;
  data: UserEventInfo[];
  message?: string;
  pagination?: {
    limit: number;
    offset: number;
    totalCount: number;
    hasMore: boolean;
  };
}

export interface DeleteUserEventResponse {
  success: boolean;
  message: string;
}

// ====================
// Statistics Types
// ====================

export interface UserEventStatistics {
  totalEvents: number;
  byStatus: Record<UserEventStatus, number>;
  byType: Record<string, number>;
  byCategory: Record<string, number>;
  recentFailures: number; // Last 24 hours
  averageDuration: number | null; // milliseconds
}

export interface UserEventStatisticsResponse {
  success: boolean;
  data: UserEventStatistics;
  message?: string;
}

// ====================
// Settings Types
// ====================

export interface UserEventSettings {
  retentionDays: number;
  maxEventsPerPage: number;
  enableAutoCleanup: boolean;
  cleanupSchedule: string; // Cron expression
}

export interface UserEventSettingsResponse {
  success: boolean;
  data: UserEventSettings;
  message?: string;
}
