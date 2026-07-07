/**
 * Client-side error presentation layer (Phase 2 of
 * docs/planning/not-shipped/error-handling-overhaul-plan.md, §4.4).
 *
 * `getUserFacingError` turns a caught error — almost always an
 * `ApiRequestError` (see `client/src/lib/api-client.ts`) — into a
 * `{ title, description, action? }` triple suitable for a toast or an
 * inline error message. `toastApiError` renders that triple as a sonner
 * toast; it's called by default from the app `QueryClient`'s
 * `MutationCache.onError` (see `client/src/lib/query-client.ts`), so most
 * call sites don't need to call it directly at all.
 *
 * The interesting part is reconciling the two response shapes the server
 * can still send while each domain migrates onto the Phase 1 envelope
 * (`server/src/lib/error-handler.ts`):
 *
 *   1. Migrated routes (postgres-backup today; more each later phase):
 *      `{ error: <ErrorCode>, message: <human text>, resource?, action?,
 *      details? }` — `error` is a stable machine code, `message` is always
 *      present and human.
 *   2. Legacy, not-yet-migrated routes (e.g. the auth pages — see Phase 9):
 *      `{ error: <human text> }` with NO `message` field at all, so
 *      `ApiRequestError.message` falls back to the generic HTTP status text
 *      (see `extractMessage` in `api-client.ts`).
 *
 * We disambiguate the two by checking whether `.code` (== `body.error`)
 * itself reads as a machine code (`/^[A-Z0-9_]+$/`, per the naming rule in
 * `lib/types/error-codes.ts`) or as human prose — a real code never
 * contains lowercase letters, spaces, or punctuation.
 */

import { toast } from "sonner";
import { ErrorCode } from "@mini-infra/types";
import { ApiRequestError } from "./api-client";

