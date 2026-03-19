// ====================
// Cloudflare Settings Types
// ====================

// Cloudflare specific request types for settings API
export interface CreateCloudflareSettingRequest {
  api_token: string;
  account_id?: string;
  encrypt?: boolean;
}

export interface UpdateCloudflareSettingRequest {
  api_token?: string;
  account_id?: string;
  encrypt?: boolean;
}

export interface ValidateCloudflareConnectionRequest {
  api_token?: string; // Optional - if not provided, uses stored token
}

// ====================
// Cloudflare Response Types
// ====================

// Cloudflare configuration response
export interface CloudflareSettingResponse {
  success: boolean;
  data: {
    isConfigured: boolean;
    hasApiToken: boolean;
    accountId?: string;
    isValid?: boolean;
    validationMessage?: string;
  };
  message?: string;
}

// Cloudflare connection validation response
export interface CloudflareValidationResponse {
  success: boolean;
  data: {
    isValid: boolean;
    message: string;
    errorCode?: string;
    metadata?: Record<string, any>;
    responseTimeMs: number;
  };
}

// Cloudflare tunnel listing response
export interface CloudflareTunnelListResponse {
  success: boolean;
  data: {
    tunnels: CloudflareTunnelInfo[];
    tunnelCount: number;
  };
  message?: string;
}

// Cloudflare tunnel details response
export interface CloudflareTunnelDetailsResponse {
  success: boolean;
  data: CloudflareTunnelInfo;
  message?: string;
}

// Cloudflare tunnel configuration response
export interface CloudflareTunnelConfigResponse {
  success: boolean;
  data: CloudflareTunnelConfig;
  message?: string;
}

// Cloudflare add hostname request
export interface CloudflareAddHostnameRequest {
  hostname: string;
  service: string;
  path?: string;
}

// Cloudflare hostname management response
export interface CloudflareHostnameResponse {
  success: boolean;
  data: {
    tunnelId: string;
    hostname: string;
    service?: string;
    path?: string;
    configVersion: number;
  };
  message?: string;
}

// ====================
// Cloudflare Metadata Types
// ====================

// Cloudflare user information
export interface CloudflareUserInfo {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  suspended: boolean;
  createdOn?: string;
  modifiedOn?: string;
  twoFactorAuthEnabled?: boolean;
  hasBusinessSupport?: boolean;
  hasEnterpriseSupport?: boolean;
}

// Cloudflare account information
export interface CloudflareAccountInfo {
  id: string;
  name: string;
  type?: string;
  createdOn?: string;
  settings?: {
    enforceTwoFactor?: boolean;
    accessApprovalExpiry?: number;
  };
}

// Cloudflare tunnel information
export interface CloudflareTunnelInfo {
  id: string;
  name: string;
  status: "healthy" | "degraded" | "down" | "inactive";
  createdAt: string;
  deletedAt?: string;
  connections: CloudflareTunnelConnection[];
  connectorId?: string;
  activeTunnelConnections?: number;
  metadata?: Record<string, any>;
  config?: CloudflareTunnelConfig;
}

// Cloudflare tunnel connection
export interface CloudflareTunnelConnection {
  id: string;
  features: string[];
  version: string;
  arch: string;
  config_version?: number;
  run_at: string;
  conns: Array<{
    colo_name: string;
    id: string;
    is_pending_reconnect: boolean;
    origin_ip: string;
    opened_at: string;
  }>;
  clientId?: string;
  clientVersion?: string;
}

// Cloudflare tunnel configuration
export interface CloudflareTunnelConfig {
  config: {
    ingress: CloudflareTunnelIngressRule[];
  };
  source: string;
  version: number;
}

// Cloudflare tunnel ingress rule
export interface CloudflareTunnelIngressRule {
  hostname?: string;
  path?: string;
  service: string;
  originRequest?: {
    connectTimeout?: string;
    tlsTimeout?: string;
    tcpKeepAlive?: string;
    noHappyEyeballs?: boolean;
    keepAliveConnections?: number;
    keepAliveTimeout?: string;
    httpHostHeader?: string;
    originServerName?: string;
    caPool?: string;
    noTLSVerify?: boolean;
    disableChunkedEncoding?: boolean;
    bastionMode?: boolean;
    proxyAddress?: string;
    proxyPort?: number;
    proxyType?: string;
  };
}

// Cloudflare tunnel public hostname information
export interface CloudflareTunnelHostname {
  hostname: string;
  service: string;
  path?: string;
  isWildcard: boolean;
  isCatchAll: boolean;
}

// Cloudflare connection metadata for connectivity status
export interface CloudflareConnectionMetadata {
  userInfo?: CloudflareUserInfo;
  accountInfo?: CloudflareAccountInfo;
  tunnelCount?: number;
  activeTunnels?: number;
  sampleTunnels?: Array<{
    id: string;
    name: string;
    status: string;
    connectionCount: number;
  }>;
  lastConnectionTest?: {
    timestamp: string;
    responseTimeMs: number;
    testType: "user_info" | "account_info" | "tunnel_list" | "full_validation";
  };
}

