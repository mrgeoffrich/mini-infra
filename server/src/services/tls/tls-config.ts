import prisma, { PrismaClient } from "../../lib/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
} from "@mini-infra/types";
import { ConfigurationService } from "../configuration-base";
import { servicesLogger } from "../../lib/logger-factory";
import { CertificateClient } from "@azure/keyvault-certificates";
import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential, ClientSecretCredential } from "@azure/identity";

/**
 * TLS Configuration Service Settings Keys
 */
const TLS_SETTINGS_KEYS = {
  KEY_VAULT_URL: "key_vault_url",
  KEY_VAULT_TENANT_ID: "key_vault_tenant_id",
  KEY_VAULT_CLIENT_ID: "key_vault_client_id",
  KEY_VAULT_CLIENT_SECRET: "key_vault_client_secret",
  DEFAULT_ACME_PROVIDER: "default_acme_provider",
  DEFAULT_ACME_EMAIL: "default_acme_email",
  RENEWAL_CHECK_CRON: "renewal_check_cron",
  RENEWAL_DAYS_BEFORE_EXPIRY: "renewal_days_before_expiry",
} as const;

/**
 * ACME Provider types
 */
export type AcmeProvider = "letsencrypt" | "letsencrypt-staging" | "buypass" | "zerossl";

/**
 * Key Vault Clients Interface
 */
export interface KeyVaultClients {
  certificateClient: CertificateClient;
  secretClient: SecretClient;
}

/**
 * ACME Account Configuration
 */
export interface AcmeAccountConfig {
  email: string;
  provider: AcmeProvider;
}

/**
 * TlsConfigService handles TLS-related configuration management
 * Extends the base ConfigurationService to provide TLS-specific functionality
 */
export class TlsConfigService extends ConfigurationService {
  private static readonly DEFAULT_RENEWAL_CRON = "0 2 * * *"; // Daily at 2 AM
  private static readonly DEFAULT_RENEWAL_DAYS = 30;
  private static readonly DEFAULT_ACME_PROVIDER: AcmeProvider = "letsencrypt";
  private static readonly TIMEOUT_MS = 15000; // 15 seconds

  constructor(prisma: PrismaClient) {
    super(prisma, "tls");
  }

  /**
   * Validate Azure Key Vault connectivity
   * @param settings - Optional settings to validate with (overrides stored settings)
   * @returns Validation result with connectivity status
   */
  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    const startTime = Date.now();
    const logger = servicesLogger();

