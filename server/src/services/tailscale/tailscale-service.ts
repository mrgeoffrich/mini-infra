import { PrismaClient } from "../../lib/prisma";
import {
  ValidationResult,
  ServiceHealthStatus,
  ConnectivityStatusType,
  TailscaleDeviceStatus,
  TailscaleOAuthTokenResponse,
  TAILSCALE_SETTING_KEYS,
  TAILSCALE_DEFAULT_TAG,
  TAILSCALE_ERROR_CODES,
} from "@mini-infra/types";
import { ConfigurationService } from "../configuration-base";
import { getLogger } from "../../lib/logger-factory";

const TAILSCALE_API_BASE = "https://api.tailscale.com/api/v2";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 minutes before expiry
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  clientIdHash: string;
}

/**
 * TailscaleService owns the Tailscale connected-service integration:
 * credential storage (`client_id`, encrypted `client_secret`, optional
 * `extra_tags`), OAuth `client_credentials` access-token minting with
 * pre-expiry refresh, and health validation against the Tailscale API.
 *
 * Authkey minting against `/api/v2/tailnet/-/keys` lives in
 * {@link TailscaleAuthkeyMinter} which composes this service for
 * access-token retrieval.
 */
export class TailscaleService extends ConfigurationService {
  private cachedToken: CachedToken | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(prisma: PrismaClient, fetchImpl: typeof fetch = fetch) {
    super(prisma, "tailscale");
    this.fetchImpl = fetchImpl;
  }

  // ====================
  // Credential storage
  // ====================

  async setClientId(clientId: string, userId: string): Promise<void> {
    if (!clientId || clientId.trim().length === 0) {
      throw new Error("Tailscale OAuth client_id cannot be empty");
    }
    await this.set(TAILSCALE_SETTING_KEYS.CLIENT_ID, clientId.trim(), userId);
    this.cachedToken = null;
  }

  async setClientSecret(clientSecret: string, userId: string): Promise<void> {
    if (!clientSecret || clientSecret.trim().length === 0) {
      throw new Error("Tailscale OAuth client_secret cannot be empty");
    }
    await this.setSecure(
      TAILSCALE_SETTING_KEYS.CLIENT_SECRET,
      clientSecret.trim(),
      userId,
    );
    this.cachedToken = null;
  }