// ====================
// Cloudflare Configuration Types
// ====================

// Cloudflare configuration service specific types
export interface CloudflareConfigurationOptions {
  apiToken: string;
  accountId?: string;
  timeout?: number;
  maxTunnels?: number;
  cacheTimeout?: number;
}

// Cloudflare service health metadata
export interface CloudflareServiceHealthMetadata {
  userInfo: CloudflareUserInfo;
  accountInfo?: CloudflareAccountInfo;
  tunnelCount: number;
  activeTunnelCount: number;
  lastTunnelListTime: string;
  connectionTestResults: {
    userInfoTest: {
      success: boolean;
      responseTimeMs: number;
      error?: string;
    };
    accountInfoTest?: {
      success: boolean;
      responseTimeMs: number;
      error?: string;
    };
    tunnelListTest: {
      success: boolean;
      responseTimeMs: number;
      tunnelCount?: number;
      error?: string;
    };
  };
}

// ====================
// Cloudflare Error Types
// ====================

// Cloudflare specific error codes
export type CloudflareErrorCode =
  | "MISSING_API_TOKEN"
  | "INVALID_API_TOKEN"
  | "AUTHENTICATION_FAILED"
  | "ACCOUNT_NOT_FOUND"
  | "INSUFFICIENT_PERMISSIONS"
  | "RATE_LIMIT_EXCEEDED"
  | "NETWORK_ERROR"
  | "TIMEOUT_ERROR"
  | "API_ERROR"
  | "ACCOUNT_SUSPENDED"
  | "TUNNEL_NOT_FOUND"
  | "SERVICE_UNAVAILABLE";

// Cloudflare API error response
export interface CloudflareApiError {
  error: string;
  message: string;
  errorCode?: CloudflareErrorCode;
  details?: {
    accountId?: string;
    operation?: string;
    requestId?: string;
    timestamp?: string;
    rateLimitInfo?: {
      limit: number;
      remaining: number;
      resetAt: string;
    };
  };
  timestamp: string;
  requestId?: string;
}

// ====================
// Cloudflare Filter Types
// ====================

// Cloudflare tunnel filtering options
export interface CloudflareTunnelFilter {
  name?: string;
  status?: "healthy" | "degraded" | "down" | "inactive";
  isDeleted?: boolean;
  createdAfter?: Date;
  createdBefore?: Date;
  hasConnections?: boolean;
}

// Cloudflare tunnel sort options
export interface CloudflareTunnelSortOptions {
  field: "name" | "status" | "createdAt" | "connectionCount";
  order: "asc" | "desc";
}

// Cloudflare connectivity status filter (extends base filter)
export interface CloudflareConnectivityFilter {
  service: "cloudflare";
  status?: "connected" | "failed" | "timeout" | "unreachable";
  errorCode?: CloudflareErrorCode;
  responseTimeMin?: number;
  responseTimeMax?: number;
  startDate?: Date;
  endDate?: Date;
}

// ====================
// Cloudflare DNS Types
// ====================

export interface CloudflareDNSZone {
  id: string;
  name: string;
  status: 'active' | 'pending' | 'initializing' | 'moved' | 'deleted';
  paused: boolean;
  type: 'full' | 'partial';
  development_mode: number;
  name_servers: string[];
  original_name_servers?: string[];
  original_registrar?: string;
  original_dnshost?: string;
  created_on: string;
  modified_on: string;
}

export interface CloudflareDNSRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxiable: boolean;
  proxied: boolean;
  ttl: number;
  locked: boolean;
  zone_id: string;
  zone_name: string;
  created_on: string;
  modified_on: string;
  data?: Record<string, any>;
  meta?: {
    auto_added?: boolean;
    managed_by_apps?: boolean;
    managed_by_argo_tunnel?: boolean;
  };
}

export interface CreateCloudflareDNSRecordRequest {
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT';
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
}

export interface UpdateCloudflareDNSRecordRequest {
  type?: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT';
  name?: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
}

// ====================
// Managed Tunnel Types
// ====================

export interface ManagedTunnelInfo {
  tunnelId: string;
  tunnelName: string;
  environmentId: string;
  hasToken: boolean;
  createdAt?: string;
}

export interface ManagedTunnelWithStack extends ManagedTunnelInfo {
  stackId?: string;
  stackStatus?: string;
}

export interface ManagedTunnelListResponse {
  success: boolean;
  data: ManagedTunnelWithStack[];
  message?: string;
}

export interface ManagedTunnelResponse {
  success: boolean;
  data: ManagedTunnelWithStack | null;
  message?: string;
}

export interface CreateManagedTunnelRequest {
  name: string;
}