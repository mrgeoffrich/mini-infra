import { PrismaClient } from "../generated/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
} from "@mini-infra/types";
import { ConfigurationService } from "./configuration-base";
import logger from "../lib/logger";
import Cloudflare from "cloudflare";

/**
 * CloudflareConfigService handles Cloudflare API configuration management
 * Extends the base ConfigurationService to provide Cloudflare-specific functionality
 */
export class CloudflareConfigService extends ConfigurationService {
  private static readonly TIMEOUT_MS = 10000; // 10 second timeout
  private static readonly API_TOKEN_KEY = "api_token";
  private static readonly ACCOUNT_ID_KEY = "account_id";

  constructor(prisma: PrismaClient) {
    super(prisma, "cloudflare");
  }

  /**
   * Validate Cloudflare API configuration by testing API connectivity
   * @returns ValidationResult with connectivity status and details
   */
  async validate(): Promise<ValidationResult> {
    const startTime = Date.now();

    try {
      const apiToken = await this.get(CloudflareConfigService.API_TOKEN_KEY);

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

      // Create Cloudflare client with timeout
      const cf = new Cloudflare({
        apiToken,
      });

      // Test API connectivity by fetching user information
      const userResponse = (await Promise.race([
        cf.user.get(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("API request timeout")),
            CloudflareConfigService.TIMEOUT_MS,
          ),
        ),
      ])) as any;

      const responseTime = Date.now() - startTime;

      // Extract account information if available
      const metadata: Record<string, any> = {
        userEmail: userResponse.email,
        userId: userResponse.id,
        firstName: userResponse.first_name,
        lastName: userResponse.last_name,
        accountStatus: userResponse.suspended ? "suspended" : "active",
      };

      // Test account access if account ID is configured
      let accountInfo = null;
      const accountId = await this.get(CloudflareConfigService.ACCOUNT_ID_KEY);
      if (accountId) {
        try {
          accountInfo = await cf.accounts.get({ account_id: accountId });
          metadata.accountName = accountInfo.name;
          metadata.accountId = accountInfo.id;
        } catch (accountError) {
          logger.warn(
            {
              accountId,
              error:
                accountError instanceof Error
                  ? accountError.message
                  : "Unknown error",
            },
            "Failed to fetch account information, but API token is valid",
          );
        }
      }

      const result: ValidationResult = {
        isValid: true,
        message: `Cloudflare API connection successful (${userResponse.email})`,
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

      return result;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      let errorCode = "CLOUDFLARE_API_ERROR";
      let connectivityStatus: ConnectivityStatusType = "failed";

      // Parse specific Cloudflare API errors
      if (errorMessage.includes("timeout")) {
        errorCode = "TIMEOUT";
        connectivityStatus = "timeout";
      } else if (
        errorMessage.includes("Unauthorized") ||
        errorMessage.includes("Invalid API Token")
      ) {
        errorCode = "INVALID_API_TOKEN";
      } else if (errorMessage.includes("Forbidden")) {
        errorCode = "INSUFFICIENT_PERMISSIONS";
      } else if (
        errorMessage.includes("ENOTFOUND") ||
        errorMessage.includes("ECONNREFUSED")
      ) {
        errorCode = "NETWORK_ERROR";
        connectivityStatus = "unreachable";
      } else if (errorMessage.includes("Rate limit")) {
        errorCode = "RATE_LIMITED";
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

      logger.error(
        {
          error: errorMessage,
          errorCode,
          responseTime,
        },
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

    await this.set(CloudflareConfigService.API_TOKEN_KEY, apiToken, userId);

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

    await this.set(CloudflareConfigService.ACCOUNT_ID_KEY, accountId, userId);

  }

  /**
   * Get API token
   * @returns API token or null if not set
   */
  async getApiToken(): Promise<string | null> {
    return await this.get(CloudflareConfigService.API_TOKEN_KEY);
  }

  /**
   * Get account ID
   * @returns Account ID or null if not set
   */
  async getAccountId(): Promise<string | null> {
    return await this.get(CloudflareConfigService.ACCOUNT_ID_KEY);
  }

  /**
   * Test tunnel connectivity and retrieve tunnel information
   * @returns Array of tunnel information or empty array if no tunnels or connection fails
   */
  async getTunnelInfo(): Promise<any[]> {
    try {
      const apiToken = await this.getApiToken();
      const accountId = await this.getAccountId();

      if (!apiToken) {
        logger.warn("Cannot retrieve tunnel info: API token not configured");
        return [];
      }

      if (!accountId) {
        logger.warn("Cannot retrieve tunnel info: Account ID not configured");
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
            CloudflareConfigService.TIMEOUT_MS,
          ),
        ),
      ])) as any;

      const tunnels = tunnelsResponse.result || [];

      logger.info(
        {
          accountId,
          tunnelCount: tunnels.length,
        },
        "Successfully retrieved Cloudflare tunnel information",
      );

      return tunnels.map((tunnel: any) => ({
        id: tunnel.id,
        name: tunnel.name,
        status: tunnel.status,
        created_at: tunnel.created_at,
        connections: tunnel.connections || [],
      }));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
        {
          error: errorMessage,
        },
        "Failed to retrieve Cloudflare tunnel information",
      );

      return [];
    }
  }

  /**
   * Remove API token and account ID
   * @param userId - User ID who is removing the configuration
   */
  async removeConfiguration(userId: string): Promise<void> {
    try {
      await this.delete(CloudflareConfigService.API_TOKEN_KEY, userId);
    } catch (error) {
      // Token might not exist, continue
    }

    try {
      const oldAccountId = await this.get(
        CloudflareConfigService.ACCOUNT_ID_KEY,
      );
      await this.delete(CloudflareConfigService.ACCOUNT_ID_KEY, userId);
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
}