    try {
      // Get Key Vault URL (from provided settings or database)
      const keyVaultUrl = settings?.[TLS_SETTINGS_KEYS.KEY_VAULT_URL]
        || await this.get(TLS_SETTINGS_KEYS.KEY_VAULT_URL);

      if (!keyVaultUrl) {
        return {
          isValid: false,
          message: "Azure Key Vault URL not configured",
          errorCode: "KEY_VAULT_URL_MISSING",
        };
      }

      // Validate URL format
      if (!keyVaultUrl.match(/^https:\/\/[a-zA-Z0-9-]+\.vault\.azure\.net\/?$/)) {
        return {
          isValid: false,
          message: "Invalid Azure Key Vault URL format",
          errorCode: "INVALID_KEY_VAULT_URL",
        };
      }

      // Get credentials
      const tenantId = settings?.[TLS_SETTINGS_KEYS.KEY_VAULT_TENANT_ID]
        || await this.get(TLS_SETTINGS_KEYS.KEY_VAULT_TENANT_ID);
      const clientId = settings?.[TLS_SETTINGS_KEYS.KEY_VAULT_CLIENT_ID]
        || await this.get(TLS_SETTINGS_KEYS.KEY_VAULT_CLIENT_ID);
      const clientSecret = settings?.[TLS_SETTINGS_KEYS.KEY_VAULT_CLIENT_SECRET]
        || await this.get(TLS_SETTINGS_KEYS.KEY_VAULT_CLIENT_SECRET);

      // Create credential
      let credential;
      if (tenantId && clientId && clientSecret) {
        credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
      } else {
        // Fall back to default credential (environment variables, managed identity, etc.)
        credential = new DefaultAzureCredential();
      }

      // Test connectivity by listing secrets (lightweight operation)
      const { secretClient } = await this.createKeyVaultClients(keyVaultUrl, credential);

      const secrets = secretClient.listPropertiesOfSecrets();

      // Attempt to get first page of secrets (validates authentication and connectivity)
      const firstPage = await secrets.next();

      const responseTime = Date.now() - startTime;

      // Record successful connectivity
      await this.recordConnectivityStatus(
        "connected",
        responseTime,
        undefined,
        undefined,
        { keyVaultUrl }
      );

      logger.info(
        {
          keyVaultUrl,
          responseTime,
        },
        "Azure Key Vault validation successful"
      );

      return {
        isValid: true,
        message: "Azure Key Vault connection successful",
        responseTimeMs: responseTime,
        metadata: {
          keyVaultUrl,
          hasCredentials: !!(tenantId && clientId && clientSecret),
        },
      };
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      const errorMessage = error.message || "Unknown error";
      const errorCode = error.code || "UNKNOWN_ERROR";

      // Record failed connectivity
      await this.recordConnectivityStatus(
        "failed",
        responseTime,
        errorMessage,
        errorCode
      );

      logger.error(
        {
          error: errorMessage,
          errorCode,
          responseTime,
        },
        "Azure Key Vault validation failed"
      );

      return {
        isValid: false,
        message: `Azure Key Vault validation failed: ${errorMessage}`,
        errorCode,
        responseTimeMs: responseTime,
      };
    }
  }

  /**
   * Get health status of Azure Key Vault connectivity
   * @returns Service health status
   */
  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.getLatestConnectivityStatus();

    if (!latestStatus) {
      return {
        service: "tls",
        status: "unreachable",
        lastChecked: new Date(),
        errorMessage: "No connectivity checks performed yet",
      };
    }

    return {
      service: "tls",
      status: latestStatus.status as ConnectivityStatusType,
      lastChecked: latestStatus.checkedAt,
      lastSuccessful: latestStatus.lastSuccessfulAt || undefined,
      responseTime: latestStatus.responseTimeMs ? Number(latestStatus.responseTimeMs) : undefined,
      errorMessage: latestStatus.errorMessage || undefined,
      errorCode: latestStatus.errorCode || undefined,
      metadata: latestStatus.metadata ? JSON.parse(latestStatus.metadata) : undefined,
    };
  }

  /**
   * Get Azure Key Vault clients
   * @returns Certificate and Secret clients
   */
  async getKeyVaultClients(): Promise<KeyVaultClients> {
    const keyVaultUrl = await this.get(TLS_SETTINGS_KEYS.KEY_VAULT_URL);

    if (!keyVaultUrl) {
      throw new Error("Azure Key Vault URL not configured");
    }

    // Get credentials
    const tenantId = await this.get(TLS_SETTINGS_KEYS.KEY_VAULT_TENANT_ID);
    const clientId = await this.get(TLS_SETTINGS_KEYS.KEY_VAULT_CLIENT_ID);
    const clientSecret = await this.get(TLS_SETTINGS_KEYS.KEY_VAULT_CLIENT_SECRET);

    // Create credential
    let credential;
    if (tenantId && clientId && clientSecret) {
      credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    } else {
      // Fall back to default credential
      credential = new DefaultAzureCredential();
    }

    return this.createKeyVaultClients(keyVaultUrl, credential);
  }

  /**
   * Get ACME account configuration
   * @returns ACME account configuration
   */
  async getAcmeAccountConfig(): Promise<AcmeAccountConfig> {
    const email = await this.get(TLS_SETTINGS_KEYS.DEFAULT_ACME_EMAIL);
    const providerStr = await this.get(TLS_SETTINGS_KEYS.DEFAULT_ACME_PROVIDER);

    if (!email) {
      throw new Error("ACME email not configured");
    }

    const provider = (providerStr as AcmeProvider) || TlsConfigService.DEFAULT_ACME_PROVIDER;

    return {
      email,
      provider,
    };
  }

  /**
   * Get renewal check cron schedule
   * @returns Cron expression
   */
  async getRenewalCheckCron(): Promise<string> {
    const cron = await this.get(TLS_SETTINGS_KEYS.RENEWAL_CHECK_CRON);
    return cron || TlsConfigService.DEFAULT_RENEWAL_CRON;
  }

  /**
   * Get renewal days before expiry
   * @returns Number of days before expiry to renew
   */
  async getRenewalDaysBeforeExpiry(): Promise<number> {
    const days = await this.get(TLS_SETTINGS_KEYS.RENEWAL_DAYS_BEFORE_EXPIRY);
    return days ? parseInt(days, 10) : TlsConfigService.DEFAULT_RENEWAL_DAYS;
  }

  /**
   * Create Key Vault clients with given URL and credential
   * @private
   */
  private async createKeyVaultClients(
    keyVaultUrl: string,
    credential: any
  ): Promise<KeyVaultClients> {
    const certificateClient = new CertificateClient(keyVaultUrl, credential);
    const secretClient = new SecretClient(keyVaultUrl, credential);

    return {
      certificateClient,
      secretClient,
    };
  }

  /**
   * Helper method to set Key Vault URL
   */
  async setKeyVaultUrl(url: string, userId: string): Promise<void> {
    await this.set(TLS_SETTINGS_KEYS.KEY_VAULT_URL, url, userId);
  }

  /**
   * Helper method to set Key Vault credentials
   */
  async setKeyVaultCredentials(
    tenantId: string,
    clientId: string,
    clientSecret: string,
    userId: string
  ): Promise<void> {
    await this.set(TLS_SETTINGS_KEYS.KEY_VAULT_TENANT_ID, tenantId, userId);
    await this.set(TLS_SETTINGS_KEYS.KEY_VAULT_CLIENT_ID, clientId, userId);
    await this.set(TLS_SETTINGS_KEYS.KEY_VAULT_CLIENT_SECRET, clientSecret, userId);
  }

  /**
   * Helper method to set ACME configuration
   */
  async setAcmeConfig(
    email: string,
    provider: AcmeProvider,
    userId: string
  ): Promise<void> {
    await this.set(TLS_SETTINGS_KEYS.DEFAULT_ACME_EMAIL, email, userId);
    await this.set(TLS_SETTINGS_KEYS.DEFAULT_ACME_PROVIDER, provider, userId);
  }

  /**
   * Helper method to set renewal configuration
   */
  async setRenewalConfig(
    cronSchedule: string,
    daysBeforeExpiry: number,
    userId: string
  ): Promise<void> {
    await this.set(TLS_SETTINGS_KEYS.RENEWAL_CHECK_CRON, cronSchedule, userId);
    await this.set(TLS_SETTINGS_KEYS.RENEWAL_DAYS_BEFORE_EXPIRY, daysBeforeExpiry.toString(), userId);
  }
}
