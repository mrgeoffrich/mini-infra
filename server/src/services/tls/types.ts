/**
 * TLS Certificate Management Types
 *
 * This module defines TypeScript interfaces and types for TLS certificate management,
 * ACME protocol integration, Azure Key Vault storage, and certificate lifecycle operations.
 */

import { AcmeProvider } from "@mini-infra/types";
export type { AcmeProvider };

/**
 * Certificate metadata parsed from X.509 certificate
 */
export interface CertificateMetadata {
  domains: string[];
  issuer: string;
  subject?: string;
  serialNumber?: string;
  notBefore: Date;
  notAfter: Date;
  fingerprint: string;
}

/**
 * Certificate information returned by Key Vault listing operations
 */
export interface CertificateInfo {
  name: string;
  version?: string;
  enabled?: boolean;
  created?: Date;
  updated?: Date;
  tags?: Record<string, string>;
}

/**
 * Request to issue a new certificate
 */
export interface CertificateRequest {
  domains: string[];
  primaryDomain: string;
  userId: string;
  deployToHaproxy?: boolean;
  haproxyContainerId?: string;
}

/**
 * Result of certificate deployment to HAProxy
 */
export interface DeploymentResult {
  success: boolean;
  certificatePath?: string;
  method: 'runtime-api' | 'volume-mount-reload' | 'graceful-reload';
  error?: string;
}

/**
 * Result of automated renewal check
 */
export interface RenewalCheckResult {
  total: number;
  renewed: number;
  failed: number;
  errors: Array<{
    certificateId: string;
    domains: string[];
    error: string;
  }>;
}

/**
 * ACME account configuration
 */
export interface AcmeAccountConfig {
  email: string;
  provider: AcmeProvider;
  termsOfServiceAgreed?: boolean;
}

/**
 * Result of ACME certificate request
 */
export interface AcmeCertificateResult {
  certificate: string;
  privateKey: string;
  chain: string;
}

/**
 * Azure Key Vault certificate storage result
 */
export interface KeyVaultStorageResult {
  version: string;
  secretId: string;
}

/**
 * Azure Key Vault certificate retrieval result
 */
export interface KeyVaultCertificateResult {
  certificate: string;
  privateKey: string;
  metadata: CertificateMetadata;
}

/**
 * Dependencies for CertificateLifecycleManager
 */
export interface LifecycleManagerDependencies {
  acmeClient: unknown; // AcmeClientManager - will be defined in acme-client-manager.ts
  keyVaultStore: unknown; // AzureKeyVaultCertificateStore - will be defined in azure-keyvault-certificate-store.ts
  dnsChallenge: unknown; // DnsChallenge01Provider - will be defined in dns-challenge-provider.ts
  distributor?: unknown; // CertificateDistributor - will be defined in certificate-distributor.ts
  prisma: unknown; // PrismaClient
}

/**
 * Certificate parsing result
 */
export interface CertificateParseResult {
  issuer: string;
  subject: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
  fingerprint: string;
}
