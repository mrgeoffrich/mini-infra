/**
 * Pure path/field validators for Vault KV v2. Kept in their own module
 * (no logger, no prisma, no Vault client imports) so they can be exercised
 * by unit tests without dragging the full Vault wiring in.
 */

const MAX_KV_PATH_LEN = 256;
const KV_PATH_PATTERN = /^[a-zA-Z0-9_/-]+$/;
const KV_FIELD_PATTERN = /^[a-zA-Z0-9_-]+$/;

export class VaultKVError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = "VaultKVError";
  }
}

export function validateKvPath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new VaultKVError("KV path must be a non-empty string", "invalid_path");
  }
  if (path.length > MAX_KV_PATH_LEN) {
    throw new VaultKVError(`KV path exceeds ${MAX_KV_PATH_LEN} characters`, "invalid_path");
  }
  if (path.startsWith("/")) {
    throw new VaultKVError("KV path must not start with '/'", "invalid_path");
  }
  if (path.endsWith("/")) {
    throw new VaultKVError("KV path must not end with '/'", "invalid_path");
  }
  if (path.includes("..")) {
    throw new VaultKVError("KV path must not contain '..'", "invalid_path");
  }
  if (path.includes("//")) {
    throw new VaultKVError("KV path must not contain '//'", "invalid_path");
  }
  if (!KV_PATH_PATTERN.test(path)) {
    throw new VaultKVError(
      "KV path may only contain letters, numbers, '_', '-', '/'",
      "invalid_path",
    );
  }
  return path;
}

export function validateKvFieldName(field: string): string {
  if (typeof field !== "string" || field.length === 0) {
    throw new VaultKVError("KV field name must be a non-empty string", "invalid_field");
  }
  if (!KV_FIELD_PATTERN.test(field)) {
    throw new VaultKVError(
      "KV field name may only contain letters, numbers, '_', '-'",
      "invalid_field",
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
