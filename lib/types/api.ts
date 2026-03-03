// ====================
// Standard API Response Types
// ====================

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  timestamp?: string;
  requestId?: string;
}

export interface ApiError {
  error: string;
  message: string;
  timestamp: string;
  requestId?: string;
  details?: any;
}

export interface ValidationError {
  error: string;
  message: string;
  details: Array<{
    code: string;
    expected?: string;
    received?: string;
    path: Array<string | number>;
    message: string;
  }>;
  timestamp: string;
  requestId?: string;
}

// ====================
// Pagination Types
// ====================

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  totalCount: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

// ====================
// Sorting and Filtering Types
// ====================

export type SortOrder = "asc" | "desc";

export interface SortParams {
  sortBy?: string;
  sortOrder?: SortOrder;
}

export interface QueryParams extends PaginationParams, SortParams {
  search?: string;
}

// ====================
// Health Check Types
// ====================

export interface HealthStatus {
  status: "healthy" | "unhealthy";
  timestamp: string;
  environment: string;
  uptime: number;
  services?: Record<
    string,
    {
      status: "connected" | "disconnected" | "error";
      message?: string;
    }
  >;
}

// ====================
// Rate Limiting Types
// ====================

export interface RateLimitError extends ApiError {
  retryAfter?: number;
  limit: number;
  remaining: number;
  resetTime: string;
}
