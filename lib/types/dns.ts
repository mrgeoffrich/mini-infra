// ====================
// DNS Record Types
// ====================

export type DNSRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT';

export interface DNSRecordInfo {
  id: string;
  type: DNSRecordType;
  name: string; // hostname (e.g., "api.example.com")
  content: string; // IP address or target
  ttl: number;
  proxied: boolean; // CloudFlare-specific
  zoneId: string;
  zoneName: string;
  createdAt: string;
  modifiedAt: string;
}

export interface CreateDNSRecordRequest {
  type: DNSRecordType;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
}

export interface UpdateDNSRecordRequest {
  content?: string;
  ttl?: number;
  proxied?: boolean;
}

export interface DNSRecordResponse {
  success: boolean;
  data: DNSRecordInfo;
  message?: string;
}

export interface DNSRecordListResponse {
  success: boolean;
  data: DNSRecordInfo[];
  message?: string;
}

// ====================
// Deployment DNS Tracking
// ====================

export interface DeploymentDNSRecord {
  id: string;
  deploymentConfigId: string;
  hostname: string;
  dnsProvider: 'cloudflare' | 'external';
  dnsRecordId?: string; // Provider's record ID
  ipAddress?: string;
  status: 'active' | 'pending' | 'failed' | 'removed';
  createdAt: Date;
  updatedAt: Date;
  errorMessage?: string;
}

export interface DeploymentDNSRecordInfo {
  id: string;
  deploymentConfigId: string;
  hostname: string;
  dnsProvider: 'cloudflare' | 'external';
  dnsRecordId?: string;
  ipAddress?: string;
  status: 'active' | 'pending' | 'failed' | 'removed';
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
}
