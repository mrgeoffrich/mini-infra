// ====================
// Tailscale Connected Service Types
// ====================

/** Default tag the OAuth client must own and that all minted authkeys carry. */
export const TAILSCALE_DEFAULT_TAG = "tag:mini-infra-managed";

/** Settings keys persisted in the `tailscale` configuration category. */
export const TAILSCALE_SETTING_KEYS = {
  CLIENT_ID: "client_id",
  CLIENT_SECRET: "client_secret",
  EXTRA_TAGS: "extra_tags",
} as const;

/** GET /api/settings/tailscale — current configuration state. */
export interface TailscaleSettingsResponse {
  success: boolean;
  data: {
    isConfigured: boolean;
    hasClientSecret: boolean;
    clientId?: string;
    extraTags?: string[];
    aclSnippet: string;
    isValid?: boolean;
    validationMessage?: string;
    validationErrorCode?: TailscaleErrorCode;
  };
}

/** POST/PATCH /api/settings/tailscale — payload shape. */
export interface TailscaleSettingsRequest {
  client_id: string;
  client_secret?: string;
  extra_tags?: string[];
}

/** POST /api/settings/tailscale/test — validation result. */
export interface TailscaleValidationResponse {
  success: boolean;
  data: {
    isValid: boolean;
    message: string;
    errorCode?: string;
    metadata?: Record<string, unknown>;
    responseTimeMs: number;
  };
}

/** Response shape from `POST https://api.tailscale.com/api/v2/oauth/token`. */
export interface TailscaleOAuthTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/** Capability shape for `POST /api/v2/tailnet/-/keys`. */
export interface TailscaleAuthkeyRequest {
  capabilities: {
    devices: {
      create: {
        reusable: boolean;
        ephemeral: boolean;
        preauthorized: boolean;
        tags: string[];
      };
    };
  };
  expirySeconds: number;
}

/** Response shape from `POST /api/v2/tailnet/-/keys`. */
export interface TailscaleAuthkeyResponse {
  id: string;
  key: string;
  created: string;
  expires: string;
  capabilities: TailscaleAuthkeyRequest["capabilities"];
}

/**
 * One tailnet device as the Phase 5 device-status poller cares about it.
 * Subset of the full `GET /api/v2/tailnet/-/devices` payload — only the
 * fields the Connect panel and connection-status indicator consume. The
 * scheduler trims the upstream response to this shape so the rest of the
 * server (and the API surface) doesn't have to know about Tailscale's
 * full device JSON.
 *
 * `online` is derived from `lastSeen` ≤ 5 minutes ago (Tailscale's own
 * heuristic — `online: true` from the API can lag a heartbeat). The
 * scheduler is the single source of truth for that derivation.
 */
export interface TailscaleDeviceStatus {
  /** Tailnet device ID (`nodeId`). Stable across restarts of the same node. */
  id: string;
  /** Hostname the sidecar registered under (e.g. `web-app-prod`). */
  hostname: string;
  /** Full tailnet name (e.g. `web-app-prod.tail-abc.ts.net`). */
  name: string;
  /** Whether the device is currently online per the lastSeen heuristic. */
  online: boolean;
  /** ISO-8601 timestamp of the device's last keepalive. Null when never seen. */
  lastSeen: string | null;
  /** Tags applied to the device (lowercased, includes `tag:mini-infra-managed`). */
  tags: string[];
}

/** GET /api/tailscale/devices — current device set + the resolved tailnet domain. */
export interface TailscaleDevicesResponse {
  /** Tailnet MagicDNS suffix (e.g. `tail-abc.ts.net`); null when unresolved. */
  tailnet: string | null;
  /** All devices Mini Infra owns under `tag:mini-infra-managed`. */
  devices: TailscaleDeviceStatus[];
  /** ISO-8601 timestamp of the most recent successful poller tick. */
  lastUpdatedAt: string | null;
}

/**
 * Payload for the Socket.IO `tailscale:device:online` / `tailscale:device:offline`
 * events. The Connect panel uses this to flip the per-row status badge
 * without re-fetching the full device list.
 */
export interface TailscaleDeviceStatusEvent {
  device: TailscaleDeviceStatus;
}

/**
 * One addon-derived endpoint surfaced on the stack-detail Connect panel.
 * Endpoint *URLs* are derived server-side so the host/tailnet formatting
 * lives in one place — the panel renders these strings as-is.
 */
export interface TailscaleAddonEndpoint {
  /** Authored service this sidecar wraps. */
  targetService: string;
  /** Synthetic sidecar service name (e.g. `web-app-tailscale`). */
  syntheticServiceName: string;
  /** `tailscale-ssh` and/or `tailscale-web` ids that produced this endpoint. */
  addonIds: string[];
  /** SSH or HTTPS — drives the action affordance on the row. */
  kind: "ssh" | "https";
  /** Sanitised `<service>-<env>` hostname. Stable join key against device status. */
  hostname: string;
  /**
   * The full reachable URL.
   * - `kind: 'ssh'` → `ssh root@<hostname>.<tailnet>.ts.net`
   * - `kind: 'https'` → `https://<hostname>.<tailnet>.ts.net[<path>]`
   *
   * Null when the tailnet domain hasn't been resolved yet — the panel still
   * renders the row with `<hostname>` so the operator sees the addon attached.
   */
  url: string | null;
}

