// ====================
// System Settings Types
// ====================

// Database SystemSettings type (matches Prisma schema)
export interface SystemSettings {
  id: string;
  category: string;
  key: string;
  value: string;
  isEncrypted: boolean;
  isActive: boolean;
  lastValidatedAt: Date | null;
  validationStatus: string | null;
  validationMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}

// SystemSettings for API responses (frontend-friendly with date strings)
export interface SystemSettingsInfo {
  id: string;
  category: string;
  key: string;
  value: string;
  isEncrypted: boolean;
  isActive: boolean;
  lastValidatedAt: string | null;
  validationStatus: string | null;
  validationMessage: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

// ====================
// Settings Categories
// ====================

export type SettingsCategory = "docker" | "cloudflare" | "azure";

export type ValidationStatus = "valid" | "invalid" | "pending" | "error";

// ====================
// API Request Types
// ====================

export interface CreateSettingRequest {
  category: SettingsCategory;
  key: string;
  value: string;
  isEncrypted?: boolean;
}

export interface UpdateSettingRequest {
  value: string;
  isEncrypted?: boolean;
}

// ====================
// API Response Types
// ====================

export interface SettingResponse {
  success: boolean;
  data: SystemSettingsInfo;
  message?: string;
}

export interface SettingsListResponse {
  success: boolean;
  data: SystemSettingsInfo[];
  message?: string;
}

// ====================
// Settings Management Types
// ====================

export interface SettingsFilter {
  category?: SettingsCategory;
  isActive?: boolean;
  validationStatus?: ValidationStatus;
}

export interface SettingsSortOptions {
  field: keyof SystemSettingsInfo;
  order: "asc" | "desc";
}

// ====================
// Settings Audit Types
// ====================

// Database SettingsAudit type (matches Prisma schema)
export interface SettingsAudit {
  id: string;
  category: string;
  key: string;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  success: boolean;
  errorMessage: string | null;
  createdAt: Date;
}

// SettingsAudit for API responses (frontend-friendly with date strings)
export interface SettingsAuditInfo {
  id: string;
  category: string;
  key: string;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  success: boolean;
  errorMessage: string | null;
  createdAt: string;
}

// ====================
// Audit Action Types
// ====================

export type AuditAction = "create" | "update" | "delete" | "validate";

// ====================
// Audit API Response Types
// ====================

export interface SettingsAuditResponse {
  success: boolean;
  data: SettingsAuditInfo;
  message?: string;
}

export interface SettingsAuditListResponse {
  success: boolean;
  data: SettingsAuditInfo[];
  message?: string;
}

// ====================
// Audit Filter and Sort Types
// ====================

export interface SettingsAuditFilter {
  category?: SettingsCategory;
  action?: AuditAction;
  userId?: string;
  success?: boolean;
  startDate?: Date;
  endDate?: Date;
}

export interface SettingsAuditSortOptions {
  field: keyof SettingsAuditInfo;
  order: "asc" | "desc";
}

// ====================
// Connectivity Status Types
// ====================

// Database ConnectivityStatus type (matches Prisma schema)
export interface ConnectivityStatus {
  id: string;
  service: string;
  status: string;
  responseTimeMs: number | null;
  errorMessage: string | null;
  errorCode: string | null;
  lastSuccessfulAt: Date | null;
  checkedAt: Date;
  checkInitiatedBy: string | null;
  metadata: string | null;
}

// ConnectivityStatus for API responses (frontend-friendly with date strings)
export interface ConnectivityStatusInfo {
  id: string;
  service: string;
  status: string;
  responseTimeMs: number | null;
  errorMessage: string | null;
  errorCode: string | null;
  lastSuccessfulAt: string | null;
  checkedAt: string;
  checkInitiatedBy: string | null;
  metadata: string | null;
}

// ====================
// Connectivity Status Enums
// ====================

export type ConnectivityService = "cloudflare" | "docker" | "azure";

export type ConnectivityStatusType =
  | "connected"
  | "failed"
  | "timeout"
  | "unreachable";

// ====================
// Connectivity API Response Types
// ====================

export interface ConnectivityStatusResponse {
  success: boolean;
  data: ConnectivityStatusInfo;
  message?: string;
}

export interface ConnectivityStatusListResponse {
  success: boolean;
  data: ConnectivityStatusInfo[];
  message?: string;
}

// ====================
// Connectivity Filter and Sort Types
// ====================

export interface ConnectivityStatusFilter {
  service?: ConnectivityService;
  status?: ConnectivityStatusType;
  checkInitiatedBy?: string;
  startDate?: Date;
  endDate?: Date;
}

export interface ConnectivityStatusSortOptions {
  field: keyof ConnectivityStatusInfo;
  order: "asc" | "desc";
}
