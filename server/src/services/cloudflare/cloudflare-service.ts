import prisma, { PrismaClient } from "../../lib/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
} from "@mini-infra/types";
import { ConfigurationService } from "../configuration-base";
import { servicesLogger } from "../../lib/logger-factory";
import Cloudflare from "cloudflare";
import { CircuitBreaker, ErrorMapper } from "../circuit-breaker";
import { toServiceError } from "../../lib/service-error-mapper";

/**
 * Cloudflare-specific error mappers for the circuit breaker.
 * Order matters: HTTP status code checks come first, then message-based checks.
 */
const CLOUDFLARE_ERROR_MAPPERS: ErrorMapper[] = [
  // HTTP status code matchers (checked via predicate)
  {
    pattern: (error: unknown) =>
      (error as any)?.response?.status === 401 ||
      (error as any)?.status === 401,
    errorCode: "INVALID_API_TOKEN",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: (error: unknown) =>
      (error as any)?.response?.status === 403 ||
      (error as any)?.status === 403,
    errorCode: "INSUFFICIENT_PERMISSIONS",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: (error: unknown) =>
      (error as any)?.response?.status === 429 ||
      (error as any)?.status === 429,
    errorCode: "RATE_LIMITED",
    connectivityStatus: "failed",
    isRetriable: true,
  },
  {
    pattern: (error: unknown) =>
      (error as any)?.response?.status === 500 ||
      (error as any)?.status === 500,
    errorCode: "SERVER_ERROR_500",
    connectivityStatus: "failed",
    isRetriable: true,
  },
  {
    pattern: (error: unknown) =>
      (error as any)?.response?.status === 502 ||
      (error as any)?.status === 502,
    errorCode: "SERVER_ERROR_502",
    connectivityStatus: "failed",
    isRetriable: true,
  },
  {
    pattern: (error: unknown) =>
      (error as any)?.response?.status === 503 ||
      (error as any)?.status === 503,
    errorCode: "SERVER_ERROR_503",
    connectivityStatus: "failed",
    isRetriable: true,
  },
  {
    pattern: (error: unknown) =>
      (error as any)?.response?.status === 504 ||
      (error as any)?.status === 504,
    errorCode: "SERVER_ERROR_504",
    connectivityStatus: "failed",
    isRetriable: true,
  },
  // Message-based matchers
  {
    pattern: /timeout/,
    errorCode: "TIMEOUT",
    connectivityStatus: "timeout",
    isRetriable: true,
  },
  {
    pattern: /Unauthorized|Invalid API Token/,
    errorCode: "INVALID_API_TOKEN",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: /Forbidden/,
    errorCode: "INSUFFICIENT_PERMISSIONS",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: /ENOTFOUND|ECONNREFUSED/,
    errorCode: "NETWORK_ERROR",
    connectivityStatus: "unreachable",
    isRetriable: true,
  },
  {
    pattern: /Rate limit/,
    errorCode: "RATE_LIMITED",
    connectivityStatus: "failed",
    isRetriable: true,
  },
];

/**
 * CloudflareService handles Cloudflare API configuration management
 * Extends the base ConfigurationService to provide Cloudflare-specific functionality
 * Implements circuit breaker pattern for resilient API communication
 */
export class CloudflareService extends ConfigurationService {
  private static readonly TIMEOUT_MS = 10000; // 10 second timeout
  private static readonly API_TOKEN_KEY = "api_token";
  private static readonly ACCOUNT_ID_KEY = "account_id";

  private circuitBreaker: CircuitBreaker;

  constructor(prisma: PrismaClient) {
    super(prisma, "cloudflare");

    this.circuitBreaker = new CircuitBreaker({
      serviceName: "Cloudflare",
      failureThreshold: 5,
      cooldownPeriodMs: 5 * 60 * 1000,
      dedupWindowMs: 1000,
      errorMappers: CLOUDFLARE_ERROR_MAPPERS,
      defaultErrorCode: "CLOUDFLARE_API_ERROR",
      tokenRedactPatterns: [/[a-zA-Z0-9_-]{40,}/g],
      sensitiveKeys: [
        "apiToken",
        "api_token",
        "token",
        "secret",
        "password",
        "key",
      ],
    });
  }