/** GET /api/stacks/:id/addon-endpoints — derived endpoint list for the Connect panel. */
export interface TailscaleAddonEndpointsResponse {
  endpoints: TailscaleAddonEndpoint[];
}

/** Validation error categories surfaced to the form. */
export const TAILSCALE_ERROR_CODES = {
  MISSING_CREDENTIALS: "MISSING_CREDENTIALS",
  INVALID_CLIENT: "INVALID_CLIENT",
  INVALID_TAG: "INVALID_TAG",
  NETWORK_ERROR: "NETWORK_ERROR",
  TAILSCALE_API_ERROR: "TAILSCALE_API_ERROR",
} as const;

export type TailscaleErrorCode =
  (typeof TAILSCALE_ERROR_CODES)[keyof typeof TAILSCALE_ERROR_CODES];

/**
 * Tailscale control-plane hostnames an addon-materialised sidecar must reach
 * for `tailscaled` to come up. Encoded once so the `tailscale-ssh` /
 * `tailscale-web` addons emit the same `requiredEgress` set without
 * duplicating the list at each call site, and so a future control-plane
 * change is a one-line edit.
 *
 * Wildcard entries cover regional control-plane shards (`*.tailscale.com`)
 * and DERP relays (`*.tailscale.io`); the explicit `controlplane.tailscale.com`
 * entry guards against an environment whose egress firewall doesn't honour
 * the matching wildcard.
 */
export const TAILSCALE_CONTROL_PLANE_HOSTNAMES: readonly string[] = [
  "controlplane.tailscale.com",
  "*.tailscale.com",
  "*.tailscale.io",
] as const;

/**
 * Merge the static `tag:mini-infra-managed` tag with operator-supplied
 * `extraTags`, deduping and preserving order (default first). Used by the
 * authkey minter and the addon framework's `provision()` hooks to compose
 * the tag set for a freshly-minted authkey.
 */
export function buildTailscaleTagSet(extraTags: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of [TAILSCALE_DEFAULT_TAG, ...extraTags]) {
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * Hostname-sanitise `{stack}-{service}-{env}` for use as a Tailscale device
 * hostname.
 *
 * RFC 1123 hostname rules: ≤63 octets, lowercase ASCII alphanumerics + hyphen,
 * no leading or trailing hyphen. Tailscale further requires the hostname to
 * be unique across the tailnet within the OAuth client's scope, so the
 * combined triple encodes per-resource identity — the OAuth client tag set
 * is fixed at `tag:mini-infra-managed` (see §Phase 3), and stack name is
 * already unique within a Mini Infra instance, so prefixing with stack name
 * is what stops two stacks that both define `web/prod` from racing for the
 * same tailnet device.
 *
 * Overflow rule: when the sanitised triple exceeds 63 chars, truncate the
 * readable head to 54 chars and append a `-{fnv1a32-hex8}` disambiguator
 * computed over the unsanitised inputs. The hash isn't cryptographic —
 * it's collision-resistance for short strings, and 32 bits is plenty given
 * how few oversized hostnames any one tailnet will see.
 */
export function sanitizeTailscaleHostname(
  stackName: string,
  serviceName: string,
  envName: string,
): string {
  const raw = `${stackName}-${serviceName}-${envName}`;
  // Lowercase, replace non-[a-z0-9-] with `-`, collapse runs of `-`.
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    throw new Error(
      `Cannot derive Tailscale hostname from "${stackName}-${serviceName}-${envName}" — no valid characters`,
    );
  }
  if (cleaned.length <= 63) return cleaned;
  // Overflow: keep the first 54 chars of the cleaned head (after trimming
  // any trailing hyphen left by the cut), then append `-{hash}` where hash
  // is FNV-1a-32 of the unsanitised triple, hex-encoded to 8 chars. The
  // pipe separator can't appear in any sanitised hostname so the hash
  // domain stays distinct from the visible head.
  const HASH_HEX_LEN = 8;
  const HEAD_BUDGET = 63 - 1 - HASH_HEX_LEN; // 54
  const head = cleaned.slice(0, HEAD_BUDGET).replace(/-+$/, "");
  const hash = fnv1a32Hex(`${stackName}|${serviceName}|${envName}`);
  return `${head}-${hash}`;
}

/**
 * 32-bit FNV-1a → 8-char hex. Non-cryptographic but adequate for
 * disambiguating overflowing Tailscale hostnames (32 bits, birthday-bound
 * around ~65k inputs). Inline so `lib/` keeps its zero-dependency posture
 * and the bundle stays browser-safe (no `node:crypto` import).
 */
function fnv1a32Hex(input: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Canonical Tailscale ACL bootstrap snippet for the operator to paste into
 * their tailnet policy file at https://login.tailscale.com/admin/acls.
 *
 * Single source of truth — the form's live preview, the docs page, and the
 * server-side settings response all render the same JSON. Pure helper so the
 * unit tests pin the output shape.
 */
export function buildAclSnippet(extraTags: string[] = []): string {
  const tags = buildTailscaleTagSet(extraTags);
  const acl = {
    tagOwners: Object.fromEntries(tags.map((t) => [t, ["autogroup:admin"]])),
    grants: [
      {
        src: ["autogroup:member"],
        dst: tags,
        ip: ["*"],
      },
    ],
    ssh: [
      {
        action: "check",
        src: ["autogroup:member"],
        dst: tags,
        users: ["root", "autogroup:nonroot"],
        checkPeriod: "12h",
      },
    ],
  };
  return JSON.stringify(acl, null, 2);
}
