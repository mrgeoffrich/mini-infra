import { ErrorMapper } from "../circuit-breaker";
import type { Logger } from "pino";
import type { ConnectivityStatusType } from "@mini-infra/types";
import type { CircuitBreaker } from "../circuit-breaker";

// ====================
// API Configuration
// ====================

export const GITHUB_API_BASE = "https://api.github.com";
export const TIMEOUT_MS = 15000;

// ====================
// Error Mappers
// ====================

/**
 * GitHub App-specific error mappers for the circuit breaker.
 */
export const GITHUB_APP_ERROR_MAPPERS: ErrorMapper[] = [
  {
    pattern: /Bad credentials|Unauthorized|401/,
    errorCode: "AUTH_ERROR",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: /Forbidden|403/,
    errorCode: "FORBIDDEN",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: /Not Found|404/,
    errorCode: "NOT_FOUND",
    connectivityStatus: "failed",
    isRetriable: false,
  },
  {
    pattern: /rate limit|429/,
    errorCode: "RATE_LIMITED",
    connectivityStatus: "failed",
    isRetriable: true,
  },
  {
    pattern: /timeout|ETIMEDOUT/,
    errorCode: "TIMEOUT",
    connectivityStatus: "unreachable",
    isRetriable: true,
  },
  {
    pattern: /ENOTFOUND|ECONNREFUSED|ECONNRESET|network/i,
    errorCode: "NETWORK_ERROR",
    connectivityStatus: "unreachable",
    isRetriable: true,
  },
];

// ====================
// Setting Keys
// ====================

export const SETTING_KEYS = {
  APP_ID: "app_id",
  PRIVATE_KEY: "private_key",
  INSTALLATION_ID: "installation_id",
  WEBHOOK_SECRET: "webhook_secret",
  APP_SLUG: "app_slug",
  OWNER: "owner",
  OWNER_TYPE: "owner_type",
  PERMISSIONS: "permissions",
  CLIENT_ID: "client_id",
  CLIENT_SECRET: "client_secret",
  OAUTH_ACCESS_TOKEN: "oauth_access_token",
  OAUTH_REFRESH_TOKEN: "oauth_refresh_token",
  OAUTH_EXPIRES_AT: "oauth_expires_at",
  AGENT_GITHUB_TOKEN: "agent_github_token",
  AGENT_GITHUB_ACCESS_LEVEL: "agent_github_access_level",
} as const;

/**
 * All setting keys for iteration during removal.
 */
export const ALL_SETTING_KEYS = Object.values(SETTING_KEYS);

// ====================
// Context Interfaces
// ====================

/**
 * Shared context passed to all sub-modules, providing access to
 * settings storage and HTTP without exposing the full service.
 */
export interface GitHubAppContext {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string, userId: string): Promise<void>;
  deleteSetting(key: string, userId: string): Promise<void>;
  fetchGitHub(url: string, options?: RequestInit): Promise<Response>;
  logger: Logger;
}

/**
 * Extended context for the validation module, which needs circuit breaker
 * and connectivity recording capabilities.
 */
export interface GitHubAppValidationContext extends GitHubAppContext {
  circuitBreaker: CircuitBreaker;
  recordConnectivityStatus(
    status: ConnectivityStatusType,
    responseTimeMs?: number,
    errorMessage?: string,
    errorCode?: string,
    metadata?: Record<string, unknown>,
    userId?: string,
  ): Promise<void>;
  getLatestConnectivityStatus(): Promise<any | null>;
}
