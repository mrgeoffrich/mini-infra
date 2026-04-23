import { PrismaClient } from "../../lib/prisma";
import { ConfigurationService } from "../configuration-base";
import type {
  ValidationResult,
  ServiceHealthStatus,
} from "@mini-infra/types";
import { VaultHttpClient } from "./vault-http-client";
import { getLogger } from "../../lib/logger-factory";

const log = getLogger("platform", "vault-config-service");

/**
 * Configuration service for the managed Vault. Stores the Vault address
 * (derived from the deployed stack) and exposes connectivity health checks
 * via the standard IConfigurationService contract.
 *
 * Settings keys:
 *   - `address` — base URL (e.g. http://mini-infra-vault:8200)
 *   - `stackId` — ID of the stack that owns the Vault container
 *   - `bootstrappedAt` — ISO timestamp, set on bootstrap-complete
 */
export class VaultConfigService extends ConfigurationService {
  constructor(prisma: PrismaClient) {
    super(prisma, "vault");
  }

  async validate(
    settings?: Record<string, string>,
  ): Promise<ValidationResult> {
    const address = settings?.address ?? (await this.get("address"));
    if (!address) {
      return {
        isValid: false,
        message: "Vault address is not configured",
        errorCode: "NOT_CONFIGURED",
      };
    }
    const start = Date.now();
    try {
      const client = new VaultHttpClient(address, { requestTimeoutMs: 5_000 });
      const health = await client.health();
      const responseTimeMs = Date.now() - start;
      if (!health) {
        await this.recordConnectivityStatus(
          "unreachable",
          responseTimeMs,
          "Vault sys/health did not respond",
          "UNREACHABLE",
        );
        return {
          isValid: false,
          message: "Vault is not reachable",
          errorCode: "UNREACHABLE",
          responseTimeMs,
        };
      }
      await this.recordConnectivityStatus(
        "connected",
        responseTimeMs,
        undefined,
        undefined,
        { initialized: health.initialized, sealed: health.sealed },
      );
      return {
        isValid: true,
        message: `Vault reachable (initialized=${health.initialized ?? "?"}, sealed=${health.sealed ?? "?"})`,
        responseTimeMs,
        metadata: {
          initialized: health.initialized,
          sealed: health.sealed,
          version: health.version,
        },
      };
    } catch (err) {
      const responseTimeMs = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, "Vault validate failed");
      await this.recordConnectivityStatus(
        "failed",
        responseTimeMs,
        msg,
        "PROBE_FAILED",
      );
      return {
        isValid: false,
        message: msg,
        errorCode: "PROBE_FAILED",
        responseTimeMs,
      };
    }
  }

  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latest = await this.getLatestConnectivityStatus();
    if (!latest) {
      return {
        service: "vault",
        status: "unreachable",
        lastChecked: new Date(),
        errorMessage: "No connectivity checks recorded yet",
      };
    }
    return {
      service: "vault",
      status: (latest.status as ServiceHealthStatus["status"]) ?? "unreachable",
      lastChecked: latest.checkedAt,
      lastSuccessful: latest.lastSuccessfulAt,
      responseTime: latest.responseTimeMs,
      errorMessage: latest.errorMessage,
      errorCode: latest.errorCode,
      metadata: latest.metadata ? safeJsonParse(latest.metadata) : undefined,
    };
  }
}

function safeJsonParse(s: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
