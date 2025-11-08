# TLS Certificate Renewal Service - Implementation Plan

## Executive Summary

This document outlines the implementation plan for a comprehensive TLS certificate renewal service for the Mini Infra application. The service will:

- **Automate Let's Encrypt certificate provisioning** using the `acme-client` Node.js library
- **Store certificates securely in Azure Key Vault** for centralized secret management
- **Distribute certificates to HAProxy** running in Docker containers
- **Support DNS-01 challenges** via Cloudflare for wildcard certificate support
- **Integrate seamlessly** with existing service architecture patterns
- **Provide zero-downtime certificate updates** using HAProxy Runtime API

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Technology Stack](#technology-stack)
3. [Database Schema Changes](#database-schema-changes)
4. [File Structure](#file-structure)
5. [Service Implementation](#service-implementation)
6. [Integration Points](#integration-points)
7. [Certificate Distribution Flow](#certificate-distribution-flow)
8. [Renewal Automation](#renewal-automation)
9. [Security Considerations](#security-considerations)
10. [Testing Strategy](#testing-strategy)
11. [Deployment & Configuration](#deployment--configuration)
12. [Monitoring & Alerting](#monitoring--alerting)
13. [Implementation Phases](#implementation-phases)

---

## Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    TLS Renewal Service                          │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    │
│  │ ACME Client  │───▶│ Key Vault    │───▶│ Certificate  │    │
│  │ (Let's       │    │ Integration  │    │ Distributor  │    │
│  │  Encrypt)    │    │              │    │              │    │
│  └──────────────┘    └──────────────┘    └──────────────┘    │
│         │                    │                    │            │
│         │                    │                    │            │
│         ▼                    ▼                    ▼            │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    │
│  │ DNS-01       │    │ Certificate  │    │ HAProxy      │    │
│  │ Challenger   │    │ Lifecycle    │    │ Runtime API  │    │
│  │ (Cloudflare) │    │ Manager      │    │ Integration  │    │
│  └──────────────┘    └──────────────┘    └──────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  Azure Key Vault     │
                    │  - Certificates      │
                    │  - Private Keys      │
                    │  - Account Keys      │
                    │  - Metadata          │
                    └──────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  HAProxy Container   │
                    │  - Mounted certs     │
                    │  - Auto-reload       │
                    │  - Zero downtime     │
                    └──────────────────────┘
```

### Component Responsibilities

#### 1. **TLS Configuration Service**
- Extends `ConfigurationService` base class ([server/src/services/configuration-base.ts](c:/Repos/mini-infra/server/src/services/configuration-base.ts))
- Manages TLS settings category in `SystemSettings` table
- Handles Azure Key Vault connection configuration
- Validates ACME account configuration

#### 2. **ACME Client Manager**
- Wraps `acme-client` library with Mini Infra patterns
- Manages Let's Encrypt account registration
- Handles certificate issuance and renewal
- Implements DNS-01 challenge orchestration

#### 3. **Azure Key Vault Integration**
- Uses `@azure/keyvault-certificates` and `@azure/keyvault-secrets` SDKs
- Stores certificates, private keys, and ACME account keys
- Implements versioning and rotation
- Provides audit logging

#### 4. **DNS Challenge Provider**
- Integrates with existing `CloudflareConfigService` ([server/src/services/cloudflare-config.ts](c:/Repos/mini-infra/server/src/services/cloudflare-config.ts))
- Creates and removes TXT records for ACME validation
- Implements propagation wait logic
- Supports multiple domains and wildcard certificates

#### 5. **Certificate Distributor**
- Retrieves certificates from Azure Key Vault
- Formats certificates for HAProxy (combined PEM format)
- Mounts certificates into HAProxy container via Docker volumes
- Triggers HAProxy Runtime API certificate reload

#### 6. **Certificate Lifecycle Manager**
- Tracks certificate expiration dates
- Triggers renewal at configurable intervals (default: 30 days before expiry)
- Manages certificate metadata in database
- Implements retry logic for failed renewals

#### 7. **Renewal Scheduler**
- Uses `node-cron` (already in dependencies)
- Runs daily checks for certificate expiration
- Triggers automatic renewal workflow
- Sends alerts on renewal success/failure

---

## Technology Stack

### New Dependencies

```json
{
  "dependencies": {
    // ACME Client
    "acme-client": "^5.4.0",

    // Azure Key Vault SDKs
    "@azure/keyvault-certificates": "^4.9.0",
    "@azure/keyvault-secrets": "^4.9.0",
    "@azure/identity": "^4.5.0",

    // Certificate utilities
    "node-forge": "^1.3.1",
    "pem": "^1.14.8"
  },
  "devDependencies": {
    "@types/node-forge": "^1.3.11"
  }
}
```

### Existing Dependencies (Leveraged)

- **node-cron**: Renewal scheduling
- **cloudflare**: DNS-01 challenge via existing `CloudflareConfigService`
- **dockerode**: HAProxy container certificate mounting
- **node-cache**: Certificate metadata caching
- **Prisma**: Database persistence
- **Pino**: Domain-specific logging (`app-tls.log`)

---

## Database Schema Changes

### New Prisma Models

```prisma
// Add to server/prisma/schema.prisma

/// Managed TLS certificate records
model TlsCertificate {
  id                    String   @id @default(cuid())

  // Certificate identification
  domains               String[] // Array of domains (e.g., ["example.com", "*.example.com"])
  primaryDomain         String   // Main domain for certificate
  certificateType       CertificateType @default(ACME) // "ACME" | "MANUAL"

  // ACME-specific fields
  acmeProvider          String?  // "letsencrypt" | "buypass" | "zerossl"
  acmeAccountId         String?  // ACME account identifier
  acmeOrderUrl          String?  // ACME order URL for renewals

  // Azure Key Vault references
  keyVaultCertificateName String  @unique // Name in Azure Key Vault
  keyVaultVersion         String?         // Current version in Key Vault
  keyVaultSecretId        String?         // Full secret identifier

  // Certificate metadata
  issuer                String?
  serialNumber          String?
  fingerprint           String?  @unique

  // Lifecycle dates
  issuedAt              DateTime
  notBefore             DateTime
  notAfter              DateTime
  renewAfter            DateTime // Calculated: notAfter - renewalDaysBeforeExpiry
  lastRenewedAt         DateTime?

  // Status tracking
  status                CertificateStatus @default(PENDING) // "PENDING" | "ACTIVE" | "RENEWING" | "EXPIRED" | "REVOKED" | "ERROR"
  lastError             String?
  lastErrorAt           DateTime?

  // Configuration
  autoRenew             Boolean  @default(true)
  renewalDaysBeforeExpiry Int   @default(30)

  // Associated HAProxy frontends
  haproxyFrontends      String[] // Frontend names using this cert

  // Audit trail
  createdBy             String
  updatedBy             String?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  // Relations
  renewalHistory        TlsCertificateRenewal[]

  @@index([primaryDomain])
  @@index([status])
  @@index([renewAfter])
  @@index([notAfter])
}

/// Certificate renewal history and audit log
model TlsCertificateRenewal {
  id              String   @id @default(cuid())
  certificateId   String
  certificate     TlsCertificate @relation(fields: [certificateId], references: [id], onDelete: Cascade)

  // Renewal attempt details
  attemptNumber   Int      // Retry attempt number (1, 2, 3...)
  status          RenewalStatus // "INITIATED" | "DNS_CHALLENGE_CREATED" | "CHALLENGE_VALIDATED" | "CERTIFICATE_ISSUED" | "STORED_IN_VAULT" | "DEPLOYED_TO_HAPROXY" | "COMPLETED" | "FAILED"

  // Timing
  startedAt       DateTime @default(now())
  completedAt     DateTime?
  durationMs      Int?

  // ACME details
  acmeOrderUrl    String?
  acmeChallengeType String? // "dns-01"
  dnsRecordName   String?  // e.g., "_acme-challenge.example.com"
  dnsRecordValue  String?

  // Key Vault details
  keyVaultVersion String?  // New version created in Key Vault

  // HAProxy deployment
  haproxyReloadMethod String? // "runtime-api" | "graceful-reload"
  haproxyReloadSuccess Boolean @default(false)

  // Error tracking
  errorMessage    String?
  errorCode       String?
  errorDetails    String?  // JSON stringified detailed error

  // Metadata
  triggeredBy     String   // "auto-renewal" | "manual" | userId
  metadata        String?  // JSON stringified additional data

  @@index([certificateId])
  @@index([status])
  @@index([startedAt])
}

/// ACME account management
model AcmeAccount {
  id              String   @id @default(cuid())

  // Account identification
  email           String   @unique
  provider        String   // "letsencrypt" | "letsencrypt-staging" | "buypass" | "zerossl"
  accountUrl      String   @unique // ACME account URL

  // Key storage
  keyVaultSecretName String @unique // Private key stored in Key Vault
  keyAlgorithm    String   @default("RSA-2048") // "RSA-2048" | "ECDSA-P256"

  // Status
  status          String   @default("ACTIVE") // "ACTIVE" | "DEACTIVATED"
  termsOfServiceUrl String?
  agreedToTermsAt DateTime?

  // Audit
  createdBy       String
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([email])
  @@index([provider])
}

// Enums
enum CertificateType {
  ACME    // Let's Encrypt via ACME protocol
  MANUAL  // Manually uploaded certificate
}

enum CertificateStatus {
  PENDING   // Certificate order initiated
  ACTIVE    // Certificate issued and active
  RENEWING  // Renewal in progress
  EXPIRED   // Certificate expired
  REVOKED   // Certificate revoked
  ERROR     // Error state
}

enum RenewalStatus {
  INITIATED
  DNS_CHALLENGE_CREATED
  DNS_CHALLENGE_VALIDATED
  CERTIFICATE_ISSUED
  STORED_IN_VAULT
  DEPLOYED_TO_HAPROXY
  COMPLETED
  FAILED
}
```

### SystemSettings Category Addition

Add to existing `SystemSettings` usage:

```typescript
// Category: "tls" (new)
// Keys:
{
  "key_vault_url": "https://my-vault.vault.azure.net/",
  "key_vault_tenant_id": "...",
  "key_vault_client_id": "...",
  "key_vault_client_secret": "...", // Encrypted
  "default_acme_provider": "letsencrypt",
  "default_acme_email": "admin@example.com",
  "renewal_check_cron": "0 2 * * *", // Daily at 2 AM
  "renewal_days_before_expiry": "30"
}
```

---

## File Structure

### New Files to Create

```
server/src/
├── services/
│   ├── tls/
│   │   ├── tls-config.ts                        # TlsConfigService (extends ConfigurationService)
│   │   ├── acme-client-manager.ts               # ACME client wrapper
│   │   ├── azure-keyvault-certificate-store.ts  # Key Vault integration
│   │   ├── dns-challenge-provider.ts            # DNS-01 challenge orchestration
│   │   ├── certificate-distributor.ts           # HAProxy certificate deployment
│   │   ├── certificate-lifecycle-manager.ts     # Renewal orchestration
│   │   ├── certificate-renewal-scheduler.ts     # Cron-based renewal scheduler
│   │   ├── certificate-format-helper.ts         # PEM formatting utilities
│   │   └── types.ts                             # TLS-specific types
│   └── configuration-factory.ts                 # UPDATE: Add "tls" case
│
├── routes/
│   ├── tls-certificates.ts                      # CRUD operations for certificates
│   ├── tls-settings.ts                          # TLS configuration settings
│   ├── tls-renewals.ts                          # Manual renewal triggers
│   └── tls-connectivity.ts                      # Key Vault connectivity checks
│
├── lib/
│   └── logger-factory.ts                        # UPDATE: Add "tls" domain logger
│
└── __tests__/
    ├── services/
    │   └── tls/
    │       ├── acme-client-manager.test.ts
    │       ├── azure-keyvault-certificate-store.test.ts
    │       ├── dns-challenge-provider.test.ts
    │       ├── certificate-distributor.test.ts
    │       └── certificate-lifecycle-manager.test.ts
    └── routes/
        └── tls-certificates.test.ts

lib/types/
└── tls.ts                                        # Shared TypeScript types

client/src/
├── app/
│   └── certificates/                             # New certificate management page
│       ├── page.tsx                              # Certificate list/dashboard
│       ├── create/
│       │   └── page.tsx                          # Create new certificate
│       └── [id]/
│           ├── page.tsx                          # Certificate details
│           └── renew/
│               └── page.tsx                      # Manual renewal trigger
│
├── components/
│   └── certificates/
│       ├── certificate-list.tsx
│       ├── certificate-status-badge.tsx
│       ├── certificate-form.tsx
│       ├── renewal-history-table.tsx
│       └── certificate-details-card.tsx
│
└── hooks/
    ├── use-certificates.ts                       # React Query hooks
    └── use-tls-settings.ts

projectmanagement/
└── TLS_RENEWAL_SERVICE_IMPLEMENTATION_PLAN.md    # This document
```

### Files to Update

```
server/src/
├── services/
│   ├── configuration-factory.ts                  # Add "tls" category case
│   └── haproxy/
│       └── haproxy-service.ts                    # Add certificate reload method
│
├── lib/
│   └── logger-factory.ts                         # Add "tls" domain logger
│
├── app.ts                                        # Register new routes
│
└── server.ts                                     # Initialize TLS renewal scheduler

server/prisma/
└── schema.prisma                                 # Add TLS models

lib/types/
└── index.ts                                      # Export TLS types

client/src/
└── lib/
    └── api-client.ts                             # Add TLS API endpoints
```

---

## Service Implementation

### 1. TlsConfigService

**File**: `server/src/services/tls/tls-config.ts`

**Purpose**: Manages TLS-related system settings, extends `ConfigurationService`

**Key Methods**:
```typescript
export class TlsConfigService extends ConfigurationService {
  constructor(prisma: PrismaClient) {
    super(prisma, "tls");
  }

  // Validate Key Vault connectivity
  async validate(settings?: Record<string, string>): Promise<ValidationResult>

  // Get Key Vault client
  async getKeyVaultClient(): Promise<{
    certificateClient: CertificateClient;
    secretClient: SecretClient;
  }>

  // Get ACME account configuration
  async getAcmeAccountConfig(): Promise<{
    email: string;
    provider: "letsencrypt" | "letsencrypt-staging";
  }>

  // Health check
  async getHealthStatus(): Promise<ServiceHealthStatus>
}
```

**Integration Points**:
- Extends [server/src/services/configuration-base.ts](c:/Repos/mini-infra/server/src/services/configuration-base.ts)
- Uses `recordConnectivityStatus()` for Key Vault health tracking
- Stores settings in `SystemSettings` table with `category = "tls"`

**Error Handling**:
- Validates Key Vault URL format
- Tests Key Vault connectivity before saving settings
- Records connectivity failures in `ConnectivityStatus` table

---

### 2. AcmeClientManager

**File**: `server/src/services/tls/acme-client-manager.ts`

**Purpose**: Manages ACME protocol interactions with Let's Encrypt

**Key Methods**:
```typescript
export class AcmeClientManager {
  private acmeClient: acme.Client | null = null;
  private keyVaultStore: AzureKeyVaultCertificateStore;
  private logger: Logger;

  constructor(
    private config: TlsConfigService,
    keyVaultStore: AzureKeyVaultCertificateStore
  ) {
    this.logger = loggerFactory.getDomainLogger("tls");
  }

  // Initialize ACME client with account from Key Vault
  async initialize(): Promise<void>

  // Create new ACME account
  async createAccount(email: string): Promise<AcmeAccount>

  // Request certificate for domains
  async requestCertificate(
    domains: string[],
    challengeProvider: DnsChallenge01Provider
  ): Promise<{
    certificate: string;
    privateKey: string;
    chain: string;
  }>

  // Renew existing certificate
  async renewCertificate(
    certificateId: string,
    challengeProvider: DnsChallenge01Provider
  ): Promise<{
    certificate: string;
    privateKey: string;
    chain: string;
  }>

  // Revoke certificate
  async revokeCertificate(certificateId: string): Promise<void>
}
```

**ACME Flow**:
```typescript
// 1. Initialize client with account key from Key Vault
const accountKey = await keyVaultStore.getAccountKey(email);
this.acmeClient = new acme.Client({
  directoryUrl: acme.directory.letsencrypt.production,
  accountKey: accountKey
});

// 2. Create CSR
const [certKey, certCsr] = await acme.crypto.createCsr({
  altNames: domains
});

// 3. Request certificate with DNS-01 challenge
const certificate = await this.acmeClient.auto({
  csr: certCsr,
  email: email,
  termsOfServiceAgreed: true,
  challengePriority: ['dns-01'],

  challengeCreateFn: async (authz, challenge, keyAuthorization) => {
    await challengeProvider.createChallenge(authz, challenge, keyAuthorization);
  },

  challengeRemoveFn: async (authz, challenge, keyAuthorization) => {
    await challengeProvider.removeChallenge(authz, challenge, keyAuthorization);
  }
});

return {
  certificate: certificate,
  privateKey: certKey.toString(),
  chain: certificate // Let's Encrypt includes full chain
};
```

**Research Reference**: Based on acme-client pattern from [projectmanagement/tls_certs_research.md:16-68](c:/Repos/mini-infra/projectmanagement/tls_certs_research.md)

---

### 3. AzureKeyVaultCertificateStore

**File**: `server/src/services/tls/azure-keyvault-certificate-store.ts`

**Purpose**: Manages certificate storage and retrieval in Azure Key Vault

**Key Methods**:
```typescript
export class AzureKeyVaultCertificateStore {
  private certificateClient: CertificateClient;
  private secretClient: SecretClient;
  private logger: Logger;

  constructor(keyVaultUrl: string, credential: TokenCredential) {
    this.certificateClient = new CertificateClient(keyVaultUrl, credential);
    this.secretClient = new SecretClient(keyVaultUrl, credential);
    this.logger = loggerFactory.getDomainLogger("tls");
  }

  // Store certificate in Key Vault
  async storeCertificate(
    name: string,
    certificatePem: string,
    privateKeyPem: string,
    metadata: CertificateMetadata
  ): Promise<{
    version: string;
    secretId: string;
  }>

  // Retrieve certificate with private key
  async getCertificate(name: string, version?: string): Promise<{
    certificate: string;
    privateKey: string;
    metadata: CertificateMetadata;
  }>

  // Store ACME account key
  async storeAccountKey(email: string, accountKey: string): Promise<void>

  // Retrieve ACME account key
  async getAccountKey(email: string): Promise<Buffer>

  // List all certificates
  async listCertificates(): Promise<CertificateInfo[]>

  // Delete certificate (soft delete)
  async deleteCertificate(name: string): Promise<void>

  // Purge deleted certificate (permanent)
  async purgeCertificate(name: string): Promise<void>
}
```

**Certificate Storage Strategy**:

Azure Key Vault provides two APIs for certificates:
1. **Certificate API**: Manages certificate metadata and lifecycle
2. **Secret API**: Stores the actual PEM-encoded certificate + private key

**Storage Pattern**:
```typescript
async storeCertificate(name, certPem, keyPem, metadata) {
  // Combine certificate and private key (HAProxy format)
  const combinedPem = certPem + keyPem;

  // Store as secret (includes private key)
  const secretResponse = await this.secretClient.setSecret(
    name,
    combinedPem,
    {
      contentType: "application/x-pem-file",
      tags: {
        domains: metadata.domains.join(","),
        notBefore: metadata.notBefore.toISOString(),
        notAfter: metadata.notAfter.toISOString(),
        issuer: metadata.issuer,
        fingerprint: metadata.fingerprint
      }
    }
  );

  return {
    version: secretResponse.properties.version,
    secretId: secretResponse.properties.id
  };
}
```

**ACME Account Key Storage**:
```typescript
async storeAccountKey(email: string, accountKey: string): Promise<void> {
  const secretName = `acme-account-${email.replace(/[^a-zA-Z0-9-]/g, '-')}`;

  await this.secretClient.setSecret(secretName, accountKey, {
    contentType: "application/pkcs8",
    tags: {
      email: email,
      type: "acme-account-key"
    }
  });
}
```

**Authentication**:
```typescript
// Use DefaultAzureCredential (supports multiple auth methods)
import { DefaultAzureCredential } from "@azure/identity";

const credential = new DefaultAzureCredential();
const keyVaultUrl = "https://my-vault.vault.azure.net/";

const store = new AzureKeyVaultCertificateStore(keyVaultUrl, credential);
```

**Environment Variables Required**:
```bash
# Service Principal Authentication
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
```

**Integration with Existing Azure Pattern**:
- Follows same pattern as `AzureConfigService` ([server/src/services/azure-config.ts](c:/Repos/mini-infra/server/src/services/azure-config.ts))
- Uses retry logic with exponential backoff
- Records connectivity status in database
- Implements health checks

**Research Reference**: Based on Azure DNS integration pattern from [projectmanagement/tls_certs_research.md:72-118](c:/Repos/mini-infra/projectmanagement/tls_certs_research.md)

---

### 4. DnsChallenge01Provider

**File**: `server/src/services/tls/dns-challenge-provider.ts`

**Purpose**: Implements DNS-01 challenge for ACME protocol via Cloudflare

**Key Methods**:
```typescript
export class DnsChallenge01Provider {
  private cloudflareConfig: CloudflareConfigService;
  private logger: Logger;
  private cache: NodeCache; // Cache DNS record IDs

  constructor(cloudflareConfig: CloudflareConfigService) {
    this.cloudflareConfig = cloudflareConfig;
    this.logger = loggerFactory.getDomainLogger("tls");
    this.cache = new NodeCache({ stdTTL: 3600 }); // 1 hour TTL
  }

  // Create TXT record for ACME challenge
  async createChallenge(
    authz: any,
    challenge: any,
    keyAuthorization: string
  ): Promise<void>

  // Remove TXT record after validation
  async removeChallenge(
    authz: any,
    challenge: any,
    keyAuthorization: string
  ): Promise<void>

  // Wait for DNS propagation
  private async waitForPropagation(
    recordName: string,
    expectedValue: string,
    maxWaitMs: number = 60000
  ): Promise<boolean>
}
```

**DNS-01 Challenge Flow**:
```typescript
async createChallenge(authz, challenge, keyAuthorization) {
  if (challenge.type !== 'dns-01') {
    throw new Error(`Unsupported challenge type: ${challenge.type}`);
  }

  const domain = authz.identifier.value;
  const recordName = `_acme-challenge.${domain}`;

  this.logger.info({ domain, recordName }, "Creating DNS-01 challenge");

  // Get Cloudflare zone ID
  const zoneId = await this.cloudflareConfig.getZoneId(domain);

  // Create TXT record via Cloudflare API
  const recordId = await this.cloudflareConfig.createDnsRecord({
    zoneId: zoneId,
    type: 'TXT',
    name: recordName,
    content: keyAuthorization,
    ttl: 120 // 2 minutes
  });

  // Cache record ID for later removal
  this.cache.set(`challenge:${domain}`, recordId);

  // Wait for DNS propagation
  this.logger.info({ domain, recordName }, "Waiting for DNS propagation...");
  await this.waitForPropagation(recordName, keyAuthorization, 60000);

  this.logger.info({ domain, recordName }, "DNS challenge ready for validation");
}

async removeChallenge(authz, challenge, keyAuthorization) {
  const domain = authz.identifier.value;
  const recordId = this.cache.get<string>(`challenge:${domain}`);

  if (!recordId) {
    this.logger.warn({ domain }, "No cached record ID for cleanup");
    return;
  }

  this.logger.info({ domain, recordId }, "Removing DNS challenge record");

  const zoneId = await this.cloudflareConfig.getZoneId(domain);
  await this.cloudflareConfig.deleteDnsRecord(zoneId, recordId);

  this.cache.del(`challenge:${domain}`);
}
```

**DNS Propagation Verification**:
```typescript
import dns from 'dns';
import { promisify } from 'util';

const resolveTxt = promisify(dns.resolveTxt);

async waitForPropagation(recordName, expectedValue, maxWaitMs) {
  const startTime = Date.now();
  const interval = 5000; // Check every 5 seconds

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const txtRecords = await resolveTxt(recordName);
      const flatRecords = txtRecords.flat();

      if (flatRecords.includes(expectedValue)) {
        this.logger.info({ recordName }, "DNS propagation confirmed");
        return true;
      }

      this.logger.debug({ recordName, txtRecords }, "DNS not yet propagated");
    } catch (error) {
      this.logger.debug({ recordName, error }, "DNS lookup failed (expected during propagation)");
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }

  this.logger.error({ recordName, maxWaitMs }, "DNS propagation timeout");
  return false;
}
```

**Integration with CloudflareConfigService**:
```typescript
// Extend CloudflareConfigService with DNS record management
// File: server/src/services/cloudflare-config.ts

export class CloudflareConfigService extends ConfigurationService {
  // ... existing methods ...

  // NEW: Create DNS record
  async createDnsRecord(params: {
    zoneId: string;
    type: string;
    name: string;
    content: string;
    ttl: number;
  }): Promise<string> {
    const cloudflare = await this.getCloudflareClient();

    const response = await cloudflare.dnsRecords.create(params.zoneId, {
      type: params.type,
      name: params.name,
      content: params.content,
      ttl: params.ttl
    });

    return response.id;
  }

  // NEW: Delete DNS record
  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    const cloudflare = await this.getCloudflareClient();
    await cloudflare.dnsRecords.delete(zoneId, recordId);
  }

  // NEW: Get zone ID by domain
  async getZoneId(domain: string): Promise<string> {
    const cloudflare = await this.getCloudflareClient();

    const zones = await cloudflare.zones.list({ name: domain });

    if (zones.length === 0) {
      throw new Error(`No Cloudflare zone found for domain: ${domain}`);
    }

    return zones[0].id;
  }
}
```

**Research Reference**: Based on DNS-01 challenge pattern from [projectmanagement/tls_certs_research.md:602-657](c:/Repos/mini-infra/projectmanagement/tls_certs_research.md)

---

### 5. CertificateDistributor

**File**: `server/src/services/tls/certificate-distributor.ts`

**Purpose**: Distributes certificates from Key Vault to HAProxy containers

**Key Methods**:
```typescript
export class CertificateDistributor {
  private keyVaultStore: AzureKeyVaultCertificateStore;
  private haproxyService: HAProxyService;
  private dockerService: DockerService;
  private logger: Logger;

  constructor(
    keyVaultStore: AzureKeyVaultCertificateStore,
    haproxyService: HAProxyService,
    dockerService: DockerService
  ) {
    this.logger = loggerFactory.getDomainLogger("tls");
  }

  // Deploy certificate to HAProxy container
  async deployCertificate(
    certificateId: string,
    haproxyContainerId: string
  ): Promise<DeploymentResult>

  // Update certificate using HAProxy Runtime API (zero-downtime)
  async updateCertificateViaRuntimeApi(
    certificateName: string,
    certificatePem: string,
    privateKeyPem: string
  ): Promise<void>

  // Graceful reload fallback (for HAProxy < 2.1)
  async gracefulReload(haproxyContainerId: string): Promise<void>

  // Mount certificate directory into container
  async mountCertificateVolume(
    haproxyContainerId: string,
    certificatePath: string
  ): Promise<void>
}
```

**Certificate Deployment Strategy**:

**Option A: Runtime API Update (Preferred - Zero Downtime)**

Based on HAProxy 2.1+ Runtime API from research document.

```typescript
async updateCertificateViaRuntimeApi(certName, certPem, keyPem) {
  const combinedPem = certPem + keyPem;
  const certPath = `/etc/haproxy/certs/${certName}.pem`;
  const sockPath = '/var/run/haproxy/admin.sock';

  this.logger.info({ certName }, "Updating certificate via Runtime API");

  // Execute socat commands in HAProxy container
  const container = await this.dockerService.getContainer(haproxyContainerId);

  // 1. Set new certificate (transaction)
  const setCmd = `echo "set ssl cert ${certPath} <<" | socat stdio unix-connect:${sockPath}`;
  await container.exec({ Cmd: ['sh', '-c', setCmd] });

  // 2. Send certificate content
  const contentCmd = `echo "${combinedPem}" | socat stdio unix-connect:${sockPath}`;
  await container.exec({ Cmd: ['sh', '-c', contentCmd] });

  // 3. Commit changes (activates immediately)
  const commitCmd = `echo "commit ssl cert ${certPath}" | socat stdio unix-connect:${sockPath}`;
  await container.exec({ Cmd: ['sh', '-c', commitCmd] });

  // 4. Copy to disk for persistence
  await container.exec({
    Cmd: ['sh', '-c', `echo "${combinedPem}" > ${certPath}`]
  });

  this.logger.info({ certName }, "Certificate updated successfully via Runtime API");
}
```

**Option B: Docker Volume Mount (Alternative - Requires Restart)**

```typescript
async deployCertificate(certificateId, haproxyContainerId) {
  // 1. Get certificate from Key Vault
  const cert = await this.keyVaultStore.getCertificate(certificateId);

  // 2. Write to host filesystem (shared volume)
  const hostCertPath = `/var/lib/mini-infra/haproxy/certs/${certificateId}.pem`;
  const combinedPem = cert.certificate + cert.privateKey;

  await fs.promises.writeFile(hostCertPath, combinedPem, {
    mode: 0o640 // rw-r-----
  });

  // 3. Ensure HAProxy container has volume mounted
  // Volume: /var/lib/mini-infra/haproxy/certs:/etc/haproxy/certs:ro

  // 4. Trigger graceful reload
  await this.gracefulReload(haproxyContainerId);

  return {
    success: true,
    certificatePath: hostCertPath,
    method: 'volume-mount-reload'
  };
}
```

**HAProxy Configuration Update**:

The HAProxy configuration needs to be updated to load certificates from the mounted directory:

```haproxy
# File: server/docker-compose/haproxy/haproxy.cfg

global
    stats socket /var/run/haproxy/admin.sock mode 660 level admin expose-fd listeners
    tune.ssl.default-dh-param 2048

frontend fe_https
    # Load all certificates from directory
    bind *:443 ssl crt /etc/haproxy/certs/ alpn h2,http/1.1 ssl-min-ver TLSv1.2

    # SNI routing (automatic based on certificate CN/SANs)
    use_backend %[ssl_fc_sni,lower,map_dom(/etc/haproxy/domain-backend.map)]

    default_backend default_backend
```

**Docker Compose Volume Configuration**:

```yaml
# File: server/docker-compose/haproxy/docker-compose.yml

services:
  haproxy:
    image: haproxy:3.2
    volumes:
      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
      - haproxy-certs:/etc/haproxy/certs:ro  # Read-only certificate mount
      - haproxy-socket:/var/run/haproxy      # Socket for Runtime API
    ports:
      - "80:80"
      - "443:443"
      - "8404:8404"  # Stats
      - "5555:5555"  # DataPlane API

volumes:
  haproxy-certs:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /var/lib/mini-infra/haproxy/certs
  haproxy-socket:
```

**Integration with HAProxyService**:

Update existing `HAProxyService` to support certificate reloads:

```typescript
// File: server/src/services/haproxy/haproxy-service.ts

export class HAProxyService implements IApplicationService {
  // ... existing code ...

  // NEW: Reload certificate via Runtime API
  async reloadCertificate(certPath: string): Promise<void> {
    const dataPlaneClient = new HAProxyDataPlaneClient(this.dockerService);

    // Future: Use DataPlane API for certificate reload
    // For now: Execute socat commands
    const container = await this.findHAProxyContainer();

    const sockPath = '/var/run/haproxy/admin.sock';
    const cmd = `echo "show ssl cert ${certPath}" | socat stdio unix-connect:${sockPath}`;

    const result = await container.exec({
      Cmd: ['sh', '-c', cmd],
      AttachStdout: true,
      AttachStderr: true
    });

    this.logger.info({ certPath, result }, "Certificate reload triggered");
  }
}
```

**Research Reference**: Based on HAProxy Runtime API from [projectmanagement/tls_certs_research.md:479-524](c:/Repos/mini-infra/projectmanagement/tls_certs_research.md)

---

### 6. CertificateLifecycleManager

**File**: `server/src/services/tls/certificate-lifecycle-manager.ts`

**Purpose**: Orchestrates certificate issuance and renewal workflows

**Key Methods**:
```typescript
export class CertificateLifecycleManager {
  private acmeClient: AcmeClientManager;
  private keyVaultStore: AzureKeyVaultCertificateStore;
  private dnsChallenge: DnsChallenge01Provider;
  private distributor: CertificateDistributor;
  private prisma: PrismaClient;
  private logger: Logger;

  constructor(dependencies: LifecycleManagerDependencies) {
    this.logger = loggerFactory.getDomainLogger("tls");
  }

  // Issue new certificate
  async issueCertificate(request: CertificateRequest): Promise<TlsCertificate>

  // Renew existing certificate
  async renewCertificate(certificateId: string): Promise<TlsCertificate>

  // Check if certificate needs renewal
  async needsRenewal(certificateId: string): Promise<boolean>

  // Get certificates expiring soon
  async getCertificatesNeedingRenewal(daysThreshold?: number): Promise<TlsCertificate[]>

  // Revoke certificate
  async revokeCertificate(certificateId: string): Promise<void>
}
```

**Certificate Issuance Flow**:

```typescript
async issueCertificate(request: CertificateRequest): Promise<TlsCertificate> {
  const { domains, primaryDomain, userId } = request;

  this.logger.info({ domains, primaryDomain }, "Starting certificate issuance");

  // Create renewal history record
  const renewal = await this.prisma.tlsCertificateRenewal.create({
    data: {
      certificateId: null, // Will update after cert created
      attemptNumber: 1,
      status: "INITIATED",
      triggeredBy: userId
    }
  });

  try {
    // Step 1: Request certificate from Let's Encrypt
    this.logger.info("Requesting certificate from ACME provider");
    await this.updateRenewalStatus(renewal.id, "DNS_CHALLENGE_CREATED");

    const { certificate, privateKey, chain } = await this.acmeClient.requestCertificate(
      domains,
      this.dnsChallenge
    );

    await this.updateRenewalStatus(renewal.id, "CERTIFICATE_ISSUED");

    // Step 2: Parse certificate metadata
    const certInfo = await this.parseCertificate(certificate);

    // Step 3: Store in Azure Key Vault
    this.logger.info("Storing certificate in Azure Key Vault");
    const keyVaultName = `cert-${primaryDomain.replace(/\./g, '-')}`;

    const { version, secretId } = await this.keyVaultStore.storeCertificate(
      keyVaultName,
      certificate,
      privateKey,
      {
        domains: domains,
        issuer: certInfo.issuer,
        notBefore: certInfo.notBefore,
        notAfter: certInfo.notAfter,
        fingerprint: certInfo.fingerprint
      }
    );

    await this.updateRenewalStatus(renewal.id, "STORED_IN_VAULT");

    // Step 4: Create database record
    const renewAfter = new Date(certInfo.notAfter);
    renewAfter.setDate(renewAfter.getDate() - 30); // Renew 30 days before expiry

    const tlsCertificate = await this.prisma.tlsCertificate.create({
      data: {
        domains: domains,
        primaryDomain: primaryDomain,
        certificateType: "ACME",
        acmeProvider: "letsencrypt",
        keyVaultCertificateName: keyVaultName,
        keyVaultVersion: version,
        keyVaultSecretId: secretId,
        issuer: certInfo.issuer,
        serialNumber: certInfo.serialNumber,
        fingerprint: certInfo.fingerprint,
        issuedAt: new Date(),
        notBefore: certInfo.notBefore,
        notAfter: certInfo.notAfter,
        renewAfter: renewAfter,
        status: "ACTIVE",
        autoRenew: true,
        createdBy: userId
      }
    });

    // Update renewal record with certificate ID
    await this.prisma.tlsCertificateRenewal.update({
      where: { id: renewal.id },
      data: { certificateId: tlsCertificate.id }
    });

    // Step 5: Deploy to HAProxy (if configured)
    if (request.deployToHaproxy) {
      this.logger.info("Deploying certificate to HAProxy");
      await this.distributor.deployCertificate(
        tlsCertificate.id,
        request.haproxyContainerId
      );

      await this.updateRenewalStatus(renewal.id, "DEPLOYED_TO_HAPROXY");
    }

    // Step 6: Mark renewal complete
    await this.updateRenewalStatus(renewal.id, "COMPLETED", {
      completedAt: new Date(),
      durationMs: Date.now() - renewal.startedAt.getTime()
    });

    this.logger.info(
      { certificateId: tlsCertificate.id, domains },
      "Certificate issuance completed successfully"
    );

    return tlsCertificate;

  } catch (error) {
    // Record failure
    await this.prisma.tlsCertificateRenewal.update({
      where: { id: renewal.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorMessage: error.message,
        errorCode: error.code,
        errorDetails: JSON.stringify(error)
      }
    });

    this.logger.error({ error, domains }, "Certificate issuance failed");
    throw error;
  }
}
```

**Certificate Renewal Flow**:

```typescript
async renewCertificate(certificateId: string): Promise<TlsCertificate> {
  // Get existing certificate
  const existingCert = await this.prisma.tlsCertificate.findUnique({
    where: { id: certificateId },
    include: { renewalHistory: true }
  });

  if (!existingCert) {
    throw new Error(`Certificate not found: ${certificateId}`);
  }

  this.logger.info(
    { certificateId, domains: existingCert.domains },
    "Starting certificate renewal"
  );

  // Determine attempt number
  const attemptNumber = existingCert.renewalHistory.filter(
    r => r.status === "FAILED"
  ).length + 1;

  // Create renewal record
  const renewal = await this.prisma.tlsCertificateRenewal.create({
    data: {
      certificateId: certificateId,
      attemptNumber: attemptNumber,
      status: "INITIATED",
      triggeredBy: "auto-renewal"
    }
  });

  // Update certificate status
  await this.prisma.tlsCertificate.update({
    where: { id: certificateId },
    data: { status: "RENEWING" }
  });

  try {
    // Follow same flow as issuance
    const { certificate, privateKey } = await this.acmeClient.renewCertificate(
      certificateId,
      this.dnsChallenge
    );

    // Store new version in Key Vault
    const { version, secretId } = await this.keyVaultStore.storeCertificate(
      existingCert.keyVaultCertificateName,
      certificate,
      privateKey,
      { /* metadata */ }
    );

    // Update certificate record
    const updatedCert = await this.prisma.tlsCertificate.update({
      where: { id: certificateId },
      data: {
        keyVaultVersion: version,
        keyVaultSecretId: secretId,
        lastRenewedAt: new Date(),
        status: "ACTIVE",
        lastError: null,
        lastErrorAt: null
      }
    });

    // Deploy to HAProxy (zero-downtime update)
    if (existingCert.haproxyFrontends.length > 0) {
      await this.distributor.updateCertificateViaRuntimeApi(
        existingCert.keyVaultCertificateName,
        certificate,
        privateKey
      );
    }

    // Mark renewal complete
    await this.updateRenewalStatus(renewal.id, "COMPLETED");

    this.logger.info({ certificateId }, "Certificate renewal completed successfully");

    return updatedCert;

  } catch (error) {
    // Record failure
    await this.prisma.tlsCertificate.update({
      where: { id: certificateId },
      data: {
        status: "ERROR",
        lastError: error.message,
        lastErrorAt: new Date()
      }
    });

    await this.updateRenewalStatus(renewal.id, "FAILED", {
      errorMessage: error.message
    });

    this.logger.error({ certificateId, error }, "Certificate renewal failed");
    throw error;
  }
}
```

**Certificate Parsing Utility**:

```typescript
import forge from 'node-forge';

async parseCertificate(certificatePem: string): Promise<CertificateInfo> {
  const cert = forge.pki.certificateFromPem(certificatePem);

  return {
    issuer: cert.issuer.getField('CN').value,
    subject: cert.subject.getField('CN').value,
    serialNumber: cert.serialNumber,
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    fingerprint: forge.md.sha256.create()
      .update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes())
      .digest()
      .toHex()
  };
}
```

---

### 7. CertificateRenewalScheduler

**File**: `server/src/services/tls/certificate-renewal-scheduler.ts`

**Purpose**: Automated certificate renewal scheduling using cron

**Key Methods**:
```typescript
export class CertificateRenewalScheduler {
  private lifecycleManager: CertificateLifecycleManager;
  private prisma: PrismaClient;
  private logger: Logger;
  private cronJob: cron.ScheduledTask | null = null;

  constructor(
    lifecycleManager: CertificateLifecycleManager,
    prisma: PrismaClient
  ) {
    this.logger = loggerFactory.getDomainLogger("tls");
  }

  // Start scheduled renewal checks
  async start(cronExpression?: string): Promise<void>

  // Stop scheduler
  async stop(): Promise<void>

  // Run renewal check immediately (manual trigger)
  async checkRenewals(): Promise<RenewalCheckResult>

  // Process single certificate renewal
  private async processCertificateRenewal(
    certificate: TlsCertificate
  ): Promise<void>
}
```

**Scheduler Implementation**:

```typescript
import cron from 'node-cron';

async start(cronExpression?: string): Promise<void> {
  // Get cron expression from settings (default: daily at 2 AM)
  const schedule = cronExpression || "0 2 * * *";

  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron expression: ${schedule}`);
  }

  this.logger.info({ schedule }, "Starting TLS renewal scheduler");

  this.cronJob = cron.schedule(schedule, async () => {
    this.logger.info("Running scheduled certificate renewal check");

    try {
      const result = await this.checkRenewals();

      this.logger.info(
        {
          total: result.total,
          renewed: result.renewed,
          failed: result.failed
        },
        "Certificate renewal check completed"
      );
    } catch (error) {
      this.logger.error({ error }, "Certificate renewal check failed");
    }
  });

  this.logger.info({ schedule }, "TLS renewal scheduler started");
}

async checkRenewals(): Promise<RenewalCheckResult> {
  const now = new Date();

  // Find certificates needing renewal
  const certificates = await this.prisma.tlsCertificate.findMany({
    where: {
      autoRenew: true,
      status: "ACTIVE",
      renewAfter: {
        lte: now // renewAfter date has passed
      }
    }
  });

  this.logger.info(
    { count: certificates.length },
    "Found certificates needing renewal"
  );

  const results = {
    total: certificates.length,
    renewed: 0,
    failed: 0,
    errors: []
  };

  for (const cert of certificates) {
    try {
      await this.processCertificateRenewal(cert);
      results.renewed++;
    } catch (error) {
      results.failed++;
      results.errors.push({
        certificateId: cert.id,
        domains: cert.domains,
        error: error.message
      });

      this.logger.error(
        { certificateId: cert.id, domains: cert.domains, error },
        "Certificate renewal failed"
      );
    }
  }

  return results;
}

private async processCertificateRenewal(certificate: TlsCertificate): Promise<void> {
  this.logger.info(
    {
      certificateId: certificate.id,
      domains: certificate.domains,
      notAfter: certificate.notAfter
    },
    "Processing certificate renewal"
  );

  // Use lifecycle manager to renew
  await this.lifecycleManager.renewCertificate(certificate.id);

  this.logger.info(
    { certificateId: certificate.id },
    "Certificate renewed successfully"
  );
}
```

**Integration with Server Startup**:

```typescript
// File: server/src/server.ts

import { CertificateRenewalScheduler } from './services/tls/certificate-renewal-scheduler';
import { CertificateLifecycleManager } from './services/tls/certificate-lifecycle-manager';
// ... other imports ...

async function startServer() {
  // ... existing initialization ...

  // Initialize TLS renewal scheduler
  const tlsConfigService = new TlsConfigService(prisma);
  const lifecycleManager = new CertificateLifecycleManager({
    /* dependencies */
  });
  const renewalScheduler = new CertificateRenewalScheduler(
    lifecycleManager,
    prisma
  );

  // Get cron schedule from settings
  const cronSchedule = await tlsConfigService.get('renewal_check_cron') || "0 2 * * *";
  await renewalScheduler.start(cronSchedule);

  logger.info("TLS renewal scheduler initialized");

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info("Stopping TLS renewal scheduler...");
    await renewalScheduler.stop();
    // ... other cleanup ...
  });

  // ... rest of server startup ...
}
```

---

## Integration Points

### 1. Configuration Factory Update

**File**: `server/src/services/configuration-factory.ts`

Add TLS configuration service to factory:

```typescript
export class ConfigurationFactory {
  static createConfigService(
    category: SettingsCategory,
    prisma: PrismaClient
  ): ConfigurationService {
    switch (category) {
      case "azure":
        return new AzureConfigService(prisma);
      case "docker":
        return new DockerConfigService(prisma);
      case "cloudflare":
        return new CloudflareConfigService(prisma);
      case "postgres":
        return new PostgresConfigService(prisma);
      case "tls":  // NEW
        return new TlsConfigService(prisma);
      default:
        throw new Error(`Unknown configuration category: ${category}`);
    }
  }
}
```

**Type Update** (`lib/types/configuration.ts`):
```typescript
export type SettingsCategory = "azure" | "docker" | "cloudflare" | "postgres" | "tls";
```

---

### 2. Logger Factory Update

**File**: `server/src/lib/logger-factory.ts`

Add TLS domain logger:

```typescript
const DOMAIN_LOGGERS: DomainLoggers = {
  app: createDomainLogger("app", "app.log"),
  services: createDomainLogger("services", "app-services.log"),
  http: createDomainLogger("http", "app-http.log"),
  dockerExecutor: createDomainLogger("dockerExecutor", "app-dockerexecutor.log"),
  prisma: createDomainLogger("prisma", "app-prisma.log"),
  deployments: createDomainLogger("deployments", "app-deployments.log"),
  tls: createDomainLogger("tls", "app-tls.log"), // NEW
};
```

**Log File**: `server/logs/app-tls.log`
- All TLS operations (certificate issuance, renewal, errors)
- ACME protocol interactions
- Key Vault operations
- DNS challenge creation/removal
- HAProxy certificate deployment

---

### 3. Route Registration

**File**: `server/src/app.ts`

Register new TLS routes:

```typescript
import tlsCertificatesRouter from "./routes/tls-certificates";
import tlsSettingsRouter from "./routes/tls-settings";
import tlsRenewalsRouter from "./routes/tls-renewals";
import tlsConnectivityRouter from "./routes/tls-connectivity";

// ... existing code ...

app.use("/api/tls/certificates", tlsCertificatesRouter);
app.use("/api/tls/settings", tlsSettingsRouter);
app.use("/api/tls/renewals", tlsRenewalsRouter);
app.use("/api/tls/connectivity", tlsConnectivityRouter);
```

---

### 4. HAProxyService Integration

**File**: `server/src/services/haproxy/haproxy-service.ts`

Add certificate management methods:

```typescript
export class HAProxyService implements IApplicationService {
  // ... existing code ...

  // NEW: Reload certificate via Runtime API
  async reloadCertificate(certPath: string, certPem: string): Promise<void> {
    const container = await this.findHAProxyContainer();
    const sockPath = '/var/run/haproxy/admin.sock';

    // Use Runtime API to hot-reload certificate
    await this.executeRuntimeApiCommand(container, `set ssl cert ${certPath}`);
    await this.executeRuntimeApiCommand(container, certPem);
    await this.executeRuntimeApiCommand(container, `commit ssl cert ${certPath}`);

    this.logger.info({ certPath }, "Certificate reloaded via Runtime API");
  }

  // NEW: Execute Runtime API command
  private async executeRuntimeApiCommand(
    container: Dockerode.Container,
    command: string
  ): Promise<string> {
    const sockPath = '/var/run/haproxy/admin.sock';
    const cmd = `echo "${command}" | socat stdio unix-connect:${sockPath}`;

    const exec = await container.exec({
      Cmd: ['sh', '-c', cmd],
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise((resolve, reject) => {
      let output = '';
      stream.on('data', (chunk) => { output += chunk.toString(); });
      stream.on('end', () => resolve(output));
      stream.on('error', reject);
    });
  }
}
```

---

## Certificate Distribution Flow

### End-to-End Certificate Lifecycle

```
1. Certificate Request (User/API)
   │
   ├──▶ CertificateLifecycleManager.issueCertificate()
        │
        ├──▶ AcmeClientManager.requestCertificate()
        │    │
        │    ├──▶ DnsChallenge01Provider.createChallenge()
        │    │    │
        │    │    └──▶ CloudflareConfigService.createDnsRecord()
        │    │         (Create _acme-challenge.example.com TXT record)
        │    │
        │    ├──▶ Wait for DNS propagation (30-60 seconds)
        │    │
        │    ├──▶ ACME Client validates challenge
        │    │
        │    ├──▶ DnsChallenge01Provider.removeChallenge()
        │    │    │
        │    │    └──▶ CloudflareConfigService.deleteDnsRecord()
        │    │
        │    └──▶ ACME Client issues certificate
        │         Returns: { certificate, privateKey, chain }
        │
        ├──▶ AzureKeyVaultCertificateStore.storeCertificate()
        │    │
        │    └──▶ Azure Key Vault Secret API
        │         Stores: combinedPem (cert + key)
        │         Returns: { version, secretId }
        │
        ├──▶ Create TlsCertificate record in database
        │    - domains, primaryDomain, status: ACTIVE
        │    - keyVaultCertificateName, keyVaultVersion
        │    - notBefore, notAfter, renewAfter
        │
        └──▶ CertificateDistributor.deployCertificate()
             │
             ├──▶ AzureKeyVaultCertificateStore.getCertificate()
             │
             ├──▶ Write combinedPem to host filesystem
             │    /var/lib/mini-infra/haproxy/certs/{certName}.pem
             │
             └──▶ HAProxyService.reloadCertificate()
                  (Runtime API update - zero downtime)

2. Automated Renewal (Scheduler)
   │
   ├──▶ CertificateRenewalScheduler.checkRenewals()
        (Runs daily at 2 AM via cron)
        │
        ├──▶ Query: renewAfter <= NOW AND autoRenew = true
        │
        └──▶ For each certificate:
             │
             └──▶ CertificateLifecycleManager.renewCertificate()
                  │
                  └──▶ (Same flow as issuance)
                       - Request new cert from ACME
                       - Store new version in Key Vault
                       - Update database record
                       - Deploy to HAProxy (Runtime API)
```

---

## Renewal Automation

### Renewal Trigger Conditions

1. **Automated Renewal (Scheduled)**:
   - Runs daily at 2 AM (configurable via `renewal_check_cron`)
   - Checks all certificates where `renewAfter <= NOW`
   - Only processes certificates with `autoRenew = true`
   - Calculates `renewAfter` as: `notAfter - renewalDaysBeforeExpiry`
   - Default: 30 days before expiry

2. **Manual Renewal (API)**:
   - User triggers renewal via API endpoint
   - Bypasses `renewAfter` date check
   - Useful for forced renewals or testing

3. **Pre-Expiry Warning**:
   - Monitor certificates with `notAfter - NOW < 14 days`
   - Send alerts if renewal hasn't succeeded
   - Escalate alerts at 7 days, 2 days, 1 day before expiry

### Renewal Retry Strategy

```typescript
// In CertificateLifecycleManager.renewCertificate()

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 5000, 15000]; // 1s, 5s, 15s

async renewCertificate(certificateId: string): Promise<TlsCertificate> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      this.logger.info(
        { certificateId, attempt, maxRetries: MAX_RETRIES },
        "Attempting certificate renewal"
      );

      return await this.performRenewal(certificateId, attempt);

    } catch (error) {
      lastError = error;
      this.logger.warn(
        { certificateId, attempt, error: error.message },
        "Renewal attempt failed"
      );

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt - 1];
        this.logger.info({ certificateId, delay }, "Retrying after delay");
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // All retries failed
  throw new Error(
    `Certificate renewal failed after ${MAX_RETRIES} attempts: ${lastError.message}`
  );
}
```

### Renewal Status Tracking

All renewal attempts are logged in `TlsCertificateRenewal` table:

```sql
-- Query renewal history for a certificate
SELECT
  id,
  attemptNumber,
  status,
  startedAt,
  completedAt,
  durationMs,
  errorMessage
FROM TlsCertificateRenewal
WHERE certificateId = 'cert-123'
ORDER BY startedAt DESC;

-- Get success rate for automated renewals
SELECT
  COUNT(*) FILTER (WHERE status = 'COMPLETED') AS successful,
  COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
  AVG(durationMs) FILTER (WHERE status = 'COMPLETED') AS avgDurationMs
FROM TlsCertificateRenewal
WHERE triggeredBy = 'auto-renewal'
  AND startedAt >= NOW() - INTERVAL '30 days';
```

---

## Security Considerations

### 1. Azure Key Vault Authentication

**Recommended: Managed Identity (Production)**

For Azure VMs, Container Instances, or AKS:

```typescript
import { DefaultAzureCredential } from "@azure/identity";

// DefaultAzureCredential tries these in order:
// 1. Environment variables (AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET)
// 2. Managed Identity
// 3. Azure CLI credentials
// 4. Visual Studio Code credentials

const credential = new DefaultAzureCredential();
const keyVaultUrl = "https://my-vault.vault.azure.net/";

const store = new AzureKeyVaultCertificateStore(keyVaultUrl, credential);
```

**Service Principal (Alternative)**

For non-Azure environments:

```bash
# Create service principal with Key Vault access
az ad sp create-for-rbac --name "mini-infra-keyvault" \
  --role "Key Vault Secrets Officer" \
  --scopes "/subscriptions/{sub-id}/resourceGroups/{rg}/providers/Microsoft.KeyVault/vaults/{vault-name}"

# Set environment variables
export AZURE_TENANT_ID="..."
export AZURE_CLIENT_ID="..."
export AZURE_CLIENT_SECRET="..."
```

**RBAC Permissions Required**:
- **Key Vault Secrets Officer**: Full access to secrets (certificates stored as secrets)
- **Key Vault Certificates Officer**: Manage certificate metadata

### 2. ACME Account Key Protection

**Storage Strategy**:
- ACME account private keys stored in Azure Key Vault as secrets
- Never stored in database or filesystem
- Retrieved only when needed for ACME operations
- Key names: `acme-account-{email-sanitized}`

**Access Control**:
- Only `CertificateLifecycleManager` can access account keys
- No API endpoints expose account keys
- Audit logging for all Key Vault access

### 3. Certificate Private Key Handling

**In-Transit Security**:
```typescript
// Private keys only exist in memory during:
// 1. ACME certificate issuance
// 2. Key Vault storage
// 3. HAProxy deployment

// NEVER:
// - Logged
// - Stored in database
// - Returned in API responses
// - Cached in NodeCache
```

**At-Rest Security**:
- All private keys encrypted in Azure Key Vault (FIPS 140-2 Level 2 HSM)
- HAProxy container volume permissions: `0640` (rw-r-----)
- Host filesystem permissions: `0640`, owned by root or haproxy user

### 4. Cloudflare API Token Scoping

**Minimum Required Permissions**:
```
Zone.Zone.Read      # Read zone information
Zone.DNS.Edit       # Create/delete TXT records for DNS-01
```

**Token Best Practices**:
- Create separate token per environment (dev, staging, prod)
- Scope to specific zones only (not all zones)
- Rotate tokens quarterly
- Store in `SystemSettings` table (category: "cloudflare")

### 5. Database Encryption

**Sensitive Fields**:
```typescript
// In TlsConfigService
await this.set("key_vault_client_secret", clientSecret, userId);

// Automatically encrypted using existing encryption service
// Pattern: Same as RegistryCredentialService
```

**Encryption Key**:
- Use `API_KEY_SECRET` environment variable
- DO NOT fall back to hardcoded default
- Validate secret exists on startup

### 6. API Endpoint Authorization

**All TLS routes require authentication**:

```typescript
// File: server/src/routes/tls-certificates.ts

import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";

router.post('/', requireSessionOrApiKey, async (req, res) => {
  const userId = getAuthenticatedUser(req);
  // ... handle request ...
});
```

**Permission Model**:
- All authenticated users can view certificates
- Only admins can issue/renew/revoke certificates (future: RBAC)
- API keys can trigger automated renewals

### 7. Audit Logging

**Logged Events**:
```typescript
// All TLS operations logged to app-tls.log
this.logger.info({
  userId,
  certificateId,
  domains,
  action: "certificate-issued" | "certificate-renewed" | "certificate-revoked",
  timestamp: new Date()
}, "TLS operation completed");
```

**Database Audit Trail**:
- `TlsCertificate.createdBy`, `updatedBy`
- `TlsCertificateRenewal.triggeredBy` (userId or "auto-renewal")
- `ConnectivityStatus.checkInitiatedBy` (for Key Vault health checks)

---

## Testing Strategy

### Unit Tests

**1. ACME Client Manager**

**File**: `server/src/__tests__/services/tls/acme-client-manager.test.ts`

```typescript
describe('AcmeClientManager', () => {
  it('should create ACME account and store key in Key Vault', async () => {
    // Mock Key Vault store
    // Mock acme-client
    // Test account creation flow
  });

  it('should request certificate with DNS-01 challenge', async () => {
    // Mock DNS challenge provider
    // Test certificate request flow
  });

  it('should handle ACME errors gracefully', async () => {
    // Test error scenarios: rate limits, validation failures, etc.
  });
});
```

**2. Azure Key Vault Certificate Store**

**File**: `server/src/__tests__/services/tls/azure-keyvault-certificate-store.test.ts`

```typescript
describe('AzureKeyVaultCertificateStore', () => {
  it('should store certificate and private key as secret', async () => {
    // Mock Azure Key Vault client
    // Test certificate storage
  });

  it('should retrieve certificate with correct version', async () => {
    // Test certificate retrieval
  });

  it('should handle Key Vault errors', async () => {
    // Test error scenarios: not found, unauthorized, etc.
  });
});
```

**3. DNS Challenge Provider**

**File**: `server/src/__tests__/services/tls/dns-challenge-provider.test.ts`

```typescript
describe('DnsChallenge01Provider', () => {
  it('should create TXT record via Cloudflare', async () => {
    // Mock CloudflareConfigService
    // Test DNS record creation
  });

  it('should wait for DNS propagation', async () => {
    // Mock dns.resolveTxt
    // Test propagation wait logic
  });

  it('should remove challenge record after validation', async () => {
    // Test cleanup
  });
});
```

### Integration Tests

**1. End-to-End Certificate Issuance**

**File**: `server/src/__tests__/integration/tls-issuance.integration.test.ts`

```typescript
describe('TLS Certificate Issuance (Integration)', () => {
  beforeAll(async () => {
    // Set up test Azure Key Vault
    // Set up test Cloudflare zone
    // Configure ACME staging environment
  });

  it('should issue certificate from Let\'s Encrypt staging', async () => {
    const domains = ['test.example.com'];

    const cert = await lifecycleManager.issueCertificate({
      domains,
      primaryDomain: domains[0],
      userId: 'test-user',
      deployToHaproxy: false
    });

    expect(cert.status).toBe('ACTIVE');
    expect(cert.domains).toEqual(domains);
    expect(cert.keyVaultCertificateName).toBeTruthy();
  });

  it('should renew certificate before expiry', async () => {
    // Test renewal flow
  });

  afterAll(async () => {
    // Clean up test resources
  });
});
```

**Environment Variables for Integration Tests**:
```bash
RUN_TLS_INTEGRATION_TESTS=true
AZURE_KEYVAULT_URL=https://test-vault.vault.azure.net/
CLOUDFLARE_TEST_ZONE_ID=...
ACME_STAGING=true
```

### API Route Tests

**File**: `server/src/__tests__/routes/tls-certificates.test.ts`

```typescript
import request from 'supertest';
import app from '../../app';

describe('TLS Certificates API', () => {
  it('POST /api/tls/certificates - should create certificate', async () => {
    const response = await request(app)
      .post('/api/tls/certificates')
      .set('Authorization', `Bearer ${testJwt}`)
      .send({
        domains: ['test.example.com'],
        primaryDomain: 'test.example.com',
        autoRenew: true
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.domains).toEqual(['test.example.com']);
  });

  it('GET /api/tls/certificates - should list all certificates', async () => {
    const response = await request(app)
      .get('/api/tls/certificates')
      .set('Authorization', `Bearer ${testJwt}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(Array.isArray(response.body.data)).toBe(true);
  });

  it('POST /api/tls/certificates/:id/renew - should trigger renewal', async () => {
    const response = await request(app)
      .post(`/api/tls/certificates/${testCertId}/renew`)
      .set('Authorization', `Bearer ${testJwt}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
```

---

## Deployment & Configuration

### 1. Environment Variables

**Required for Production**:

```bash
# Azure Key Vault Authentication (Service Principal)
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-client-id
AZURE_CLIENT_SECRET=your-client-secret

# ACME Configuration (via UI, not env vars)
# - Key Vault URL
# - ACME provider (letsencrypt, letsencrypt-staging)
# - ACME email
# - Renewal cron schedule
```

**Optional**:

```bash
# Let's Encrypt Staging (for testing)
ACME_STAGING=true

# Custom renewal schedule
TLS_RENEWAL_CRON="0 2 * * *"  # Daily at 2 AM

# Key Vault timeout
AZURE_KEYVAULT_TIMEOUT=15000  # 15 seconds
```

### 2. Azure Key Vault Setup

**Create Key Vault**:

```bash
# Create resource group
az group create --name mini-infra-rg --location eastus

# Create Key Vault
az keyvault create \
  --name mini-infra-kv \
  --resource-group mini-infra-rg \
  --location eastus \
  --enable-rbac-authorization

# Create service principal
az ad sp create-for-rbac \
  --name mini-infra-tls \
  --role "Key Vault Secrets Officer" \
  --scopes "/subscriptions/{sub-id}/resourceGroups/mini-infra-rg/providers/Microsoft.KeyVault/vaults/mini-infra-kv"

# Output:
# {
#   "appId": "...",        # AZURE_CLIENT_ID
#   "password": "...",     # AZURE_CLIENT_SECRET
#   "tenant": "..."        # AZURE_TENANT_ID
# }
```

**Grant Permissions**:

```bash
# Get service principal object ID
SP_OBJECT_ID=$(az ad sp show --id {appId} --query objectId -o tsv)

# Assign Key Vault Secrets Officer role
az role assignment create \
  --role "Key Vault Secrets Officer" \
  --assignee-object-id $SP_OBJECT_ID \
  --scope "/subscriptions/{sub-id}/resourceGroups/mini-infra-rg/providers/Microsoft.KeyVault/vaults/mini-infra-kv"
```

### 3. Cloudflare Configuration

**API Token Setup** (via Cloudflare dashboard):

1. Navigate to: `Profile → API Tokens → Create Token`
2. Use "Edit zone DNS" template
3. Permissions:
   - Zone → Zone → Read
   - Zone → DNS → Edit
4. Zone Resources:
   - Include → Specific zone → `example.com`
5. Copy token and configure via Mini Infra UI

**Cloudflare Settings** (via Mini Infra UI):

Navigate to: `Settings → Cloudflare` and configure:
- API Token: `[paste token]`
- Email: `admin@example.com`
- Zone ID: `[from Cloudflare dashboard]`

### 4. HAProxy Configuration

**Update HAProxy Config**:

**File**: `server/docker-compose/haproxy/haproxy.cfg`

```haproxy
global
    # Enable Runtime API for zero-downtime certificate updates
    stats socket /var/run/haproxy/admin.sock mode 660 level admin expose-fd listeners
    tune.ssl.default-dh-param 2048
    ssl-default-bind-ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256
    ssl-default-bind-options ssl-min-ver TLSv1.2

defaults
    mode http
    timeout connect 5000
    timeout client  50000
    timeout server  50000

frontend fe_http
    bind *:80
    # Redirect HTTP to HTTPS
    http-request redirect scheme https code 301 if !{ ssl_fc }

frontend fe_https
    # Load all certificates from directory (SNI-based routing)
    bind *:443 ssl crt /etc/haproxy/certs/ alpn h2,http/1.1

    # Use SNI to route to correct backend
    use_backend %[ssl_fc_sni,lower,map_dom(/etc/haproxy/domain-backend.map)]

    default_backend default_backend

backend default_backend
    server default 127.0.0.1:8080

# Stats frontend (optional)
frontend stats
    bind *:8404
    stats enable
    stats uri /stats
    stats refresh 10s
```

**Domain-Backend Mapping**:

**File**: `server/docker-compose/haproxy/domain-backend.map`

```
# Domain to backend mapping
example.com           backend_example
www.example.com       backend_example
api.example.com       backend_api
```

**Docker Compose Volume Configuration**:

```yaml
# File: server/docker-compose/haproxy/docker-compose.yml

version: '3.8'

services:
  haproxy:
    image: haproxy:3.2
    container_name: haproxy
    labels:
      - "mini-infra.service=haproxy"
    volumes:
      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
      - ./domain-backend.map:/etc/haproxy/domain-backend.map:ro
      - haproxy-certs:/etc/haproxy/certs:ro
      - haproxy-socket:/var/run/haproxy
    ports:
      - "80:80"
      - "443:443"
      - "8404:8404"
      - "5555:5555"
    restart: unless-stopped

volumes:
  haproxy-certs:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /var/lib/mini-infra/haproxy/certs
  haproxy-socket:
```

**Create Certificate Directory**:

```bash
# On host machine
sudo mkdir -p /var/lib/mini-infra/haproxy/certs
sudo chmod 750 /var/lib/mini-infra/haproxy/certs
sudo chown root:haproxy /var/lib/mini-infra/haproxy/certs
```

### 5. Initial Configuration (UI)

**TLS Settings** (`/settings/tls`):

1. **Azure Key Vault Configuration**:
   - Key Vault URL: `https://mini-infra-kv.vault.azure.net/`
   - Tenant ID: `[from service principal]`
   - Client ID: `[from service principal]`
   - Client Secret: `[from service principal]`
   - **Test Connection** to validate

2. **ACME Configuration**:
   - Provider: `Let's Encrypt Production`
   - Email: `admin@example.com`
   - Terms of Service: ✓ Agree

3. **Renewal Settings**:
   - Auto-Renewal: ✓ Enabled
   - Renewal Days Before Expiry: `30`
   - Renewal Check Schedule: `0 2 * * *` (Daily at 2 AM)

4. **Save Settings**

### 6. Database Migration

**Run Prisma Migration**:

```bash
cd server

# Create migration
npx prisma migrate dev --name add_tls_certificate_models

# Or for production
npx prisma migrate deploy
```

**Verify Migration**:

```bash
npx prisma studio

# Check tables: TlsCertificate, TlsCertificateRenewal, AcmeAccount
```

---

## Monitoring & Alerting

### 1. Certificate Expiration Monitoring

**Health Check Endpoint**:

**File**: `server/src/routes/tls-certificates.ts`

```typescript
router.get('/health', requireSessionOrApiKey, async (req, res) => {
  const now = new Date();

  // Find certificates expiring soon
  const expiringCertificates = await prisma.tlsCertificate.findMany({
    where: {
      notAfter: {
        lte: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000) // 14 days
      },
      status: "ACTIVE"
    },
    select: {
      id: true,
      primaryDomain: true,
      domains: true,
      notAfter: true,
      status: true
    }
  });

  const criticalCertificates = expiringCertificates.filter(cert => {
    const daysUntilExpiry = Math.floor(
      (cert.notAfter.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
    );
    return daysUntilExpiry <= 7;
  });

  res.json({
    success: true,
    data: {
      healthy: criticalCertificates.length === 0,
      expiringCertificates: expiringCertificates.map(cert => ({
        ...cert,
        daysUntilExpiry: Math.floor(
          (cert.notAfter.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
        )
      })),
      criticalCount: criticalCertificates.length
    }
  });
});
```

**Prometheus Metrics** (future enhancement):

```typescript
// server/src/lib/metrics.ts

import { Registry, Gauge } from 'prom-client';

const register = new Registry();

export const certificateExpiryGauge = new Gauge({
  name: 'tls_certificate_expiry_seconds',
  help: 'Seconds until TLS certificate expiry',
  labelNames: ['domain', 'certificate_id'],
  registers: [register]
});

// Update metrics periodically
async function updateCertificateMetrics() {
  const certificates = await prisma.tlsCertificate.findMany({
    where: { status: "ACTIVE" }
  });

  certificates.forEach(cert => {
    const secondsUntilExpiry = Math.floor(
      (cert.notAfter.getTime() - Date.now()) / 1000
    );

    certificateExpiryGauge.set(
      { domain: cert.primaryDomain, certificate_id: cert.id },
      secondsUntilExpiry
    );
  });
}

setInterval(updateCertificateMetrics, 60000); // Every minute
```

### 2. Renewal Success/Failure Tracking

**Metrics Endpoint**:

```typescript
router.get('/metrics', requireSessionOrApiKey, async (req, res) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const renewalMetrics = await prisma.tlsCertificateRenewal.groupBy({
    by: ['status'],
    where: {
      startedAt: { gte: thirtyDaysAgo }
    },
    _count: {
      status: true
    },
    _avg: {
      durationMs: true
    }
  });

  res.json({
    success: true,
    data: {
      period: "last_30_days",
      renewals: renewalMetrics,
      successRate: calculateSuccessRate(renewalMetrics)
    }
  });
});
```

### 3. Alert Notifications

**Webhook Integration** (future enhancement):

```typescript
// server/src/services/tls/alerts.ts

export class TlsAlertService {
  async sendExpiryWarning(certificate: TlsCertificate, daysUntilExpiry: number) {
    const severity = daysUntilExpiry <= 2 ? 'critical' :
                     daysUntilExpiry <= 7 ? 'warning' : 'info';

    await fetch(process.env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `TLS Certificate Expiring Soon: ${certificate.primaryDomain}`,
        severity: severity,
        details: {
          domains: certificate.domains,
          expiryDate: certificate.notAfter,
          daysUntilExpiry: daysUntilExpiry,
          certificateId: certificate.id
        },
        timestamp: new Date().toISOString()
      })
    });
  }

  async sendRenewalFailure(certificate: TlsCertificate, error: Error) {
    await fetch(process.env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `TLS Certificate Renewal Failed: ${certificate.primaryDomain}`,
        severity: 'critical',
        details: {
          domains: certificate.domains,
          error: error.message,
          certificateId: certificate.id
        },
        timestamp: new Date().toISOString()
      })
    });
  }
}
```

**Integration with Renewal Scheduler**:

```typescript
// In CertificateRenewalScheduler.checkRenewals()

for (const cert of certificates) {
  try {
    await this.processCertificateRenewal(cert);
  } catch (error) {
    // Send alert
    await alertService.sendRenewalFailure(cert, error);
  }
}
```

### 4. Logging and Observability

**Structured Logging** (already implemented):

```typescript
// All TLS operations logged to app-tls.log
this.logger.info({
  operation: "certificate-issued",
  certificateId: cert.id,
  domains: cert.domains,
  acmeProvider: "letsencrypt",
  durationMs: renewalDurationMs,
  keyVaultVersion: keyVaultVersion
}, "Certificate issued successfully");

this.logger.error({
  operation: "certificate-renewal-failed",
  certificateId: cert.id,
  domains: cert.domains,
  attemptNumber: 3,
  error: error.message,
  errorCode: error.code
}, "Certificate renewal failed after max retries");
```

**Log Analysis Queries**:

```bash
# Find all failed renewals in last 7 days
cat server/logs/app-tls.log | grep '"operation":"certificate-renewal-failed"' | grep "$(date -d '7 days ago' '+%Y-%m-%d')"

# Calculate average renewal duration
cat server/logs/app-tls.log | grep '"operation":"certificate-issued"' | jq '.durationMs' | awk '{sum+=$1; count++} END {print sum/count}'
```

---

## Implementation Phases

### Phase 1: Core Infrastructure (Week 1-2)

**Goal**: Set up foundation for TLS management

**Tasks**:

1. ✅ **Database Schema**:
   - Create Prisma models: `TlsCertificate`, `TlsCertificateRenewal`, `AcmeAccount`
   - Add `SettingsCategory` enum value: `"tls"`
   - Run migrations

2. ✅ **Service Layer Foundation**:
   - Create `TlsConfigService` (extends `ConfigurationService`)
   - Update `ConfigurationFactory` to include "tls" case
   - Add TLS domain logger to `logger-factory.ts`

3. ✅ **Azure Key Vault Integration**:
   - Install dependencies: `@azure/keyvault-certificates`, `@azure/keyvault-secrets`, `@azure/identity`
   - Implement `AzureKeyVaultCertificateStore`
   - Create unit tests for Key Vault operations
   - Set up Azure Key Vault in Azure Portal
   - Configure service principal authentication

4. ✅ **API Routes (Basic CRUD)**:
   - Create `tls-settings.ts` route (Key Vault configuration)
   - Create `tls-connectivity.ts` route (Key Vault health checks)
   - Register routes in `app.ts`

**Deliverables**:
- Database schema deployed
- Azure Key Vault connectivity tested
- Basic TLS settings UI working
- Key Vault health checks passing

---

### Phase 2: ACME Client Integration (Week 3-4)

**Goal**: Certificate issuance via Let's Encrypt

**Tasks**:

1. ✅ **ACME Client Manager**:
   - Install `acme-client` dependency
   - Implement `AcmeClientManager`
   - Create ACME account creation flow
   - Test with Let's Encrypt staging environment

2. ✅ **DNS Challenge Provider**:
   - Implement `DnsChallenge01Provider`
   - Integrate with existing `CloudflareConfigService`
   - Add DNS record creation/deletion methods to Cloudflare service
   - Test DNS propagation wait logic

3. ✅ **Certificate Lifecycle Manager**:
   - Implement `CertificateLifecycleManager`
   - Certificate issuance flow
   - Certificate parsing utilities (`node-forge`)
   - Integration tests for end-to-end issuance

4. ✅ **API Routes (Issuance)**:
   - Create `tls-certificates.ts` route
   - POST `/api/tls/certificates` - Issue certificate
   - GET `/api/tls/certificates` - List certificates
   - GET `/api/tls/certificates/:id` - Get certificate details
   - Unit tests for routes

**Deliverables**:
- Certificate issuance working end-to-end
- DNS-01 challenge validated with Cloudflare
- Certificates stored in Azure Key Vault
- Basic certificate management UI

---

### Phase 3: HAProxy Integration (Week 5)

**Goal**: Deploy certificates to HAProxy containers

**Tasks**:

1. ✅ **Certificate Distributor**:
   - Implement `CertificateDistributor`
   - HAProxy Runtime API integration
   - Certificate volume mounting
   - Zero-downtime certificate updates

2. ✅ **HAProxy Service Updates**:
   - Add `reloadCertificate()` method to `HAProxyService`
   - Implement Runtime API command execution
   - Update HAProxy configuration to load certificates from directory

3. ✅ **Docker Compose Configuration**:
   - Update HAProxy `docker-compose.yml` with certificate volumes
   - Create certificate directory on host (`/var/lib/mini-infra/haproxy/certs`)
   - Update `haproxy.cfg` with SSL binding configuration

4. ✅ **Integration Testing**:
   - Test certificate deployment to HAProxy
   - Verify HTTPS connections work
   - Test certificate updates (Runtime API)

**Deliverables**:
- Certificates deployed to HAProxy successfully
- HTTPS traffic working with Let's Encrypt certificates
- Zero-downtime certificate updates verified

---

### Phase 4: Renewal Automation (Week 6)

**Goal**: Automated certificate renewal

**Tasks**:

1. ✅ **Renewal Scheduler**:
   - Implement `CertificateRenewalScheduler`
   - Cron-based renewal checks
   - Renewal logic in `CertificateLifecycleManager`
   - Retry logic for failed renewals

2. ✅ **Server Integration**:
   - Initialize scheduler in `server.ts`
   - Graceful shutdown on SIGTERM
   - Configuration via system settings

3. ✅ **Renewal History Tracking**:
   - Record all renewal attempts in `TlsCertificateRenewal`
   - Track success/failure rates
   - Store detailed error information

4. ✅ **API Routes (Renewal)**:
   - POST `/api/tls/certificates/:id/renew` - Manual renewal trigger
   - GET `/api/tls/renewals` - Renewal history
   - GET `/api/tls/renewals/:id` - Renewal details

**Deliverables**:
- Automated renewal working on schedule
- Manual renewal triggers working
- Renewal history visible in UI
- Alert notifications on renewal failures

---

### Phase 5: Frontend UI (Week 7)

**Goal**: User interface for certificate management

**Tasks**:

1. ✅ **Certificate Management Pages**:
   - `/certificates` - Certificate list/dashboard
   - `/certificates/create` - Create new certificate form
   - `/certificates/:id` - Certificate details page
   - `/certificates/:id/renew` - Manual renewal page

2. ✅ **React Components**:
   - `CertificateList` - Table with status badges
   - `CertificateForm` - Domain input, auto-renewal toggle
   - `CertificateDetailsCard` - Expiry dates, Key Vault info
   - `RenewalHistoryTable` - Renewal attempt history
   - `CertificateStatusBadge` - Visual status indicators

3. ✅ **React Query Hooks**:
   - `useCertificates()` - Fetch certificate list
   - `useCertificate(id)` - Fetch certificate details
   - `useCreateCertificate()` - Issue new certificate
   - `useRenewCertificate(id)` - Trigger renewal
   - `useRenewalHistory(certificateId)` - Fetch renewal history

4. ✅ **Settings Pages**:
   - `/settings/tls` - TLS configuration (Key Vault, ACME)
   - Connectivity status display
   - Test connection button

**Deliverables**:
- Full certificate management UI
- Certificate creation workflow
- Renewal history visualization
- TLS settings configuration UI

---

### Phase 6: Monitoring & Alerts (Week 8)

**Goal**: Observability and alerting

**Tasks**:

1. ✅ **Health Check Endpoints**:
   - GET `/api/tls/certificates/health` - Expiring certificates check
   - GET `/api/tls/metrics` - Renewal success rate, average duration

2. ✅ **Alert Service**:
   - Implement `TlsAlertService`
   - Webhook notifications for:
     - Certificates expiring soon (14, 7, 2 days)
     - Renewal failures
     - Key Vault connectivity issues

3. ✅ **Prometheus Metrics** (optional):
   - `tls_certificate_expiry_seconds` gauge
   - `tls_renewal_duration_seconds` histogram
   - `tls_renewal_success_total` counter
   - `tls_renewal_failure_total` counter

4. ✅ **Dashboard Widgets**:
   - Certificate expiry timeline
   - Renewal success rate chart
   - Recent renewal activity

**Deliverables**:
- Health monitoring working
- Alert notifications sent for critical events
- Metrics exposed for external monitoring
- Dashboard with TLS health overview

---

### Phase 7: Testing & Documentation (Week 9)

**Goal**: Comprehensive testing and documentation

**Tasks**:

1. ✅ **Unit Test Coverage**:
   - All TLS services (>80% coverage)
   - All API routes
   - Mock external dependencies (ACME, Key Vault, Cloudflare)

2. ✅ **Integration Tests**:
   - End-to-end certificate issuance (staging environment)
   - Certificate renewal flow
   - HAProxy deployment
   - Failure scenarios and rollback

3. ✅ **Documentation**:
   - User guide for certificate management
   - Admin guide for TLS configuration
   - API documentation
   - Troubleshooting guide

4. ✅ **Security Audit**:
   - Review private key handling
   - Validate encryption at rest and in transit
   - Test RBAC and authorization
   - Penetration testing of API endpoints

**Deliverables**:
- Test coverage >80%
- Integration tests passing
- Complete documentation
- Security audit report

---

### Phase 8: Production Deployment (Week 10)

**Goal**: Deploy to production

**Tasks**:

1. ✅ **Production Environment Setup**:
   - Azure Key Vault configuration
   - Service principal with minimal permissions
   - Cloudflare API token with scoped access
   - Let's Encrypt production account

2. ✅ **Migration Plan**:
   - Database migration execution
   - HAProxy configuration updates
   - Certificate directory creation
   - Initial certificate issuance

3. ✅ **Monitoring Setup**:
   - Configure alert webhooks
   - Set up Prometheus metrics scraping (if applicable)
   - Health check integration with uptime monitoring

4. ✅ **Post-Deployment Validation**:
   - Verify certificate issuance
   - Test automated renewal
   - Validate HTTPS traffic
   - Monitor logs for errors

5. ✅ **Rollback Plan**:
   - Database rollback scripts
   - HAProxy configuration rollback
   - Emergency certificate deployment procedure

**Deliverables**:
- Production deployment successful
- All certificates issued and deployed
- Monitoring and alerts active
- Rollback plan documented and tested

---

## Success Criteria

### Functional Requirements

- ✅ Users can request Let's Encrypt certificates via UI
- ✅ Certificates automatically renew 30 days before expiry
- ✅ Certificates stored securely in Azure Key Vault
- ✅ Certificates deployed to HAProxy with zero downtime
- ✅ DNS-01 challenges work via Cloudflare
- ✅ Support for wildcard certificates (`*.example.com`)
- ✅ Manual renewal trigger available
- ✅ Renewal history tracked in database

### Non-Functional Requirements

- ✅ Certificate issuance completes in <5 minutes
- ✅ Zero downtime during certificate updates (Runtime API)
- ✅ Automated renewals run daily at 2 AM
- ✅ Failed renewals retry up to 3 times with exponential backoff
- ✅ All TLS operations logged to `app-tls.log`
- ✅ Health check endpoint responds in <1 second
- ✅ Test coverage >80% for TLS services

### Security Requirements

- ✅ Private keys never logged or exposed in API responses
- ✅ All private keys encrypted in Azure Key Vault (FIPS 140-2 Level 2)
- ✅ ACME account keys stored only in Key Vault
- ✅ Cloudflare API token scoped to specific zones
- ✅ All API endpoints require authentication
- ✅ Audit trail for all certificate operations
- ✅ Certificate files on host have permissions `0640`

---

## Conclusion

This implementation plan provides a comprehensive roadmap for building a production-ready TLS certificate renewal service for the Mini Infra application. The service integrates seamlessly with existing architecture patterns, leverages Azure Key Vault for secure certificate storage, and provides zero-downtime certificate updates to HAProxy containers.

**Key Benefits**:

1. **Security**: All private keys stored in Azure Key Vault with FIPS 140-2 Level 2 encryption
2. **Automation**: Automated renewal 30 days before expiry with retry logic
3. **Zero Downtime**: HAProxy Runtime API enables certificate updates without service interruption
4. **Observability**: Comprehensive logging, metrics, and alerting
5. **Flexibility**: Support for multiple domains, wildcard certificates, and manual renewals
6. **Integration**: Seamless integration with existing services (Azure, Cloudflare, HAProxy)

**Next Steps**:

1. Review and approve this implementation plan
2. Begin Phase 1 implementation (Core Infrastructure)
3. Set up Azure Key Vault and service principal
4. Create development environment with Let's Encrypt staging
5. Iterate through phases with testing and validation

---

**Document Version**: 1.0
**Created**: 2025-11-08
**Author**: Claude (Anthropic)
**Status**: Draft - Pending Review
