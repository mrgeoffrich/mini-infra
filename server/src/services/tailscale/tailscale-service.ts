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
   * domain.
   *
   * Two sources, tried in order:
   *   1. `GET /tailnet/-/dns/searchpaths` — populated only when the operator
   *      has configured custom MagicDNS search domains. Empty on most
   *      tailnets, including the default Tailscale-issued `tail-abc.ts.net`
   *      ones, so the original implementation always returned `null` and the
   *      Connect panel ended up with `url: null` for every endpoint.
   *   2. The first managed device's `name` field, which is always
   *      `<hostname>.<tailnet>.ts.net` for any tag:mini-infra-managed
   *      device. This is the reliable signal — every Mini Infra-owned device
   *      already encodes the suffix, and we already fetch the device list
   *      once per scheduler tick so this is at most one extra round-trip on
   *      the cold path.
   *
   * Returns `null` only when both sources are empty (a brand-new install
   * with no Mini Infra-managed devices yet). The `tailscale-web` addon's
   * `serve.json` uses runtime-substituted `${TS_CERT_DOMAIN}` so this lookup
   * is not load-bearing for traffic — it's a UI ergonomic only.
   */
  async getTailnetDomain(): Promise<string | null> {
    // The searchpaths endpoint is rarely useful but we keep trying it first
    // so operator-customised MagicDNS search domains still win. Failures
    // (network blip, missing OAuth scope, endpoint changes upstream) must
    // not skip the fallback — the device-list path is the reliable signal,
    // and a thrown searchpaths error would otherwise short-circuit the
    // whole resolution.
    let fromSearchPaths: string | null = null;
    try {
      fromSearchPaths = await this.fetchSearchPathTailnet();
    } catch (err) {
      const log = getLogger("integrations", "tailscale-service");
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "searchpaths lookup failed; falling back to device-name extraction",
      );
    }
    if (fromSearchPaths) return fromSearchPaths;
    return this.fetchTailnetFromManagedDevice();
  }

  private async fetchSearchPathTailnet(): Promise<string | null> {
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

  private async fetchTailnetFromManagedDevice(): Promise<string | null> {
    let devices: Array<TailscaleDeviceStatus & { id: string }>;
    try {
      devices = await this.fetchManagedDevices();
    } catch {
      // Best-effort fallback — never throw from the tailnet-domain path.
      return null;
    }
    for (const device of devices) {
      const suffix = extractTailnetSuffixFromDeviceName(device.name);
      if (suffix) return suffix;
    }
    return null;
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
    const mapped = await this.fetchManagedDevices();

    // Dedupe by hostname. Tailscale's tailnet uses DNS-name uniqueness, not
    // OS-hostname uniqueness — when an ephemeral container redeploys faster
    // than Tailscale can GC the previous registration, the new node gets an
    // auto-suffixed DNS name (`web-local-1.<tailnet>.ts.net`) but keeps the
    // OS hostname `web-local`, so two devices come back with the same
    // `hostname` field. Downstream consumers (the scheduler's
    // `devicesByHostname` map and the Connect panel's
    // `devicesByHostname.get(endpoint.hostname)` join) collapse to one row
    // per hostname, and JS Map insertion order means whichever arrived last
    // wins — usually the stale offline one.
    //
    // Pick the best representative per hostname: prefer online over offline,
    // then most-recent `lastSeen`. Stale ephemerals eventually get purged
    // upstream; until then this keeps the panel showing the live device.
    const byHostname = new Map<string, typeof mapped[number]>();
    for (const device of mapped) {
      const incumbent = byHostname.get(device.hostname);
      if (!incumbent) {
        byHostname.set(device.hostname, device);
        continue;
      }
      if (device.online && !incumbent.online) {
        byHostname.set(device.hostname, device);
        continue;
      }
      if (incumbent.online && !device.online) continue;
      // Same online state — break the tie on lastSeen (most recent wins).
      const incumbentMs = incumbent.lastSeen ? Date.parse(incumbent.lastSeen) : 0;
      const deviceMs = device.lastSeen ? Date.parse(device.lastSeen) : 0;
      if (deviceMs > incumbentMs) {
        byHostname.set(device.hostname, device);
      }
    }
    return Array.from(byHostname.values());
  }

  /**
   * Fetch + filter the raw managed-device list with NO hostname dedupe.
   * `listDevices` collapses duplicates to a single row per hostname for the
   * Connect panel, but the redeploy-cleanup path on `purgeStaleManagedDevicesByHostname`
   * needs every duplicate so it can purge each stale registration individually.
   */
  private async fetchManagedDevices(): Promise<
    Array<TailscaleDeviceStatus & { id: string }>
  > {
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

  /**
   * Delete a single tailnet device by node id (`DELETE /api/v2/device/:id`).
   * Used by the redeploy-cleanup path to release a stale OS-hostname slot
   * before a fresh sidecar registers — without it the new device gets
   * Tailscale's auto-suffixed DNS name (`<host>-1.<tailnet>.ts.net`) until
   * the upstream ephemeral GC catches up.
   */
  async deleteDevice(deviceId: string): Promise<void> {
    if (!deviceId || deviceId.length === 0) {
      throw new Error("deviceId is required");
    }
    const accessToken = await this.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      DEFAULT_REQUEST_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${TAILSCALE_API_BASE}/device/${encodeURIComponent(deviceId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        },
      );
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError") {
        throw new TailscaleAuthError(
          "Tailscale device-delete request timed out",
          TAILSCALE_ERROR_CODES.NETWORK_ERROR,
        );
      }
      throw new TailscaleAuthError(
        `Failed to reach Tailscale device-delete endpoint: ${
          err instanceof Error ? err.message : "unknown"
        }`,
        TAILSCALE_ERROR_CODES.NETWORK_ERROR,
      );
    } finally {
      clearTimeout(timer);
    }

    // 404 means the device is already gone — Tailscale's GC beat us to it.
    // That's the post-condition we wanted, so treat it as success.
    if (response.status === 404) return;
    if (!response.ok) {
      const text = await safeReadText(response);
      throw new TailscaleAuthError(
        `Tailscale device-delete failed (HTTP ${response.status}): ${text}`,
        TAILSCALE_ERROR_CODES.TAILSCALE_API_ERROR,
      );
    }
  }

  /**
   * Best-effort cleanup before re-registering an addon-derived sidecar:
   * delete every **offline** managed device that shares this hostname, so
   * the freshly-minted authkey lets the new sidecar register under the
   * unsuffixed DNS name (`<host>.<tailnet>.ts.net`) instead of getting an
   * auto-suffixed `-1`/`-2`/… because Tailscale's ephemeral GC is still
   * dragging its feet on the old registration.
   *
   * Hard rule: never delete an **online** device. The provision path runs
   * on every apply (the authkey is regenerated even when the sidecar isn't
   * recreated), so deleting a healthy live device would kick our own
   * running sidecar off the tailnet on every apply.
   *
   * Never throws — device cleanup is a UX nicety, not a correctness gate.
   * If Tailscale is unreachable or the delete fails the new sidecar still
   * registers (just with a suffix), and `listDevices`'s hostname dedupe
   * keeps the Connect panel showing the live one.
   */
  async purgeStaleManagedDevicesByHostname(
    hostname: string,
  ): Promise<{ deleted: number; errors: number }> {
    const log = getLogger("integrations", "tailscale-service");
    let deleted = 0;
    let errors = 0;
    let candidates: Array<TailscaleDeviceStatus & { id: string }>;
    try {
      const all = await this.fetchManagedDevices();
      candidates = all.filter((d) => d.hostname === hostname && !d.online);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), hostname },
        "Failed to list devices for stale-hostname purge (non-fatal)",
      );
      return { deleted: 0, errors: 1 };
    }

    if (candidates.length === 0) return { deleted: 0, errors: 0 };

    log.info(
      { hostname, candidateCount: candidates.length },
      "Purging stale managed tailnet devices before re-registration",
    );

    for (const device of candidates) {
      try {
        await this.deleteDevice(device.id);
        deleted++;
      } catch (err) {
        errors++;
        log.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            deviceId: device.id,
            hostname,
          },
          "Failed to delete stale tailnet device (non-fatal)",
        );
      }
    }
    return { deleted, errors };
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

/**
 * Extract the tailnet MagicDNS suffix from a managed device's `name` field.
 * Tailscale emits `name` as `<hostname>.<tailnet-suffix>` (sometimes with a
 * trailing dot in FQDN form), so the suffix is everything after the first
 * dot.
 *
 * Returns `null` when the input is empty or has no dot — defensive against
 * a future Tailscale schema change rather than a current bug.
 *
 * Exported for unit testing — `getTailnetDomain` is the production caller.
 */
export function extractTailnetSuffixFromDeviceName(
  name: string | null | undefined,
): string | null {
  if (!name || name.length === 0) return null;
  const trimmed = name.replace(/\.$/, "");
  const dot = trimmed.indexOf(".");
  if (dot < 0) return null;
  const suffix = trimmed.slice(dot + 1);
  return suffix.length > 0 ? suffix : null;
}
