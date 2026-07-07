/**
 * Pure path/field validators for Vault KV v2. Kept in their own module
 * (no logger, no prisma, no Vault client imports) so they can be exercised
 * by unit tests without dragging the full Vault wiring in.
 */

import { ErrorCode } from "@mini-infra/types";
import { CustomError } from "../../lib/error-handler";

const MAX_KV_PATH_LEN = 256;
const KV_PATH_PATTERN = /^[a-zA-Z0-9_/-]+$/;
const KV_FIELD_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * The default HTTP status for each `VaultKVError` code, used when the
 * constructor isn't given an explicit `status` (e.g. one carried over from
 * the upstream Vault HTTP response — see `classifyVaultHttpError` in
 * `vault-kv-service.ts`).
 */
const KV_ERROR_DEFAULT_STATUS: Partial<Record<ErrorCode, number>> = {
  [ErrorCode.VAULT_KV_INVALID_PATH]: 400,
  [ErrorCode.VAULT_KV_INVALID_FIELD]: 400,
  [ErrorCode.VAULT_KV_INVALID_DATA]: 400,
  [ErrorCode.VAULT_KV_PATH_NOT_FOUND]: 404,
  [ErrorCode.VAULT_KV_FIELD_NOT_FOUND]: 404,
  [ErrorCode.VAULT_KV_PERMISSION_DENIED]: 403,
  [ErrorCode.VAULT_KV_RATE_LIMITED]: 429,
  [ErrorCode.VAULT_KV_SEALED]: 503,
  [ErrorCode.VAULT_KV_STANDBY]: 503,
  [ErrorCode.VAULT_KV_UNAVAILABLE]: 503,
  [ErrorCode.VAULT_KV_ERROR]: 500,
  [ErrorCode.VAULT_KV_DESTROY_FORBIDDEN]: 403,
};

const KV_ERROR_ACTION: Partial<Record<ErrorCode, string>> = {
  [ErrorCode.VAULT_KV_SEALED]: "Unseal Vault, then retry.",
  [ErrorCode.VAULT_KV_STANDBY]: "Retry once Mini Infra reconnects to the active Vault node.",
  [ErrorCode.VAULT_KV_UNAVAILABLE]: "Check Vault connectivity, then retry.",
  [ErrorCode.VAULT_KV_RATE_LIMITED]: "Wait a moment, then retry.",
  [ErrorCode.VAULT_KV_PERMISSION_DENIED]: "Grant the broker's Vault policy access to this path.",
};

/**
 * Thrown by the brokered Vault KV API (`services/vault/vault-kv-service.ts`,
 * `routes/vault/kv.ts`). Folded into the server error taxonomy (§4.2) — always
 * operational, with a stable `ErrorCode` and a status derived from that code
 * (or an explicit override, e.g. an upstream Vault HTTP status).
 */
export class VaultKVError extends CustomError {
  constructor(message: string, code: ErrorCode, status?: number) {
    super(message, status ?? KV_ERROR_DEFAULT_STATUS[code] ?? 500, true, code, {
      resource: { type: "vaultKv" },
      action: KV_ERROR_ACTION[code],
    });
    this.name = "VaultKVError";
  }
}

export function validateKvPath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new VaultKVError("KV path must be a non-empty string", ErrorCode.VAULT_KV_INVALID_PATH);
  }
  if (path.length > MAX_KV_PATH_LEN) {
    throw new VaultKVError(
      `KV path exceeds ${MAX_KV_PATH_LEN} characters`,
      ErrorCode.VAULT_KV_INVALID_PATH,
    );
  }
  if (path.startsWith("/")) {
    throw new VaultKVError("KV path must not start with '/'", ErrorCode.VAULT_KV_INVALID_PATH);
  }
  if (path.endsWith("/")) {
    throw new VaultKVError("KV path must not end with '/'", ErrorCode.VAULT_KV_INVALID_PATH);
  }
  if (path.includes("..")) {
    throw new VaultKVError("KV path must not contain '..'", ErrorCode.VAULT_KV_INVALID_PATH);
  }
  if (path.includes("//")) {
    throw new VaultKVError("KV path must not contain '//'", ErrorCode.VAULT_KV_INVALID_PATH);
  }
  if (!KV_PATH_PATTERN.test(path)) {
    throw new VaultKVError(
      "KV path may only contain letters, numbers, '_', '-', '/'",
      ErrorCode.VAULT_KV_INVALID_PATH,
    );
  }
  return path;
}

export function validateKvFieldName(field: string): string {
  if (typeof field !== "string" || field.length === 0) {
    throw new VaultKVError(
      "KV field name must be a non-empty string",
      ErrorCode.VAULT_KV_INVALID_FIELD,
    );
  }
  if (!KV_FIELD_PATTERN.test(field)) {
    throw new VaultKVError(
      "KV field name may only contain letters, numbers, '_', '-'",
      ErrorCode.VAULT_KV_INVALID_FIELD,
    );
  }
  return field;
}

/**
 * The default KV v2 mount Mini Infra writes against. Bootstrap mounts KV v2
 * at this path; the operator policy, route handlers, and dynamicEnv resolver
 * all refer to the same mount via this constant.
 */
export const KV_MOUNT = "secret";

/**
 * Replace `{{...}}` substitution tokens in a template KV path with a
 * placeholder segment so the structural portion can be validated by
 * validateKvPath. Tokens like `{{stack.id}}` are only resolved at apply time;
 * the characters `{` and `}` are not valid in real Vault paths.
 */
export function stripTemplateTokens(path: string): string {
  return path.replace(/\{\{[^}]+\}\}/g, "_token_");
}
