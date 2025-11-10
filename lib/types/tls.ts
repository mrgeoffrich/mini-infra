export interface TlsCertificate {
  id: string;

  // Certificate identification
  domains: string[];
  primaryDomain: string;
  certificateType: "ACME" | "MANUAL";

  // ACME-specific fields
  acmeProvider: string | null;
  acmeAccountId: string | null;
  acmeOrderUrl: string | null;

  // Azure Key Vault references
  keyVaultCertificateName: string;
  keyVaultVersion: string | null;
  keyVaultSecretId: string | null;

  // Certificate metadata
  issuer: string | null;
  serialNumber: string | null;
  fingerprint: string | null;

  // Lifecycle dates
  issuedAt: Date;
  notBefore: Date;
  notAfter: Date;
  renewAfter: Date;
  lastRenewedAt: Date | null;

  // Status tracking
  status: "PENDING" | "ACTIVE" | "RENEWING" | "EXPIRED" | "REVOKED" | "ERROR";
  lastError: string | null;
  lastErrorAt: Date | null;

  // Configuration
  autoRenew: boolean;
  renewalDaysBeforeExpiry: number;

  // Associated HAProxy frontends
  haproxyFrontends: string[];

  // Audit trail
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TlsCertificateRenewal {
  id: string;
  certificateId: string;

  // Renewal attempt details
  attemptNumber: number;
  status: "INITIATED" | "DNS_CHALLENGE_CREATED" | "DNS_CHALLENGE_VALIDATED" |
          "CERTIFICATE_ISSUED" | "STORED_IN_VAULT" | "DEPLOYED_TO_HAPROXY" |
          "COMPLETED" | "FAILED";

  // Timing
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;

  // ACME details
  acmeOrderUrl: string | null;
  acmeChallengeType: string | null;
  dnsRecordName: string | null;
  dnsRecordValue: string | null;

  // Key Vault details
  keyVaultVersion: string | null;

  // HAProxy deployment
  haproxyReloadMethod: string | null;
  haproxyReloadSuccess: boolean;

  // Error tracking
  errorMessage: string | null;
  errorCode: string | null;
  errorDetails: string | null;

  // Metadata
  triggeredBy: string;
  metadata: string | null;
}

export interface CreateCertificateRequest {
  domains: string[];
  primaryDomain: string;
  autoRenew?: boolean;
  renewalDaysBeforeExpiry?: number;
}

export interface TlsSettings {
  key_vault_url: string;
  key_vault_tenant_id: string;
  key_vault_client_id: string;
  key_vault_client_secret: string;
  default_acme_provider: "letsencrypt" | "letsencrypt-staging";
  default_acme_email: string;
  renewal_check_cron: string;
  renewal_days_before_expiry: string;
}
