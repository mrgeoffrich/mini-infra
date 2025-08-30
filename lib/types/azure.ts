// ====================
// Azure Storage Settings Types
// ====================

// Azure specific request types for settings API
export interface CreateAzureSettingRequest {
  connectionString: string;
  accountName?: string;
}

export interface UpdateAzureSettingRequest {
  connectionString?: string;
  accountName?: string;
}

export interface ValidateAzureConnectionRequest {
  connectionString?: string; // Optional - if not provided, uses stored connection
  testContainerAccess?: boolean; // Whether to test container listing
}

// Azure specific validation request for configuration testing
export interface AzureConfigTestRequest {
  connectionString: string;
  timeout?: number; // Timeout in milliseconds (default: 15000)
}

// ====================
// Azure Response Types
// ====================

// Azure configuration response
export interface AzureSettingResponse {
  success: boolean;
  data: {
    id: string;
    accountName: string | null;
    connectionConfigured: boolean;
    lastValidatedAt: string | null;
    validationStatus: string | null;
    validationMessage: string | null;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    updatedBy: string;
  };
  message?: string;
  timestamp: string;
  requestId?: string;
}

// Azure connection validation response
export interface AzureValidationResponse {
  success: boolean;
  data: {
    service: "azure";
    isValid: boolean;
    responseTimeMs: number;
    accountInfo?: AzureAccountInfo;
    containerCount?: number;
    sampleContainers?: AzureContainerInfo[];
    error?: string;
    errorCode?: string;
    validatedAt: string;
  };
  message: string;
  timestamp: string;
  requestId?: string;
}

// Azure container listing response
export interface AzureContainerListResponse {
  success: boolean;
  data: {
    accountName: string;
    containerCount: number;
    containers: AzureContainerInfo[];
    hasMore: boolean;
    nextMarker?: string;
  };
  message?: string;
  timestamp: string;
  requestId?: string;
}

// Azure container access test response
export interface AzureContainerAccessResponse {
  success: boolean;
  data: {
    containerName: string;
    accessible: boolean;
    responseTimeMs: number;
    lastModified?: string;
    leaseStatus?: string;
    error?: string;
    errorCode?: string;
    testedAt: string;
  };
  message: string;
  timestamp: string;
  requestId?: string;
}

// ====================
// Azure Metadata Types
// ====================

// Azure Storage Account information
export interface AzureAccountInfo {
  accountName: string;
  accountKind: string;
  skuName: string;
  skuTier: string;
  primaryLocation: string;
  secondaryLocation?: string;
  creationTime?: string;
  primaryEndpoints?: {
    blob?: string;
    queue?: string;
    table?: string;
    file?: string;
  };
}

// Azure Storage Container information
export interface AzureContainerInfo {
  name: string;
  lastModified: string;
  leaseStatus: "locked" | "unlocked";
  leaseState: "available" | "leased" | "expired" | "breaking" | "broken";
  hasImmutabilityPolicy: boolean;
  hasLegalHold: boolean;
  publicAccess?: "container" | "blob" | null;
  metadata?: Record<string, string>;
}

// Azure connection metadata for connectivity status
export interface AzureConnectionMetadata {
  accountInfo?: AzureAccountInfo;
  containerCount?: number;
  sampleContainers?: Array<{
    name: string;
    lastModified: string;
    leaseStatus: string;
  }>;
  connectionString?: {
    protocol: string;
    accountName: string;
    endpoint?: string;
  };
  lastConnectionTest?: {
    timestamp: string;
    responseTimeMs: number;
    testType: "account_info" | "container_list" | "full_validation";
  };
}

// ====================
// Azure Configuration Types
// ====================

// Azure configuration service specific types
export interface AzureConfigurationOptions {
  connectionString: string;
  timeout?: number;
  maxContainers?: number;
  cacheTimeout?: number;
}

// Azure connection string components
export interface AzureConnectionStringInfo {
  defaultEndpointsProtocol: string;
  accountName: string;
  accountKey: string;
  endpointSuffix: string;
  blobEndpoint?: string;
  queueEndpoint?: string;
  tableEndpoint?: string;
  fileEndpoint?: string;
}

// Azure service health metadata
export interface AzureServiceHealthMetadata {
  accountInfo: AzureAccountInfo;
  containerCount: number;
  lastContainerListTime: string;
  connectionTestResults: {
    accountInfoTest: {
      success: boolean;
      responseTimeMs: number;
      error?: string;
    };
    containerListTest: {
      success: boolean;
      responseTimeMs: number;
      containerCount?: number;
      error?: string;
    };
  };
}

// ====================
// Azure Error Types
// ====================

// Azure specific error codes
export type AzureErrorCode =
  | "INVALID_CONNECTION_STRING"
  | "AUTHENTICATION_FAILED"
  | "ACCOUNT_NOT_FOUND"
  | "NETWORK_ERROR"
  | "TIMEOUT_ERROR"
  | "PERMISSION_DENIED"
  | "RESOURCE_NOT_FOUND"
  | "THROTTLING_ERROR"
  | "INVALID_ACCOUNT_KEY"
  | "STORAGE_ACCOUNT_DISABLED"
  | "CONNECTION_REFUSED"
  | "DNS_RESOLUTION_FAILED";

// Azure API error response
export interface AzureApiError {
  error: string;
  message: string;
  errorCode?: AzureErrorCode;
  details?: {
    accountName?: string;
    operation?: string;
    requestId?: string;
    timestamp?: string;
  };
  timestamp: string;
  requestId?: string;
}

// ====================
// Azure Filter Types
// ====================

// Azure container filtering options
export interface AzureContainerFilter {
  namePrefix?: string;
  leaseStatus?: "locked" | "unlocked";
  leaseState?: "available" | "leased" | "expired" | "breaking" | "broken";
  publicAccess?: "container" | "blob" | null;
  hasMetadata?: boolean;
  lastModifiedAfter?: Date;
  lastModifiedBefore?: Date;
}

// Azure container sort options
export interface AzureContainerSortOptions {
  field: "name" | "lastModified" | "leaseStatus";
  order: "asc" | "desc";
}

// Azure connectivity status filter (extends base filter)
export interface AzureConnectivityFilter {
  service: "azure";
  status?: "connected" | "failed" | "timeout" | "unreachable";
  errorCode?: AzureErrorCode;
  responseTimeMin?: number;
  responseTimeMax?: number;
  startDate?: Date;
  endDate?: Date;
}