export interface UserFacingError {
  title: string;
  description: string;
  action?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A real machine `ErrorCode` is SCREAMING_SNAKE; anything else is human prose. */
function isMachineCode(value: string): boolean {
  return /^[A-Z0-9_]+$/.test(value);
}

interface ErrorResource {
  type?: unknown;
  id?: unknown;
  name?: unknown;
}

function asResource(value: unknown): ErrorResource | undefined {
  return isRecord(value) ? value : undefined;
}

/** `"postgresBackupConfig"` / `"postgres_backup_config"` -> `"Postgres Backup Config"`. */
function humanizeResourceType(type: string): string {
  const spaced = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Short verb phrase describing what happened to a resource, by status class. */
function resourceVerbPhrase(status: number): string | undefined {
  if (status === 409) return "already exists";
  if (status === 404) return "not found";
  if (status === 403) return "not allowed";
  if (status === 400) return "invalid";
  return undefined;
}

/** Sharpens the generic status-class title using `body.resource`, when present (§4.4). */
function resourceTitle(resource: ErrorResource | undefined, status: number): string | undefined {
  if (!resource || typeof resource.type !== "string" || resource.type.length === 0) {
    return undefined;
  }
  const verb = resourceVerbPhrase(status);
  const label = humanizeResourceType(resource.type);
  return verb ? `${label} ${verb}` : label;
}

/**
 * A couple of known codes worth a nicer title than the generic status-class
 * fallback. Deliberately small and data-driven — the server's `message` /
 * `action` already carry the specifics, so this only needs to cover cases
 * where a curated noun phrase reads better than "already exists".
 */
const CODE_TITLES: Partial<Record<string, string>> = {
  [ErrorCode.POSTGRES_BACKUP_CONFIG_EXISTS]: "Backup already configured",
  [ErrorCode.POSTGRES_DB_CONFIG_EXISTS]: "Database already configured",

  // Auth / API keys / users / permissions (Phase 9)
  [ErrorCode.API_KEY_NOT_FOUND]: "API key not found",
  [ErrorCode.PERMISSION_PRESET_NAME_EXISTS]: "Preset name already taken",
  [ErrorCode.PERMISSION_PRESET_NOT_FOUND]: "Permission preset not found",
  [ErrorCode.AUTH_ACCOUNT_LOCKED]: "Account locked",

  // NATS — only where the generic status-class verb phrase ("already
  // exists" / "invalid") would misdescribe the failure (these are 400/409s
  // whose resource didn't "already exist" or get literally "invalidated").
  [ErrorCode.NATS_SYSTEM_ACCOUNT_PROTECTED]: "System account protected",
  [ErrorCode.NATS_IDENTITY_SEED_MISSING]: "NATS identity seed missing",
  [ErrorCode.NATS_IDENTITY_SEED_MISMATCH]: "NATS identity seed mismatch",
  [ErrorCode.NATS_IDENTITY_SEED_RESTORE_CONFLICT]: "Identity seed restore conflict",
  [ErrorCode.NATS_NOT_CONFIGURED]: "NATS not configured",
  [ErrorCode.NATS_SUBJECT_PREFIX_NOT_ALLOWLISTED]: "Subject prefix not allowlisted",
  [ErrorCode.NATS_IMPORT_INVALID]: "Invalid NATS import",
  [ErrorCode.NATS_IMPORT_PRODUCER_NOT_READY]: "Producer stack not ready",
  [ErrorCode.NATS_PREFIX_ALLOWLIST_OVERLAP]: "Prefix overlaps existing entry",

  // Environments / networks (Phase 4) — the generic 409 "already exists"
  // status-class fallback is actively misleading for these three: none of
  // them are about the target resource already existing.
  [ErrorCode.ENVIRONMENT_NETWORK_TYPE_CONFLICT]: "Network type already in use",
  [ErrorCode.ENVIRONMENT_HAPROXY_MIGRATION_IN_PROGRESS]: "Migration already in progress",
  [ErrorCode.DOCKER_NETWORK_IN_USE]: "Network still in use",
  // HAProxy (Phase 8) — curated over the auto-generated `resourceTitle()`
  // fallback mainly to keep "HAProxy" capitalized correctly (the generic
  // path would render the `haproxyFrontend` resource type as "Haproxy
  // Frontend").
  [ErrorCode.HAPROXY_FRONTEND_NOT_FOUND]: "Frontend not found",
  [ErrorCode.HAPROXY_ROUTE_NOT_FOUND]: "Route not found",
  [ErrorCode.HAPROXY_BACKEND_NOT_FOUND]: "Backend not found",
  [ErrorCode.HAPROXY_SERVER_NOT_FOUND]: "Server not found",
  [ErrorCode.HAPROXY_HOSTNAME_IN_USE]: "Hostname already in use",
  [ErrorCode.HAPROXY_CERTIFICATE_NOT_FOUND]: "Certificate not found",
  [ErrorCode.HAPROXY_CERTIFICATE_NOT_READY]: "Certificate not ready",
  [ErrorCode.HAPROXY_CONTAINER_UNAVAILABLE]: "HAProxy unavailable",
  [ErrorCode.HAPROXY_SETUP_IN_PROGRESS]: "Setup already in progress",
  [ErrorCode.HAPROXY_DATAPLANE_VERSION_CONFLICT]: "Configuration changed",
  // Certificates / TLS / ACME / DNS (Phase 5)
  [ErrorCode.TLS_CERTIFICATE_NOT_FOUND]: "Certificate not found",
  [ErrorCode.TLS_CERTIFICATE_ISSUANCE_IN_PROGRESS]: "Issuance already in progress",
  [ErrorCode.TLS_STORAGE_NOT_CONFIGURED]: "Certificate storage not configured",
  [ErrorCode.CLOUDFLARE_ZONE_NOT_FOUND]: "Cloudflare zone not found",
  [ErrorCode.CLOUDFLARE_TUNNEL_NOT_FOUND]: "Tunnel not found",
  [ErrorCode.CLOUDFLARE_MANAGED_TUNNEL_EXISTS]: "Managed tunnel already exists",
  [ErrorCode.CLOUDFLARE_MANAGED_TUNNEL_NOT_FOUND]: "Managed tunnel not found",
  [ErrorCode.CLOUDFLARE_TUNNEL_HOSTNAME_EXISTS]: "Hostname already exists",
  [ErrorCode.CLOUDFLARE_TUNNEL_HOSTNAME_NOT_FOUND]: "Hostname not found",
  // Containers / images / volumes (Phase 7)
  [ErrorCode.CONTAINER_ALREADY_IN_STATE]: "Container already in this state",
  [ErrorCode.CONTAINER_NOT_RUNNING]: "Container not running",
  [ErrorCode.VOLUME_IN_USE]: "Volume in use",
  [ErrorCode.IMAGE_AUTH_FAILED]: "Registry authentication failed",
  [ErrorCode.DOCKER_NOT_CONNECTED]: "Docker unavailable",
  // Stacks / applications / deployments (Phase 3) — every one of these is a
  // 409/400 whose resource-type-derived fallback (`resourceTitle()` above,
  // e.g. "Stack already exists" for any 409 on a `stack` resource) would be
  // actively misleading for a lock/state conflict rather than a duplicate,
  // or a 401 with no verb-phrase fallback at all.
  [ErrorCode.STACK_OPERATION_IN_PROGRESS]: "Operation in progress",
  [ErrorCode.STACK_PREREQUISITES_NOT_MET]: "Prerequisites not met",
  [ErrorCode.STACK_POOL_MAX_INSTANCES]: "Pool at capacity",
  [ErrorCode.STACK_POOL_STACK_IN_ERROR]: "Stack in error state",
  [ErrorCode.STACK_JOB_POOL_STACK_IN_ERROR]: "Stack in error state",
  [ErrorCode.STACK_TEMPLATE_HAS_DEPLOYED_STACK]: "Template still in use",
  [ErrorCode.STACK_NOT_DEPLOYED]: "Stack not deployed",
  [ErrorCode.STACK_HAS_ACTIVE_CONTAINERS]: "Stack has active containers",
  [ErrorCode.STACK_DOCKER_UNREACHABLE]: "Docker unreachable",
  [ErrorCode.STACK_TEMPLATE_NOT_PUBLISHED]: "Template not published",
  [ErrorCode.STACK_TEMPLATE_ARCHIVED]: "Template archived",
  [ErrorCode.STACK_TEMPLATE_SYSTEM_IMMUTABLE]: "System template",
  [ErrorCode.STACK_POOL_TOKEN_INVALID]: "Invalid pool token",
  [ErrorCode.STACK_POOL_AUTH_REQUIRED]: "Authentication required",
  // Vault / secrets / egress / self-update / monitoring (Phase 10)
  [ErrorCode.VAULT_LOCKED]: "Vault is locked",
  [ErrorCode.VAULT_NOT_CONFIGURED]: "Vault not configured",
  [ErrorCode.VAULT_INVALID_PASSPHRASE]: "Incorrect passphrase",
  [ErrorCode.VAULT_UNLOCK_RATE_LIMITED]: "Too many attempts",
  [ErrorCode.VAULT_KV_SEALED]: "Vault is sealed",
  [ErrorCode.VAULT_KV_STANDBY]: "Vault is on standby",
  [ErrorCode.VAULT_KV_UNAVAILABLE]: "Vault unavailable",
  [ErrorCode.VAULT_KV_PATH_NOT_FOUND]: "Secret not found",
  [ErrorCode.VAULT_POLICY_IN_USE]: "Policy in use",
  [ErrorCode.VAULT_APPROLE_BOUND_TO_STACKS]: "AppRole in use",
  [ErrorCode.STORAGE_NOT_CONFIGURED]: "Storage not configured",
  [ErrorCode.PROVIDER_NO_LONGER_CONFIGURED]: "Storage provider disconnected",
  [ErrorCode.BACKUP_STACK_NOT_DEPLOYED]: "Backup stack not deployed",
  [ErrorCode.BACKUP_CONCURRENCY_CAP_REACHED]: "Backup already running",
  [ErrorCode.SELF_UPDATE_IN_PROGRESS]: "Update already in progress",
  [ErrorCode.SELF_UPDATE_CONTAINER_ID_UNKNOWN]: "Self-update unavailable",
  [ErrorCode.MONITORING_SERVICE_UNAVAILABLE]: "Monitoring unavailable",

  // Phase 11 — integrations (nats/github-app/cloudflare/tailscale enforcement
  // sweep). All curated here because the generic 400 "invalid" / 404 "not
  // found" status-class fallback either misdescribes the failure (these
  // aren't malformed requests, they're missing config or an expired
  // credential) or renders the resource-type label with the wrong
  // capitalization ("Github" instead of "GitHub").
  [ErrorCode.GITHUB_APP_NOT_CONFIGURED]: "GitHub App not configured",
  [ErrorCode.GITHUB_APP_NOT_INSTALLED]: "GitHub App not installed",
  [ErrorCode.GITHUB_APP_OAUTH_NOT_CONFIGURED]: "GitHub OAuth not configured",
  [ErrorCode.GITHUB_APP_OAUTH_EXCHANGE_FAILED]: "GitHub authorization failed",
  [ErrorCode.GITHUB_APP_OAUTH_REAUTHORIZE_REQUIRED]: "Re-authorization required",
  [ErrorCode.GITHUB_APP_MANIFEST_CONVERSION_FAILED]: "GitHub App setup failed",
  [ErrorCode.GITHUB_APP_PACKAGE_NOT_FOUND]: "Package not found",
  [ErrorCode.GITHUB_APP_REPOSITORY_NOT_FOUND]: "Repository not found",
  [ErrorCode.TAILSCALE_CLIENT_ID_INVALID]: "Invalid OAuth client ID",
  [ErrorCode.TAILSCALE_CLIENT_SECRET_INVALID]: "Invalid OAuth client secret",
  [ErrorCode.TAILSCALE_TAG_INVALID]: "Invalid tag format",
};

function statusClassFallback(status: number): string {
  if (status === 409) return "Already exists";
  if (status === 403) return "Not allowed";
  if (status === 404) return "Not found";
  if (status === 400) return "Invalid request";
  if (status >= 500) return "Server error — try again";
  return "Something went wrong";
}

interface ZodIssueLike {
  path?: unknown;
  message?: unknown;
}

/**
 * Formats a Zod `issues` array (the `VALIDATION_FAILED` envelope's
 * `details`) into a readable sentence. Mirrors the per-hook
 * `validationErrorMessage` helper that used to live in
 * `use-postgres-backup-configs.ts` — folded in here so every
 * `ApiRequestError` goes through the one presentation layer instead of a
 * parallel path.
 */
function formatValidationDetails(details: unknown): string | undefined {
  if (!Array.isArray(details)) {
    return undefined;
  }
  const parts = details
    .map((raw): string | undefined => {
      if (!isRecord(raw)) return undefined;
      const issue = raw as ZodIssueLike;
      const message = typeof issue.message === "string" ? issue.message : undefined;
      if (!message) return undefined;
      const path = Array.isArray(issue.path) ? issue.path.join(".") : undefined;
      return path ? `${path}: ${message}` : message;
    })
    .filter((part): part is string => Boolean(part));

  return parts.length > 0 ? `Validation failed: ${parts.join(", ")}` : undefined;
}

interface ApiRequestErrorDetails {
  description: string;
  action?: string;
  resource?: ErrorResource;
}

function describeApiRequestError(err: ApiRequestError): ApiRequestErrorDetails {
  const body = isRecord(err.body) ? err.body : undefined;

  // No parsed response body at all — a client-side network/timeout failure
  // (apiFetch's timeout branch) or a non-JSON error response. Either way,
  // `err.message` was already set to the best available text (a direct
  // message, or the HTTP status text) — there's no `.error`/`.message` split
  // to reconcile because there's no body to read it from.
  if (body === undefined) {
    return { description: err.message };
  }

  const action = typeof body.action === "string" ? body.action : undefined;
  const resource = asResource(body.resource);
  const bodyMessage =
    typeof body.message === "string" && body.message.length > 0 ? body.message : undefined;

  // The server's generic "Validation failed" message isn't actionable on
  // its own — prefer the per-field Zod details when present.
  if (err.code === ErrorCode.VALIDATION_FAILED) {
    const fromDetails = formatValidationDetails(body.details);
    return {
      description: fromDetails ?? bodyMessage ?? statusClassFallback(err.status),
      action,
      resource,
    };
  }

  if (bodyMessage) {
    return { description: bodyMessage, action, resource };
  }

  // Legacy shape: no `message` at all, so the human text (if any) lives in
  // `.code` (== `body.error`). Only trust it as a description when it's
  // non-empty and doesn't look like a machine code — otherwise we'd surface
  // something like "NOT_FOUND" (or an empty string) verbatim to the user.
  if (err.code.length > 0 && !isMachineCode(err.code)) {
    return { description: err.code, action, resource };
  }

  return { description: statusClassFallback(err.status), action, resource };
}

/**
 * Maps any caught error into a `{ title, description, action? }` triple.
 * Handles `ApiRequestError` (the common case), plain `Error`s, and
 * completely unknown thrown values gracefully.
 */
export function getUserFacingError(err: unknown): UserFacingError {
  if (err instanceof ApiRequestError) {
    const { description, action, resource } = describeApiRequestError(err);
    const title =
      CODE_TITLES[err.code] ?? resourceTitle(resource, err.status) ?? statusClassFallback(err.status);
    return action ? { title, description, action } : { title, description };
  }

  if (err instanceof Error && err.message.length > 0) {
    return { title: "Something went wrong", description: err.message };
  }

  return { title: "Something went wrong", description: "An unexpected error occurred." };
}

/**
 * Shows a sonner error toast for any caught error, via `getUserFacingError`.
 * This is the default error presentation for mutations (see the
 * `MutationCache.onError` wiring in `client/src/lib/query-client.ts`) — most
 * call sites never need to call this directly.
 */
export function toastApiError(err: unknown, opts?: { title?: string }): void {
  const { title, description, action } = getUserFacingError(err);

  // The server doesn't yet expose a structured navigation target for
  // `action` (e.g. a route or id to jump to) — until a later domain phase
  // adds one, we fold it into the toast description as informational text
  // rather than rendering a clickable sonner `action` button that would
  // have nowhere real to send the user.
  const fullDescription = action ? `${description} ${action}` : description;

  toast.error(opts?.title ?? title, { description: fullDescription });
}
