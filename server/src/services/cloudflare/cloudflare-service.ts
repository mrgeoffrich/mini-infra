import { PrismaClient } from "../../lib/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
  CloudflareTunnelConfig,
} from "@mini-infra/types";
import { ConfigurationService } from "../configuration-base";
import { getLogger } from "../../lib/logger-factory";
import Cloudflare from "cloudflare";
import type { Zone } from "cloudflare/resources/zones/zones.js";
import type { TunnelListResponse } from "cloudflare/resources/zero-trust/tunnels/tunnels.js";
import { CircuitBreaker, ErrorMapper } from "../circuit-breaker";
import {
  CloudflareApiRunner,
  CLOUDFLARE_TIMEOUT_MS,
} from "./cloudflare-api-runner";
import { CloudflareTunnelApi } from "./cloudflare-tunnel-api";
import { CloudflareZoneApi } from "./cloudflare-zone-api";
import { CloudflareManagedTunnels } from "./cloudflare-managed-tunnel";
import {
  ManagedTunnelStore,
  ManagedTunnelSummary,
} from "./managed-tunnel-store";

/**
 * Cloudflare-specific error mappers for the circuit breaker.
 * Order matters: HTTP status code checks come first, then message-based checks.
 */
const CLOUDFLARE_ERROR_MAPPERS: ErrorMapper[] = [
  {
    pattern: (error: unknown) =>
      (error as { response?: { status?: number } })?.response?.status === 401 ||
      (error as { status?: number })?.status === 401,
    errorCode: "INVALID_API_TOKEN",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: (error: unknown) =>
      (error as { response?: { status?: number } })?.response?.status === 403 ||
      (error as { status?: number })?.status === 403,
    errorCode: "INSUFFICIENT_PERMISSIONS",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: (error: unknown) =>
      (error as { response?: { status?: number } })?.response?.status === 429 ||
      (error as { status?: number })?.status === 429,
    errorCode: "RATE_LIMITED",
    connectivityStatus: "failed",
    isRetriable: true,
  },
  {
    pattern: (error: unknown) =>
      (error as { response?: { status?: number } })?.response?.status === 500 ||
      (error as { status?: number })?.status === 500,
    errorCode: "SERVER_ERROR_500",
    connectivityStatus: "failed",
    isRetriable: true,
  },
  {
    pattern: (error: unknown) =>
      (error as { response?: { status?: number } })?.response?.status === 502 ||
      (error as { status?: number })?.status === 502,
    errorCode: "SERVER_ERROR_502",
    connectivityStatus: "failed",
    isRetriable: true,
  },
  {
    pattern: (error: unknown) =>
      (error as { response?: { status?: number } })?.response?.status === 503 ||
      (error as { status?: number })?.status === 503,
    errorCode: "SERVER_ERROR_503",
    connectivityStatus: "failed",
    isRetriable: true,
  },
  {
    pattern: (error: unknown) =>
      (error as { response?: { status?: number } })?.response?.status === 504 ||
      (error as { status?: number })?.status === 504,
    errorCode: "SERVER_ERROR_504",
    connectivityStatus: "failed",
    isRetriable: true,
  },
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
 * CloudflareService owns the Cloudflare integration — configuration
 * storage, credential validation, and a circuit breaker shared across
 * every outbound Cloudflare API call.
 *
 * The tunnel, managed-tunnel, and zone/DNS APIs are split into focused
 * helpers ({@link CloudflareTunnelApi}, {@link CloudflareManagedTunnels},
 * {@link CloudflareZoneApi}) that all share the {@link CloudflareApiRunner}
 * exposed on this class. The helpers are also accessible directly via
 * the `tunnelApi`, `managedTunnels` and `zoneApi` properties for code
 * that doesn't need the delegated methods.
 */
export class CloudflareService extends ConfigurationService {
  private static readonly API_TOKEN_KEY = "api_token";
  private static readonly ACCOUNT_ID_KEY = "account_id";

  private circuitBreaker: CircuitBreaker;

  /** Low-level helper every Cloudflare call routes through. */
  readonly runner: CloudflareApiRunner;
  readonly tunnelApi: CloudflareTunnelApi;
  readonly managedTunnels: CloudflareManagedTunnels;
  readonly zoneApi: CloudflareZoneApi;

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

    this.runner = new CloudflareApiRunner(
      this.circuitBreaker,
      () => this.getApiToken(),
      () => this.getAccountId(),
    );
    this.tunnelApi = new CloudflareTunnelApi(this.runner);
    this.zoneApi = new CloudflareZoneApi(this.runner);
    const managedStore = new ManagedTunnelStore(this);
    this.managedTunnels = new CloudflareManagedTunnels(
      this.runner,
      this.tunnelApi,
      managedStore,
      prisma.systemSettings,
      this.category,
    );
  }

  // ====================
  // Configuration storage
  // ====================

  async setApiToken(apiToken: string, userId: string): Promise<void> {
    if (!apiToken || apiToken.trim().length === 0) {
      throw new Error("API token cannot be empty");
    }
    if (apiToken.length < 20) {
      throw new Error("Invalid API token format");
    }

    await this.set(CloudflareService.API_TOKEN_KEY, apiToken, userId);

    // Credentials changed — give the circuit breaker a fresh start so
    // previously-recorded failures don't keep blocking new requests.
    this.circuitBreaker.reset();

    getLogger("integrations", "cloudflare-service").info(
      this.circuitBreaker.redact({ userId, tokenLength: apiToken.length }),
      "API token updated, circuit breaker reset",
    );
  }

  async setAccountId(accountId: string, userId: string): Promise<void> {
    if (!accountId || accountId.trim().length === 0) {
      throw new Error("Account ID cannot be empty");
    }
    await this.set(CloudflareService.ACCOUNT_ID_KEY, accountId, userId);
  }

  async getApiToken(): Promise<string | null> {
    return this.get(CloudflareService.API_TOKEN_KEY);
  }

  async getAccountId(): Promise<string | null> {
    return this.get(CloudflareService.ACCOUNT_ID_KEY);
  }

  async removeConfiguration(userId: string): Promise<void> {
    for (const key of [
      CloudflareService.API_TOKEN_KEY,
      CloudflareService.ACCOUNT_ID_KEY,
    ]) {
      try {
        await this.delete(key, userId);
      } catch {
        // Key might not exist — continue.
      }
    }

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
  // Validation / health
  // ====================

  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    return this.circuitBreaker.validateWithDedup(
      (startTime, s) => this.performValidation(startTime, s),
      settings,
    );
  }

  /**
   * True for 401/403 and related auth/permission errors. We distinguish
   * these from transient failures (network, timeout, rate limit) during
   * validation so missing scopes can be surfaced precisely rather than
   * masked as generic outages.
   */
  private isPermissionError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    const status =
      (error as { response?: { status?: number } })?.response?.status ??
      (error as { status?: number })?.status;
    if (status === 401 || status === 403) return true;
    const lower = msg.toLowerCase();
    return (
      lower.includes("forbidden") ||
      lower.includes("unauthorized") ||
      lower.includes("authentication")
    );
  }

  private async performValidation(
    startTime: number,
    settings?: Record<string, string>,
  ): Promise<ValidationResult> {
    try {
      const apiToken =
        settings?.apiToken ||
        (await this.get(CloudflareService.API_TOKEN_KEY));
      const accountId =
        settings?.accountId ||
        (await this.get(CloudflareService.ACCOUNT_ID_KEY));

      getLogger("integrations", "cloudflare-service").debug(
        this.circuitBreaker.redact({
          hasToken: !!apiToken,
          tokenLength: apiToken?.length,
          circuitState: this.circuitBreaker.state,
        }),
        "Starting Cloudflare API validation",
      );

      if (!apiToken) {
        return this.recordValidationFailure(
          startTime,
          "Cloudflare API token not configured",
          "MISSING_API_TOKEN",
        );
      }
      if (!accountId) {
        return this.recordValidationFailure(
          startTime,
          "Cloudflare account ID not configured",
          "MISSING_ACCOUNT_ID",
        );
      }

      const cf = new Cloudflare({ apiToken });
      const metadata: Record<string, unknown> = {};
      const missingPermissions: string[] = [];
      let firstZoneId: string | undefined;

      // Zone:Read — missing scopes are captured rather than thrown so we
      // can report exactly which permissions are absent.
      try {
        const zonesResponse = await this.runner.withTimeout(
          cf.zones.list({ account: { id: accountId } }),
          "zone list",
          CLOUDFLARE_TIMEOUT_MS,
        );
        const zones = zonesResponse.result || [];
        metadata.zoneCount = zones.length;
        metadata.zones = zones.slice(0, 10).map((z: Zone) => z.name);
        firstZoneId = zones[0]?.id;
      } catch (zoneError) {
        if (this.isPermissionError(zoneError)) {
          missingPermissions.push("Zone:Read");
          getLogger("integrations", "cloudflare-service").warn(
            {
              accountId,
              error:
                zoneError instanceof Error
                  ? zoneError.message
                  : "Unknown error",
            },
            "Cloudflare token lacks Zone:Read permission",
          );
        } else {
          throw zoneError;
        }
      }

      // Cloudflare Tunnel:Edit — listing tunnels requires at minimum Read,
      // but the app creates managed tunnels and requires Edit. If the probe
      // fails with a permission error, Edit is definitely absent.
      try {
        const tunnelsResponse = await this.runner.withTimeout(
          cf.zeroTrust.tunnels.list({ account_id: accountId }),
          "tunnel list",
          CLOUDFLARE_TIMEOUT_MS,
        );
        const tunnels = tunnelsResponse.result || [];
        metadata.tunnelCount = tunnels.length;
        metadata.tunnels = tunnels
          .filter((t: TunnelListResponse) => !t.deleted_at)
          .slice(0, 10)
          .map((t: TunnelListResponse) => t.name);
      } catch (tunnelError) {
        if (this.isPermissionError(tunnelError)) {
          missingPermissions.push("Cloudflare Tunnel:Edit");
          getLogger("integrations", "cloudflare-service").warn(
            {
              accountId,
              error:
                tunnelError instanceof Error
                  ? tunnelError.message
                  : "Unknown error",
            },
            "Cloudflare token lacks Cloudflare Tunnel:Edit permission",
          );
        } else {
          throw tunnelError;
        }
      }

      // DNS:Edit — probe by listing records on the first accessible zone.
      // Listing technically only requires Read, but DNS:Edit is a superset
      // and the app needs Edit to create/update records for app routing.
      // If no zones are accessible we can't probe here; the Zone:Read
      // failure above will have been captured.
      if (firstZoneId) {
        try {
          await this.runner.withTimeout(
            cf.dns.records.list({ zone_id: firstZoneId }),
            "dns record list",
            CLOUDFLARE_TIMEOUT_MS,
          );
        } catch (dnsError) {
          if (this.isPermissionError(dnsError)) {
            missingPermissions.push("DNS:Edit");
            getLogger("integrations", "cloudflare-service").warn(
              {
                accountId,
                zoneId: firstZoneId,
                error:
                  dnsError instanceof Error
                    ? dnsError.message
                    : "Unknown error",
              },
              "Cloudflare token lacks DNS:Edit permission",
            );
          } else {
            throw dnsError;
          }
        }
      }

      const responseTime = Date.now() - startTime;
      metadata.accountId = accountId;

      if (missingPermissions.length > 0) {
        return this.recordValidationFailure(
          startTime,
          `API token is missing required permissions: ${missingPermissions.join(", ")}`,
          "MISSING_PERMISSIONS",
          metadata,
          responseTime,
        );
      }

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

      getLogger("integrations", "cloudflare-service").info(
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
      const { errorCode, connectivityStatus, isRetriable } =
        this.circuitBreaker.parseError(error);

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

      getLogger("integrations", "cloudflare-service").error(
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

  private async recordValidationFailure(
    startTime: number,
    message: string,
    errorCode: string,
    metadata?: Record<string, unknown>,
    responseTimeMs?: number,
  ): Promise<ValidationResult> {
    const result: ValidationResult = {
      isValid: false,
      message,
      errorCode,
      responseTimeMs: responseTimeMs ?? Date.now() - startTime,
      ...(metadata ? { metadata } : {}),
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

  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.getLatestConnectivityStatus();

    if (!latestStatus) {
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

  // ====================
  // Delegated tunnel API
  // ====================

  getTunnelConfig(tunnelId: string): Promise<CloudflareTunnelConfig | null> {
    return this.tunnelApi.getTunnelConfig(tunnelId);
  }

  getTunnelInfo(): Promise<TunnelListResponse[]> {
    return this.tunnelApi.getTunnelInfo();
  }

  updateTunnelConfig(
    tunnelId: string,
    config: CloudflareTunnelConfig["config"],
  ): Promise<CloudflareTunnelConfig | null> {
    return this.tunnelApi.updateTunnelConfig(tunnelId, config);
  }

  addHostname(
    tunnelId: string,
    hostname: string,
    service: string,
    path?: string,
    originRequest?: { httpHostHeader?: string },
  ): Promise<CloudflareTunnelConfig | null> {
    return this.tunnelApi.addHostname(
      tunnelId,
      hostname,
      service,
      path,
      originRequest,
    );
  }

  removeHostname(
    tunnelId: string,
    hostname: string,
    path?: string,
  ): Promise<CloudflareTunnelConfig | null> {
    return this.tunnelApi.removeHostname(tunnelId, hostname, path);
  }

  // ====================
  // Delegated zone / DNS
  // ====================

  getZoneId(domain: string): Promise<string> {
    return this.zoneApi.getZoneId(domain);
  }

  createDnsRecord(params: {
    zoneId: string;
    type: string;
    name: string;
    content: string;
    ttl: number;
  }): Promise<string> {
    return this.zoneApi.createDnsRecord(params);
  }

  deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    return this.zoneApi.deleteDnsRecord(zoneId, recordId);
  }

  // ====================
  // Delegated managed tunnels
  // ====================

  createManagedTunnel(
    environmentId: string,
    name: string,
    userId: string,
  ): Promise<{ tunnelId: string; tunnelName: string }> {
    return this.managedTunnels.create(environmentId, name, userId);
  }

  deleteManagedTunnel(environmentId: string, userId: string): Promise<void> {
    return this.managedTunnels.delete(environmentId, userId);
  }

  getManagedTunnelInfo(
    environmentId: string,
  ): Promise<ManagedTunnelSummary | null> {
    return this.managedTunnels.getInfo(environmentId);
  }

  getManagedTunnelToken(environmentId: string): Promise<string | null> {
    return this.managedTunnels.getToken(environmentId);
  }

  getAllManagedTunnels(): Promise<Map<string, ManagedTunnelSummary>> {
    return this.managedTunnels.getAll();
  }
}
