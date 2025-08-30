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
  pagination?: {
    page: number;
    limit: number;
    totalCount: number;
    hasMore: boolean;
  };
}

export interface SettingsApiError {
  error: string;
  message: string;
  details?: any;
  timestamp: string;
  requestId?: string;
}

export interface SettingsDeleteResponse {
  success: boolean;
  message: string;
  timestamp: string;
  requestId?: string;
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
// Connectivity Status Types
// ====================

// Database ConnectivityStatus type (matches Prisma schema)
export interface ConnectivityStatus {
  id: string;
  service: string;
  status: string;
  responseTimeMs: bigint | null;
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
  totalCount?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
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

// ====================
// Configuration Service Types
// ====================

// Validation result interface
export interface ValidationResult {
  isValid: boolean;
  message: string;
  errorCode?: string;
  responseTimeMs?: number;
  metadata?: Record<string, any>;
}

// Service health status interface
export interface ServiceHealthStatus {
  service: ConnectivityService;
  status: ConnectivityStatusType;
  lastChecked: Date;
  lastSuccessful?: Date;
  responseTime?: number;
  errorMessage?: string;
  errorCode?: string;
  metadata?: Record<string, any>;
}

// Configuration service interface (abstract base)
export interface IConfigurationService {
  validate(): Promise<ValidationResult>;
  getHealthStatus(): Promise<ServiceHealthStatus>;
  set(key: string, value: string, userId: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string, userId: string): Promise<void>;
}

// Service factory types
export interface ServiceFactoryOptions {
  category: SettingsCategory;
  encryptionKey?: string;
}

export interface IConfigurationServiceFactory {
  create(options: ServiceFactoryOptions): IConfigurationService;
  getSupportedCategories(): SettingsCategory[];
}

// ====================
// Validation API Types
// ====================

export interface ValidateServiceRequest {
  settings?: Record<string, string>; // Optional settings to validate with
}

export interface ValidateServiceResponse {
  success: boolean;
  data: {
    service: string;
    isValid: boolean;
    responseTimeMs: number;
    error?: string;
    errorCode?: string;
    metadata?: Record<string, any>;
    validatedAt: string;
  };
  message: string;
  timestamp: string;
  requestId?: string;
}