  /**
   * Validate Cloudflare API configuration by testing API connectivity
   * Implements circuit breaker pattern and request deduplication
   * @param settings - Optional settings to validate with (overrides stored settings)
   * @returns ValidationResult with connectivity status and details
   */
  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    return this.circuitBreaker.validateWithDedup(
      (startTime, s) => this.performValidation(startTime, s),
      settings,
    );
  }

  /**
   * Check if an error indicates a permission/auth issue (401/403/Forbidden/Unauthorized)
   * vs a transient issue (network, timeout, rate limit) that should propagate.
   */
  private isPermissionError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    const status = (error as any)?.response?.status ?? (error as any)?.status;
    if (status === 401 || status === 403) return true;
    const lower = msg.toLowerCase();
    return lower.includes("forbidden") || lower.includes("unauthorized") || lower.includes("authentication");
  }

  /**
   * Perform the actual validation logic
   * @param startTime The start time of the validation request
   * @param settings Optional settings to validate with (overrides stored settings)
   * @returns ValidationResult with connectivity status and details
   */
  private async performValidation(
    startTime: number,
    settings?: Record<string, string>,
  ): Promise<ValidationResult> {
    try {
      // Use provided settings or fallback to stored settings
      const apiToken = settings?.apiToken || (await this.get(CloudflareService.API_TOKEN_KEY));
      const accountId = settings?.accountId || (await this.get(CloudflareService.ACCOUNT_ID_KEY));

      servicesLogger().debug(
        this.circuitBreaker.redact({
          hasToken: !!apiToken,
          tokenLength: apiToken?.length,
          circuitState: this.circuitBreaker.state,
        }),
        "Starting Cloudflare API validation",
      );

      if (!apiToken) {
        const result: ValidationResult = {
          isValid: false,
          message: "Cloudflare API token not configured",
          errorCode: "MISSING_API_TOKEN",
          responseTimeMs: Date.now() - startTime,
        };

        await this.recordConnectivityStatus(
          "failed",
          result.responseTimeMs,
          result.message,
          result.errorCode,
        );

        return result;
      }

      if (!accountId) {
        const result: ValidationResult = {
          isValid: false,
          message: "Cloudflare account ID not configured",
          errorCode: "MISSING_ACCOUNT_ID",
          responseTimeMs: Date.now() - startTime,
        };

        await this.recordConnectivityStatus(
          "failed",
          result.responseTimeMs,
          result.message,
          result.errorCode,
        );

        return result;
      }

      // Create Cloudflare client
      const cf = new Cloudflare({
        apiToken,
      });

      const metadata: Record<string, any> = {};
      const missingPermissions: string[] = [];

      // Validate Zone:Read permission by listing zones
      try {
        const zonesResponse = (await Promise.race([
          cf.zones.list({ account: { id: accountId } }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Zone API request timeout")),
              CloudflareService.TIMEOUT_MS,
            ),
          ),
        ])) as any;

        const zones = zonesResponse.result || [];
        metadata.zoneCount = zones.length;
        metadata.zones = zones.slice(0, 10).map((z: any) => z.name);
      } catch (zoneError) {
        if (this.isPermissionError(zoneError)) {
          missingPermissions.push("Zone:Read");
          servicesLogger().warn(
            { accountId, error: zoneError instanceof Error ? zoneError.message : "Unknown error" },
            "Cloudflare token lacks Zone:Read permission",
          );
        } else {
          throw zoneError; // Network errors, timeouts, rate limits — let outer catch handle
        }
      }

      // Validate Tunnel:Read permission by listing tunnels
      try {
        const tunnelsResponse = (await Promise.race([
          cf.zeroTrust.tunnels.list({ account_id: accountId }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Tunnel API request timeout")),
              CloudflareService.TIMEOUT_MS,
            ),
          ),
        ])) as any;

        const tunnels = tunnelsResponse.result || [];
        metadata.tunnelCount = tunnels.length;
        metadata.tunnels = tunnels
          .filter((t: any) => !t.deleted_at)
          .slice(0, 10)
          .map((t: any) => t.name);
      } catch (tunnelError) {
        if (this.isPermissionError(tunnelError)) {
          missingPermissions.push("Tunnel:Read");
          servicesLogger().warn(
            { accountId, error: tunnelError instanceof Error ? tunnelError.message : "Unknown error" },
            "Cloudflare token lacks Tunnel:Read permission",
          );
        } else {
          throw tunnelError; // Network errors, timeouts, rate limits — let outer catch handle
        }
      }

      const responseTime = Date.now() - startTime;
      metadata.accountId = accountId;

      if (missingPermissions.length > 0) {
        const result: ValidationResult = {
          isValid: false,
          message: `API token is missing required permissions: ${missingPermissions.join(", ")}`,
          errorCode: "MISSING_PERMISSIONS",
          responseTimeMs: responseTime,
          metadata,
        };

        await this.recordConnectivityStatus(
          "failed",
          result.responseTimeMs,
          result.message,
          result.errorCode,
          metadata,
        );

        return result;
      }

      // Record success for circuit breaker
      this.circuitBreaker.recordSuccess();

      const result: ValidationResult = {
        isValid: true,
        message: `Cloudflare API connection successful — ${metadata.zoneCount} zone(s), ${metadata.tunnelCount} tunnel(s)`,
        responseTimeMs: responseTime,
        metadata,
      };

      await this.recordConnectivityStatus(
        "connected",
        result.responseTimeMs,
        undefined,
        undefined,
        metadata,
      );

      servicesLogger().info(
        this.circuitBreaker.redact({
          responseTime,
          zoneCount: metadata.zoneCount,
          tunnelCount: metadata.tunnelCount,
          circuitState: this.circuitBreaker.state,
        }),
        "Cloudflare API validation successful",
      );

      return result;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse and categorize the error
      const { errorCode, connectivityStatus, isRetriable } =
        this.circuitBreaker.parseError(error);

      // Record failure for circuit breaker (only for retriable errors)
      if (isRetriable) {
        this.circuitBreaker.recordFailure(errorCode);
      }

      const result: ValidationResult = {
        isValid: false,
        message: `Cloudflare API validation failed: ${errorMessage}`,
        errorCode,
        responseTimeMs: responseTime,
      };

      await this.recordConnectivityStatus(
        connectivityStatus,
        result.responseTimeMs,
        result.message,
        result.errorCode,
      );

      servicesLogger().error(
        this.circuitBreaker.redact({
          error: errorMessage,
          errorCode,
          responseTime,
          isRetriable,
          circuitState: this.circuitBreaker.state,
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
        }),
        "Cloudflare API validation failed",
      );

      return result;
    }
  }

  /**
   * Get current health status of the Cloudflare service
   * @returns ServiceHealthStatus with current connectivity information
   */
  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.getLatestConnectivityStatus();

    if (!latestStatus) {
      // No previous status, perform validation
      const validationResult = await this.validate();

      return {
        service: "cloudflare",
        status: validationResult.isValid ? "connected" : "failed",
        lastChecked: new Date(),
        responseTime: validationResult.responseTimeMs,
        errorMessage: validationResult.isValid
          ? undefined
          : validationResult.message,
        errorCode: validationResult.errorCode,
        metadata: validationResult.metadata,
      };
    }

    return {
      service: "cloudflare",
      status: latestStatus.status as ConnectivityStatusType,
      lastChecked: latestStatus.checkedAt,
      lastSuccessful: latestStatus.lastSuccessfulAt,
      responseTime: latestStatus.responseTimeMs || undefined,
      errorMessage: latestStatus.errorMessage || undefined,
      errorCode: latestStatus.errorCode || undefined,
      metadata: latestStatus.metadata
        ? JSON.parse(latestStatus.metadata)
        : undefined,
    };
  }

  /**
   * Set API token with validation
   * @param apiToken - Cloudflare API token
   * @param userId - User ID who is setting the token
   */
  async setApiToken(apiToken: string, userId: string): Promise<void> {
    if (!apiToken || apiToken.trim().length === 0) {
      throw new Error("API token cannot be empty");
    }

    // Validate token format (Cloudflare tokens are typically 40 characters)
    if (apiToken.length < 20) {
      throw new Error("Invalid API token format");
    }

    await this.set(CloudflareService.API_TOKEN_KEY, apiToken, userId);

    // Reset circuit breaker when new credentials are set
    this.circuitBreaker.reset();

    servicesLogger().info(
      this.circuitBreaker.redact({
        userId,
        tokenLength: apiToken.length,
      }),
      "API token updated, circuit breaker reset",
    );
  }

  /**
   * Set account ID
   * @param accountId - Cloudflare account ID
   * @param userId - User ID who is setting the account ID
   */
  async setAccountId(accountId: string, userId: string): Promise<void> {
    if (!accountId || accountId.trim().length === 0) {
      throw new Error("Account ID cannot be empty");
    }

    await this.set(CloudflareService.ACCOUNT_ID_KEY, accountId, userId);
  }

  /**
   * Get API token
   * @returns API token or null if not set
   */
  async getApiToken(): Promise<string | null> {
    return await this.get(CloudflareService.API_TOKEN_KEY);
  }

  /**
   * Get account ID
   * @returns Account ID or null if not set
   */
  async getAccountId(): Promise<string | null> {
    return await this.get(CloudflareService.ACCOUNT_ID_KEY);
  }

  /**
   * Get tunnel configuration including ingress rules and hostname mappings
   * @param tunnelId The tunnel ID to get configuration for
   * @returns Tunnel configuration or null if not found or connection fails
   */
  async getTunnelConfig(tunnelId: string): Promise<any> {
    // Check circuit breaker before making API call
    if (this.circuitBreaker.isOpen()) {
      servicesLogger().warn(
        {
          circuitState: "open",
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
          tunnelId,
        },
        "Circuit breaker is open, skipping tunnel config retrieval",
      );
      return null;
    }

    try {
      const apiToken = await this.getApiToken();
      const accountId = await this.getAccountId();

      if (!apiToken) {
        servicesLogger().warn(
          "Cannot retrieve tunnel config: API token not configured",
        );
        return null;
      }

      if (!accountId) {
        servicesLogger().warn(
          "Cannot retrieve tunnel config: Account ID not configured",
        );
        return null;
      }

      const cf = new Cloudflare({
        apiToken,
      });

      // Try to fetch tunnel configuration using the proper API endpoint
      const configResponse = (await Promise.race([
        // Use the tunnel configurations endpoint
        fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
          {
            headers: {
              Authorization: `Bearer ${apiToken}`,
              "Content-Type": "application/json",
            },
          },
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Tunnel config API request timeout")),
            CloudflareService.TIMEOUT_MS,
          ),
        ),
      ])) as Response;

      if (!configResponse.ok) {
        servicesLogger().warn(
          this.circuitBreaker.redact({
            accountId,
            tunnelId,
            status: configResponse.status,
            statusText: configResponse.statusText,
          }),
          "Failed to fetch tunnel configuration from Cloudflare API",
        );
        return null;
      }

      const configData = await configResponse.json();

      // Record success for circuit breaker
      this.circuitBreaker.recordSuccess();

      servicesLogger().info(
        this.circuitBreaker.redact({
          accountId,
          tunnelId,
          configVersion: configData.result?.version,
          ingressRuleCount: configData.result?.config?.ingress?.length || 0,
        }),
        "Successfully retrieved Cloudflare tunnel configuration",
      );

      return configData.result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse error and record failure if retriable
      const { errorCode, isRetriable } = this.circuitBreaker.parseError(error);
      if (isRetriable) {
        this.circuitBreaker.recordFailure(errorCode);
      }

      servicesLogger().error(
        this.circuitBreaker.redact({
          error: errorMessage,
          errorCode,
          isRetriable,
          tunnelId,
        }),
        "Failed to retrieve Cloudflare tunnel configuration",
      );

      return null;
    }
  }

  /**
   * Test tunnel connectivity and retrieve tunnel information
   * Respects circuit breaker state
   * @returns Array of tunnel information or empty array if no tunnels or connection fails
   */
  async getTunnelInfo(): Promise<any[]> {
    // Check circuit breaker before making API call
    if (this.circuitBreaker.isOpen()) {
      servicesLogger().warn(
        {
          circuitState: "open",
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
        },
        "Circuit breaker is open, skipping tunnel info retrieval",
      );
      return [];
    }
    try {
      const apiToken = await this.getApiToken();
      const accountId = await this.getAccountId();

      if (!apiToken) {
        servicesLogger().warn(
          "Cannot retrieve tunnel info: API token not configured",
        );
        return [];
      }

      if (!accountId) {
        servicesLogger().warn(
          "Cannot retrieve tunnel info: Account ID not configured",
        );
        return [];
      }

      const cf = new Cloudflare({
        apiToken,
      });

      // Fetch tunnels for the account
      const tunnelsResponse = (await Promise.race([
        cf.zeroTrust.tunnels.list({ account_id: accountId }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Tunnel API request timeout")),
            CloudflareService.TIMEOUT_MS,
          ),
        ),
      ])) as any;

      const tunnels = tunnelsResponse.result || [];

      // Record success for circuit breaker
      this.circuitBreaker.recordSuccess();

      servicesLogger().info(
        this.circuitBreaker.redact({
          accountId,
          tunnelCount: tunnels.length,
        }),
        "Successfully retrieved Cloudflare tunnel information",
      );

      return tunnels
        .filter((tunnel: any) => !tunnel.deleted_at) // Filter out deleted tunnels
        .map((tunnel: any) => ({
          id: tunnel.id,
          name: tunnel.name,
          status: tunnel.status,
          created_at: tunnel.created_at,
          deleted_at: tunnel.deleted_at,
          connections: tunnel.connections || [],
        }));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse error and record failure if retriable
      const { errorCode, isRetriable } = this.circuitBreaker.parseError(error);
      if (isRetriable) {
        this.circuitBreaker.recordFailure(errorCode);
      }

      servicesLogger().error(
        this.circuitBreaker.redact({
          error: errorMessage,
          errorCode,
          isRetriable,
        }),
        "Failed to retrieve Cloudflare tunnel information",
      );

      return [];
    }
  }

  /**
   * Update tunnel configuration with new ingress rules
   * @param tunnelId The tunnel ID to update
   * @param config The new tunnel configuration
   * @returns Updated configuration or null if update fails
   */
  async updateTunnelConfig(tunnelId: string, config: any): Promise<any> {
    // Check circuit breaker before making API call
    if (this.circuitBreaker.isOpen()) {
      servicesLogger().warn(
        {
          circuitState: "open",
          consecutiveFailures: this.circuitBreaker.consecutiveFailures,
          tunnelId,
        },
        "Circuit breaker is open, skipping tunnel config update",
      );
      return null;
    }

    try {
      const apiToken = await this.getApiToken();
      const accountId = await this.getAccountId();

      if (!apiToken) {
        servicesLogger().warn(
          "Cannot update tunnel config: API token not configured",
        );
        return null;
      }

      if (!accountId) {
        servicesLogger().warn(
          "Cannot update tunnel config: Account ID not configured",
        );
        return null;
      }

      // Update tunnel configuration using the proper API endpoint
      const updateResponse = (await Promise.race([
        fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${apiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              config: config,
            }),
          },
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Tunnel config update API request timeout")),
            CloudflareService.TIMEOUT_MS,
          ),
        ),
      ])) as Response;

      if (!updateResponse.ok) {
        const errorText = await updateResponse.text();
        servicesLogger().warn(
          this.circuitBreaker.redact({
            accountId,
            tunnelId,
            status: updateResponse.status,
            statusText: updateResponse.statusText,
            error: errorText,
          }),
          "Failed to update tunnel configuration via Cloudflare API",
        );
        throw new Error(`HTTP ${updateResponse.status}: ${errorText}`);
      }

      const updateData = await updateResponse.json();

      // Record success for circuit breaker
      this.circuitBreaker.recordSuccess();

      servicesLogger().info(
        this.circuitBreaker.redact({
          accountId,
          tunnelId,
          configVersion: updateData.result?.version,
          ingressRuleCount: config.ingress?.length || 0,
        }),
        "Successfully updated Cloudflare tunnel configuration",
      );

      return updateData.result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse error and record failure if retriable
      const { errorCode, isRetriable } = this.circuitBreaker.parseError(error);
      if (isRetriable) {
        this.circuitBreaker.recordFailure(errorCode);
      }

      servicesLogger().error(
        this.circuitBreaker.redact({
          error: errorMessage,
          errorCode,
          isRetriable,
          tunnelId,
        }),
        "Failed to update Cloudflare tunnel configuration",
      );

      throw toServiceError(error, "cloudflare");
    }
  }

  /**
   * Add a public hostname to a tunnel's ingress rules
   * @param tunnelId The tunnel ID to update
   * @param hostname The public hostname to add
   * @param service The backend service URL
   * @param path Optional path pattern for the hostname
   * @returns Updated configuration or null if update fails
   */
  async addHostname(
    tunnelId: string,
    hostname: string,
    service: string,
    path?: string,
    originRequest?: { httpHostHeader?: string },
  ): Promise<any> {
    try {
      // First get the current configuration
      const currentConfig = await this.getTunnelConfig(tunnelId);

      if (!currentConfig || !currentConfig.config) {
        throw new Error("Unable to retrieve current tunnel configuration");
      }

      const ingress = [...(currentConfig.config.ingress || [])];

      // Check if hostname already exists
      const existingRuleIndex = ingress.findIndex(
        (rule) => rule.hostname === hostname && rule.path === path,
      );
      if (existingRuleIndex !== -1) {
        throw new Error(
          `Hostname ${hostname}${path ? ` with path ${path}` : ""} already exists`,
        );
      }

      // Find the catch-all rule (rule without hostname) and insert before it
      const catchAllIndex = ingress.findIndex((rule) => !rule.hostname);
      const newRule: any = {
        hostname,
        service,
      };

      if (path) {
        newRule.path = path;
      }

      if (originRequest) {
        newRule.originRequest = originRequest;
      }

      if (catchAllIndex !== -1) {
        // Insert before catch-all rule
        ingress.splice(catchAllIndex, 0, newRule);
      } else {
        // No catch-all rule found, add at the end (though this shouldn't happen)
        ingress.push(newRule);
      }

      // Update the configuration
      const updatedConfig = {
        ...currentConfig.config,
        ingress,
      };

      servicesLogger().info(
        this.circuitBreaker.redact({
          tunnelId,
          hostname,
          service,
          path,
          ingressRuleCount: ingress.length,
        }),
        "Adding hostname to tunnel configuration",
      );

      return await this.updateTunnelConfig(tunnelId, updatedConfig);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        this.circuitBreaker.redact({
          error: errorMessage,
          tunnelId,
          hostname,
          service,
        }),
        "Failed to add hostname to tunnel configuration",
      );

      throw toServiceError(error, "cloudflare");
    }
  }

  /**
   * Remove a public hostname from a tunnel's ingress rules
   * @param tunnelId The tunnel ID to update
   * @param hostname The public hostname to remove
   * @param path Optional path pattern for the hostname
   * @returns Updated configuration or null if update fails
   */
  async removeHostname(
    tunnelId: string,
    hostname: string,
    path?: string,
  ): Promise<any> {
    try {
      // First get the current configuration
      const currentConfig = await this.getTunnelConfig(tunnelId);

      if (!currentConfig || !currentConfig.config) {
        throw new Error("Unable to retrieve current tunnel configuration");
      }

      const ingress = [...(currentConfig.config.ingress || [])];

      // Find the rule to remove
      const ruleIndex = ingress.findIndex(
        (rule) =>
          rule.hostname === hostname &&
          (path ? rule.path === path : !rule.path),
      );

      if (ruleIndex === -1) {
        throw new Error(
          `Hostname ${hostname}${path ? ` with path ${path}` : ""} not found`,
        );
      }

      // Remove the rule
      ingress.splice(ruleIndex, 1);

      // Update the configuration
      const updatedConfig = {
        ...currentConfig.config,
        ingress,
      };

      servicesLogger().info(
        this.circuitBreaker.redact({
          tunnelId,
          hostname,
          path,
          ingressRuleCount: ingress.length,
        }),
        "Removing hostname from tunnel configuration",
      );

      return await this.updateTunnelConfig(tunnelId, updatedConfig);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      servicesLogger().error(
        this.circuitBreaker.redact({
          error: errorMessage,
          tunnelId,
          hostname,
        }),
        "Failed to remove hostname from tunnel configuration",
      );

      throw toServiceError(error, "cloudflare");
    }
  }

  /**
   * Get Cloudflare zone ID by domain name
   * @param domain - Domain name (e.g., "example.com")
   * @returns Zone ID
   */
  async getZoneId(domain: string): Promise<string> {
    // Check circuit breaker
    if (this.circuitBreaker.isOpen()) {
      throw new Error("Circuit breaker is open, cannot query Cloudflare API");
    }

    try {
      const apiToken = await this.getApiToken();

      if (!apiToken) {
        throw new Error("Cloudflare API token not configured");
      }

      const cf = new Cloudflare({
        apiToken,
      });

      // List zones and find matching domain
      const zonesResponse = (await Promise.race([
        cf.zones.list({ name: domain }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Get zone API request timeout")),
            CloudflareService.TIMEOUT_MS,
          ),
        ),
      ])) as any;

      const zones = zonesResponse.result || [];

      if (zones.length === 0) {
        throw new Error(`No Cloudflare zone found for domain: ${domain}`);
      }

      // Record success for circuit breaker
      this.circuitBreaker.recordSuccess();

      servicesLogger().info(
        { domain, zoneId: zones[0].id },
        "Retrieved Cloudflare zone ID",
      );

      return zones[0].id;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse error and record failure if retriable
      const { errorCode, isRetriable } = this.circuitBreaker.parseError(error);
      if (isRetriable) {
        this.circuitBreaker.recordFailure(errorCode);
      }

      servicesLogger().error(
        this.circuitBreaker.redact({
          error: errorMessage,
          errorCode,
          domain,
        }),
        "Failed to get Cloudflare zone ID",
      );

      throw toServiceError(error, "cloudflare");
    }
  }

  /**
   * Create DNS record in Cloudflare
   * @param params - DNS record parameters
   * @returns DNS record ID
   */
  async createDnsRecord(params: {
    zoneId: string;
    type: string;
    name: string;
    content: string;
    ttl: number;
  }): Promise<string> {
    // Check circuit breaker
    if (this.circuitBreaker.isOpen()) {
      throw new Error("Circuit breaker is open, cannot create DNS record");
    }

    try {
      const apiToken = await this.getApiToken();

      if (!apiToken) {
        throw new Error("Cloudflare API token not configured");
      }

      const cf = new Cloudflare({
        apiToken,
      });

      // Create DNS record
      const recordResponse = (await Promise.race([
        cf.dns.records.create({
          zone_id: params.zoneId,
          type: params.type as any,
          name: params.name,
          content: params.content,
          ttl: params.ttl,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Create DNS record API request timeout")),
            CloudflareService.TIMEOUT_MS,
          ),
        ),
      ])) as any;

      // Record success for circuit breaker
      this.circuitBreaker.recordSuccess();

      servicesLogger().info(
        this.circuitBreaker.redact({
          zoneId: params.zoneId,
          recordId: recordResponse.id,
          type: params.type,
          name: params.name,
        }),
        "Created DNS record in Cloudflare",
      );

      return recordResponse.id;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse error and record failure if retriable
      const { errorCode, isRetriable } = this.circuitBreaker.parseError(error);
      if (isRetriable) {
        this.circuitBreaker.recordFailure(errorCode);
      }

      servicesLogger().error(
        this.circuitBreaker.redact({
          error: errorMessage,
          errorCode,
          zoneId: params.zoneId,
          type: params.type,
          name: params.name,
        }),
        "Failed to create DNS record in Cloudflare",
      );

      throw toServiceError(error, "cloudflare");
    }
  }

  /**
   * Delete DNS record from Cloudflare
   * @param zoneId - Zone ID
   * @param recordId - DNS record ID to delete
   */
  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    // Check circuit breaker
    if (this.circuitBreaker.isOpen()) {
      throw new Error("Circuit breaker is open, cannot delete DNS record");
    }

    try {
      const apiToken = await this.getApiToken();

      if (!apiToken) {
        throw new Error("Cloudflare API token not configured");
      }

      const cf = new Cloudflare({
        apiToken,
      });

      // Delete DNS record
      await Promise.race([
        cf.dns.records.delete(recordId, { zone_id: zoneId }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Delete DNS record API request timeout")),
            CloudflareService.TIMEOUT_MS,
          ),
        ),
      ]);

      // Record success for circuit breaker
      this.circuitBreaker.recordSuccess();

      servicesLogger().info(
        { zoneId, recordId },
        "Deleted DNS record from Cloudflare",
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Parse error and record failure if retriable
      const { errorCode, isRetriable } = this.circuitBreaker.parseError(error);
      if (isRetriable) {
        this.circuitBreaker.recordFailure(errorCode);
      }

      servicesLogger().error(
        this.circuitBreaker.redact({
          error: errorMessage,
          errorCode,
          zoneId,
          recordId,
        }),
        "Failed to delete DNS record from Cloudflare",
      );

      throw toServiceError(error, "cloudflare");
    }
  }

  /**
   * Remove API token and account ID
   * @param userId - User ID who is removing the configuration
   */
  async removeConfiguration(userId: string): Promise<void> {
    try {
      await this.delete(CloudflareService.API_TOKEN_KEY, userId);
    } catch (error) {
      // Token might not exist, continue
    }

    try {
      const oldAccountId = await this.get(
        CloudflareService.ACCOUNT_ID_KEY,
      );
      await this.delete(CloudflareService.ACCOUNT_ID_KEY, userId);
    } catch (error) {
      // Account ID might not exist, continue
    }

    // Record disconnection status
    await this.recordConnectivityStatus(
      "failed",
      undefined,
      "Configuration removed by user",
      "CONFIG_REMOVED",
      undefined,
      userId,
    );
  }

  // ====================
  // Managed Tunnel Methods
  // ====================

  private managedTunnelKey(environmentId: string, suffix: string): string {
    return `managed_tunnel_${suffix}_${environmentId}`;
  }

  /**
   * Create a managed Cloudflare tunnel for an environment
   * Creates the tunnel via Cloudflare API, retrieves the token, and stores both
   */
  async createManagedTunnel(
    environmentId: string,
    name: string,
    userId: string,
  ): Promise<{ tunnelId: string; tunnelName: string }> {
    // Check circuit breaker
    if (this.circuitBreaker.isOpen()) {
      throw new Error("Circuit breaker is open, cannot create tunnel");
    }

    const apiToken = await this.getApiToken();
    const accountId = await this.getAccountId();

    if (!apiToken || !accountId) {
      throw new Error("Cloudflare API token and account ID must be configured");
    }

    // Check for existing managed tunnel
    const existingId = await this.get(this.managedTunnelKey(environmentId, "id"));
    if (existingId) {
      throw new Error(`A managed tunnel already exists for this environment (ID: ${existingId})`);
    }

    const cf = new Cloudflare({ apiToken });
    let tunnelId: string | undefined;

    try {
      // Create the tunnel
      const tunnelResponse = (await Promise.race([
        cf.zeroTrust.tunnels.cloudflared.create({
          account_id: accountId,
          name,
          config_src: "cloudflare",
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Tunnel creation timeout")),
            CloudflareService.TIMEOUT_MS,
          ),
        ),
      ])) as any;

      tunnelId = tunnelResponse.id;
      if (!tunnelId) {
        throw new Error("Tunnel creation returned no ID");
      }

      servicesLogger().info(
        this.circuitBreaker.redact({ tunnelId, name }),
        "Created Cloudflare tunnel",
      );

      // Retrieve the tunnel token
      const tokenResponse = (await Promise.race([
        cf.zeroTrust.tunnels.cloudflared.token.get(tunnelId, {
          account_id: accountId,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Token retrieval timeout")),
            CloudflareService.TIMEOUT_MS,
          ),
        ),
      ])) as string;

      if (!tokenResponse) {
        throw new Error("Token retrieval returned empty token");
      }

      // Set default ingress config (catch-all 404)
      try {
        await this.updateTunnelConfig(tunnelId, {
          ingress: [{ service: "http_status:404" }],
        });
      } catch (err) {
        servicesLogger().warn(
          { tunnelId, error: err instanceof Error ? err.message : "Unknown" },
          "Failed to set default ingress config, continuing",
        );
      }

      // Store tunnel metadata
      await this.set(this.managedTunnelKey(environmentId, "id"), tunnelId, userId);
      await this.set(this.managedTunnelKey(environmentId, "name"), name, userId);
      await this.set(this.managedTunnelKey(environmentId, "token"), tokenResponse, userId);
      await this.set(
        this.managedTunnelKey(environmentId, "created_at"),
        new Date().toISOString(),
        userId,
      );

      this.circuitBreaker.recordSuccess();

      return { tunnelId, tunnelName: name };
    } catch (error) {
      // If tunnel was created but token retrieval failed, clean up the tunnel
      if (tunnelId) {
        try {
          await cf.zeroTrust.tunnels.cloudflared.delete(tunnelId, {
            account_id: accountId,
          });
          servicesLogger().info(
            { tunnelId },
            "Cleaned up tunnel after failed token retrieval",
          );
        } catch (cleanupErr) {
          servicesLogger().error(
            {
              tunnelId,
              error: cleanupErr instanceof Error ? cleanupErr.message : "Unknown",
            },
            "Failed to clean up tunnel after error — manual cleanup may be required",
          );
        }
      }

      const { errorCode, isRetriable } = this.circuitBreaker.parseError(error);
      if (isRetriable) {
        this.circuitBreaker.recordFailure(errorCode);
      }

      throw toServiceError(error, "cloudflare");
    }
  }

  /**
   * Delete a managed Cloudflare tunnel for an environment
   * Removes the tunnel from Cloudflare and clears stored settings
   */
  async deleteManagedTunnel(
    environmentId: string,
    userId: string,
  ): Promise<void> {
    const tunnelId = await this.get(this.managedTunnelKey(environmentId, "id"));
    if (!tunnelId) {
      throw new Error("No managed tunnel exists for this environment");
    }

    const apiToken = await this.getApiToken();
    const accountId = await this.getAccountId();

    if (apiToken && accountId) {
      try {
        const cf = new Cloudflare({ apiToken });
        await Promise.race([
          cf.zeroTrust.tunnels.cloudflared.delete(tunnelId, {
            account_id: accountId,
          }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Tunnel deletion timeout")),
              CloudflareService.TIMEOUT_MS,
            ),
          ),
        ]);

        servicesLogger().info(
          this.circuitBreaker.redact({ tunnelId }),
          "Deleted Cloudflare tunnel",
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown";
        servicesLogger().error(
          this.circuitBreaker.redact({ tunnelId, error: errorMessage }),
          "Failed to delete tunnel from Cloudflare — clearing local settings anyway",
        );
        // Continue to clear local settings even if API deletion fails
      }
    }

    // Clear all managed tunnel settings
    for (const suffix of ["id", "name", "token", "created_at"]) {
      try {
        await this.delete(this.managedTunnelKey(environmentId, suffix), userId);
      } catch {
        // Key might not exist, continue
      }
    }
  }

  /**
   * Get managed tunnel info for an environment
   * Never exposes the actual tunnel token
   */
  async getManagedTunnelInfo(
    environmentId: string,
  ): Promise<{
    tunnelId: string;
    tunnelName: string;
    hasToken: boolean;
    createdAt?: string;
  } | null> {
    const tunnelId = await this.get(this.managedTunnelKey(environmentId, "id"));
    if (!tunnelId) return null;

    const tunnelName =
      (await this.get(this.managedTunnelKey(environmentId, "name"))) ?? "unknown";
    const token = await this.get(this.managedTunnelKey(environmentId, "token"));
    const createdAt = await this.get(
      this.managedTunnelKey(environmentId, "created_at"),
    );

    return {
      tunnelId,
      tunnelName,
      hasToken: !!token,
      createdAt: createdAt ?? undefined,
    };
  }

  /**
   * Get managed tunnel token for an environment (internal use for stack deployment)
   */
  async getManagedTunnelToken(environmentId: string): Promise<string | null> {
    return this.get(this.managedTunnelKey(environmentId, "token"));
  }

  /**
   * Get all managed tunnels across all environments
   * Returns a map of environmentId → tunnel info
   */
  async getAllManagedTunnels(): Promise<
    Map<
      string,
      { tunnelId: string; tunnelName: string; hasToken: boolean; createdAt?: string }
    >
  > {
    const result = new Map<
      string,
      { tunnelId: string; tunnelName: string; hasToken: boolean; createdAt?: string }
    >();

    try {
      // Find all managed_tunnel_id_* settings
      const tunnelSettings = await this.prisma.systemSettings.findMany({
        where: {
          category: this.category,
          key: { startsWith: "managed_tunnel_id_" },
        },
      });

      for (const setting of tunnelSettings) {
        const environmentId = setting.key.replace("managed_tunnel_id_", "");
        const info = await this.getManagedTunnelInfo(environmentId);
        if (info) {
          result.set(environmentId, info);
        }
      }
    } catch (error) {
      servicesLogger().error(
        { error: error instanceof Error ? error.message : "Unknown" },
        "Failed to get all managed tunnels",
      );
    }

    return result;
  }
}
