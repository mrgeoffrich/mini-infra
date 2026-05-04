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
 * Hostname-sanitise `{service}-{env}` for use as a Tailscale device hostname.
 *
 * RFC 1123 hostname rules: ≤63 octets, lowercase ASCII alphanumerics + hyphen,
 * no leading or trailing hyphen. Tailscale further requires the hostname to
 * be unique across the tailnet within the OAuth client's scope, so the
 * combined `{service}-{env}` form encodes per-resource identity (the OAuth
 * client tag set is fixed at `tag:mini-infra-managed`, see §Phase 3).
 *
 * Mirrors the spirit of `buildPoolContainerName` in pool-spawner.ts but lives
 * here in lib/ because the addon framework is the only consumer that needs
 * RFC-compliant Tailscale-specific output (pool spawner targets Docker
 * container names which are looser).
 */
export function sanitizeTailscaleHostname(
  serviceName: string,
  envName: string,
): string {
  const raw = `${serviceName}-${envName}`;
  // Lowercase, replace non-[a-z0-9-] with `-`, collapse runs of `-`.
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    throw new Error(
      `Cannot derive Tailscale hostname from "${serviceName}-${envName}" — no valid characters`,
    );
  }
  // Truncate to 63 octets; trim a trailing hyphen left after the cut.
  return cleaned.length <= 63
    ? cleaned
    : cleaned.slice(0, 63).replace(/-+$/, "");
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
