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

// ====================
// DNS Cache Types
// ====================

export interface DnsCachedZone {
  id: string;
  cloudflareZoneId: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
  nameServers: string[];
  createdOn: string | null;
  modifiedOn: string | null;
  cachedAt: string;
  recordCount: number;
}

export interface DnsCachedRecord {
  id: string;
  cloudflareRecordId: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  proxiable: boolean;
  locked: boolean;
  zoneName: string;
  createdOn: string | null;
  modifiedOn: string | null;
}

export interface DnsZonesResponse {
  success: boolean;
  data: { zones: DnsCachedZone[]; lastRefreshed: string | null };
}

export interface DnsZoneRecordsResponse {
  success: boolean;
  data: { zone: DnsCachedZone; records: DnsCachedRecord[] };
}

export interface DnsRefreshResponse {
  success: boolean;
  data: { zonesUpdated: number; recordsUpdated: number; lastRefreshed: string };
}

export interface DnsHostnameCheckResult {
  matchedZone: boolean;
  zoneName?: string;
  existingRecords?: Array<{ type: string; content: string; proxied: boolean }>;
}