  async setExtraTags(extraTags: string[], userId: string): Promise<void> {
    const normalized = (extraTags ?? [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .filter((t) => t !== TAILSCALE_DEFAULT_TAG);
    for (const tag of normalized) {
      if (!/^tag:[a-z0-9-]+$/.test(tag)) {
        throw new Error(`Invalid tag '${tag}' — must match tag:[a-z0-9-]+`);
      }
    }
    await this.set(
      TAILSCALE_SETTING_KEYS.EXTRA_TAGS,
      JSON.stringify(normalized),
      userId,
    );
  }

  async getClientId(): Promise<string | null> {
    return this.get(TAILSCALE_SETTING_KEYS.CLIENT_ID);
  }

  async getClientSecret(): Promise<string | null> {
    return this.getSecure(TAILSCALE_SETTING_KEYS.CLIENT_SECRET);
  }

  async getExtraTags(): Promise<string[]> {
    const raw = await this.get(TAILSCALE_SETTING_KEYS.EXTRA_TAGS);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
    } catch {
      return [];
    }
  }

  /** All tags Mini Infra mints authkeys with (default + operator extras). */
  async getAllManagedTags(): Promise<string[]> {
    return [TAILSCALE_DEFAULT_TAG, ...(await this.getExtraTags())];
  }

  async removeConfiguration(userId: string): Promise<void> {
    for (const key of Object.values(TAILSCALE_SETTING_KEYS)) {
      try {
        await this.delete(key, userId);
      } catch {
        // Key may not exist — keep going.
      }
    }
    this.cachedToken = null;
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
  // OAuth token minting
  // ====================

  /**
   * Mint a fresh Tailscale OAuth access token using the stored
   * `client_credentials`. Tokens are cached in-process and refreshed when
   * they fall within {@link TOKEN_REFRESH_MARGIN_MS} of expiry. Cache is
   * invalidated whenever credentials change.
   *
   * Optional `overrides` supports validate-without-save flows (the form
   * exercises pasted credentials before storing them).
   */
  async getAccessToken(overrides?: {
    clientId?: string;
    clientSecret?: string;
  }): Promise<string> {
    const clientId = overrides?.clientId ?? (await this.getClientId());
    const clientSecret =
      overrides?.clientSecret ?? (await this.getClientSecret());

    if (!clientId || !clientSecret) {
      throw new TailscaleAuthError(
        "Tailscale OAuth credentials are not configured",
        TAILSCALE_ERROR_CODES.MISSING_CREDENTIALS,
      );
    }

    const clientIdHash = clientId; // client_id is non-sensitive; doubles as cache key
    const now = Date.now();
    if (
      !overrides &&
      this.cachedToken &&
      this.cachedToken.clientIdHash === clientIdHash &&
      this.cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS > now
    ) {
      return this.cachedToken.accessToken;
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
    });

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      DEFAULT_REQUEST_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(`${TAILSCALE_API_BASE}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError") {
        throw new TailscaleAuthError(
          "Tailscale OAuth token request timed out",
          TAILSCALE_ERROR_CODES.NETWORK_ERROR,
        );
      }
      throw new TailscaleAuthError(
        `Failed to reach Tailscale OAuth endpoint: ${
          err instanceof Error ? err.message : "unknown"
        }`,
        TAILSCALE_ERROR_CODES.NETWORK_ERROR,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      if (response.status === 400 || response.status === 401) {
        throw new TailscaleAuthError(
          `Tailscale rejected the OAuth credentials (HTTP ${response.status}): ${text}`,
          TAILSCALE_ERROR_CODES.INVALID_CLIENT,
        );
      }
      throw new TailscaleAuthError(
        `Tailscale OAuth token request failed (HTTP ${response.status}): ${text}`,
        TAILSCALE_ERROR_CODES.TAILSCALE_API_ERROR,
      );
    }

    const data = (await response.json()) as TailscaleOAuthTokenResponse;
    if (!data.access_token || typeof data.expires_in !== "number") {
      throw new TailscaleAuthError(
        "Tailscale OAuth response missing access_token or expires_in",
        TAILSCALE_ERROR_CODES.TAILSCALE_API_ERROR,
      );
    }

    if (!overrides) {
      this.cachedToken = {
        accessToken: data.access_token,
        expiresAt: now + data.expires_in * 1000,
        clientIdHash,
      };
    }

    return data.access_token;
  }

  // ====================
  // Validation / health
  // ====================

  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    const startTime = Date.now();
    const log = getLogger("integrations", "tailscale-service");

    const overrides = settings
      ? {
          clientId: settings.clientId ?? settings.client_id,
          clientSecret: settings.clientSecret ?? settings.client_secret,
        }
      : undefined;

    try {
      // Mint an access token first — this is the green-light criterion the
      // ticket spec calls out for the connectivity prober.
      await this.getAccessToken(overrides);

      const responseTime = Date.now() - startTime;
      const metadata: Record<string, unknown> = {
        clientIdLength: (overrides?.clientId ?? (await this.getClientId()))?.length ?? 0,
      };

      const result: ValidationResult = {
        isValid: true,
        message: "Tailscale OAuth credentials minted an access token",
        responseTimeMs: responseTime,
        metadata,
      };

      await this.recordConnectivityStatus(
        "connected",
        responseTime,
        undefined,
        undefined,
        metadata,
      );

      log.info(
        { responseTime },
        "Tailscale validation successful",
      );

      return result;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorCode =
        error instanceof TailscaleAuthError
          ? error.errorCode
          : TAILSCALE_ERROR_CODES.TAILSCALE_API_ERROR;
      const message =
        error instanceof Error
          ? error.message
          : "Unknown Tailscale validation error";
      const status: ConnectivityStatusType =
        errorCode === TAILSCALE_ERROR_CODES.NETWORK_ERROR
          ? "unreachable"
          : "failed";

      const result: ValidationResult = {
        isValid: false,
        message,
        errorCode,
        responseTimeMs: responseTime,
      };

      await this.recordConnectivityStatus(
        status,
        responseTime,
        message,
        errorCode,
      );

      log.warn(
        { errorCode, responseTime, error: message },
        "Tailscale validation failed",
      );

      return result;
    }
  }

  /**
   * Resolve the tailnet's MagicDNS suffix (e.g. `tail-abc.ts.net`) so callers
   * can compose `https://<host>.<tailnet>.ts.net` URLs without hardcoding the
   * domain. Tailscale exposes the suffix via the DNS search paths on the
   * tailnet — `searchPaths[0]` is the MagicDNS suffix when MagicDNS is on.
   *
   * Used by the `tailscale-web` addon to populate `templateVars.tailnetDomain`
   * for downstream UI (Phase 5 Connect panel). The `serve.json` itself uses
   * the runtime-substituted `${TS_CERT_DOMAIN}` so this lookup is not
   * load-bearing for traffic — it's a UI ergonomic.
   */
  async getTailnetDomain(): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      DEFAULT_REQUEST_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${TAILSCALE_API_BASE}/tailnet/-/dns/searchpaths`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        },
      );
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError") {
        throw new TailscaleAuthError(
          "Tailscale DNS searchpaths request timed out",
          TAILSCALE_ERROR_CODES.NETWORK_ERROR,
        );
      }
      throw new TailscaleAuthError(
        `Failed to reach Tailscale DNS endpoint: ${
          err instanceof Error ? err.message : "unknown"
        }`,
        TAILSCALE_ERROR_CODES.NETWORK_ERROR,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new TailscaleAuthError(
        `Tailscale DNS searchpaths request failed (HTTP ${response.status}): ${text}`,
        TAILSCALE_ERROR_CODES.TAILSCALE_API_ERROR,
      );
    }

    const data = (await response.json()) as { searchPaths?: string[] };
    const first = data.searchPaths?.find(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    if (!first) return null;
    // The endpoint returns paths with a trailing dot (FQDN form) on some
    // tailnets; normalise to the bare suffix.
    return first.replace(/\.$/, "");
  }

  /**
   * List every tailnet device Mini Infra owns under `tag:mini-infra-managed`.
   * Trims the upstream `GET /api/v2/tailnet/-/devices` payload down to the
   * fields the device-status poller and Connect panel consume.
   *
   * `online` is derived locally rather than read from the API: Tailscale's
   * `online` flag can lag a heartbeat, and the design contract is "badges
   * flip within ~5s of a deliberate device-down test" — recomputing from
   * `lastSeen` keeps the poller and the API consistent.
   */
  async listDevices(): Promise<TailscaleDeviceStatus[]> {
    const accessToken = await this.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      DEFAULT_REQUEST_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${TAILSCALE_API_BASE}/tailnet/-/devices`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        },
      );
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError") {
        throw new TailscaleAuthError(
          "Tailscale device-list request timed out",
          TAILSCALE_ERROR_CODES.NETWORK_ERROR,
        );
      }
      throw new TailscaleAuthError(
        `Failed to reach Tailscale device-list endpoint: ${
          err instanceof Error ? err.message : "unknown"
        }`,
        TAILSCALE_ERROR_CODES.NETWORK_ERROR,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new TailscaleAuthError(
        `Tailscale device-list request failed (HTTP ${response.status}): ${text}`,
        TAILSCALE_ERROR_CODES.TAILSCALE_API_ERROR,
      );
    }

