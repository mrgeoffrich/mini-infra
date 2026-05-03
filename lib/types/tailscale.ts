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
