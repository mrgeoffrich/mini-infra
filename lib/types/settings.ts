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