    const data = (await response.json()) as { devices?: unknown };
    if (!Array.isArray(data.devices)) return [];

    const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
    const now = Date.now();
    const managedTags = await this.getAllManagedTags();
    const managedTagSet = new Set(managedTags);

    return data.devices
      .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
      .map((d) => {
        const tags = Array.isArray(d.tags)
          ? d.tags.filter((t): t is string => typeof t === "string")
          : [];
        const lastSeenRaw = typeof d.lastSeen === "string" ? d.lastSeen : null;
        const lastSeenMs = lastSeenRaw ? Date.parse(lastSeenRaw) : NaN;
        const online =
          !Number.isNaN(lastSeenMs) && now - lastSeenMs <= ONLINE_THRESHOLD_MS;
        return {
          id: typeof d.nodeId === "string" ? d.nodeId : String(d.id ?? ""),
          hostname: typeof d.hostname === "string" ? d.hostname : "",
          name: typeof d.name === "string" ? d.name : "",
          online,
          lastSeen: lastSeenRaw,
          tags,
        } satisfies TailscaleDeviceStatus & { id: string };
      })
      .filter((d) => d.id && d.hostname)
      .filter((d) => d.tags.some((t) => managedTagSet.has(t)));
  }

  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.getLatestConnectivityStatus();

    if (!latestStatus) {
      const validationResult = await this.validate();
      return {
        service: "tailscale",
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
      service: "tailscale",
      status: latestStatus.status as ConnectivityStatusType,
      lastChecked: latestStatus.checkedAt,
      lastSuccessful: latestStatus.lastSuccessfulAt,
      responseTime: latestStatus.responseTimeMs,
      errorMessage: latestStatus.errorMessage,
      errorCode: latestStatus.errorCode,
      metadata: latestStatus.metadata
        ? (JSON.parse(latestStatus.metadata) as Record<string, unknown>)
        : undefined,
    };
  }
}

/**
 * Typed error raised by the Tailscale service so callers can branch on the
 * known {@link TAILSCALE_ERROR_CODES} categories without string-matching.
 */
export class TailscaleAuthError extends Error {
  readonly errorCode: string;

  constructor(message: string, errorCode: string) {
    super(message);
    this.name = "TailscaleAuthError";
    this.errorCode = errorCode;
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unavailable>";
  }
}
