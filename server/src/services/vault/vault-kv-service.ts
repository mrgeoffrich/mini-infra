import { getLogger } from "../../lib/logger-factory";
import { getVaultServices, vaultServicesReady } from "./vault-services";
import { VaultHttpError } from "./vault-http-client";
import {
  KV_MOUNT,
  VaultKVError,
  validateKvPath,
  validateKvFieldName,
} from "./vault-kv-paths";

const log = getLogger("platform", "vault-kv-service");

// Re-export so consumers can keep importing from this module without
// chasing the validators down a side path.
export { KV_MOUNT, VaultKVError, validateKvPath, validateKvFieldName };

/**
 * Brokered access to Vault KV v2. Holds the admin client (so callers don't
 * need their own Vault token) and is the single source of truth shared by
 * the `/api/vault/kv` routes and the `vault-kv` dynamicEnv resolver branch.
 *
 * Uses `getAuthenticatedClient()` (not the cached `getClient()`) so a dropped
 * admin token after a renewal failure triggers a fresh AppRole login on the
 * next request, instead of firing an unauthenticated request that Vault
 * rejects with 403.
 */
export class VaultKVService {
  private async client() {
    if (!vaultServicesReady()) {
      throw new VaultKVError("Vault services not initialised", "vault_not_ready");
    }
    try {
      return await getVaultServices().admin.getAuthenticatedClient();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new VaultKVError(
        `Vault admin client unavailable: ${msg}`,
        "vault_unavailable",
      );
    }
  }

  async read(path: string): Promise<Record<string, unknown> | null> {
    validateKvPath(path);
    try {
      const c = await this.client();
      return await c.kvRead(KV_MOUNT, path);
    } catch (err) {
      throw wrapVaultError(err, "read", path);
    }
  }

  /**
   * Read a single field from a KV path. Returns the value as a string
   * (booleans/numbers are JSON-stringified per dynamicEnv expectations).
   * Throws `VaultKVError(field_not_found)` if the field is missing.
   */
  async readField(path: string, field: string): Promise<string> {
    validateKvPath(path);
    validateKvFieldName(field);
    let data: Record<string, unknown> | null;
    try {
      const c = await this.client();
      data = await c.kvRead(KV_MOUNT, path);
    } catch (err) {
      throw wrapVaultError(err, "read", path);
    }
    if (data == null) {
      throw new VaultKVError(`KV path '${path}' not found`, "path_not_found", 404);
    }
    if (!(field in data)) {
      throw new VaultKVError(
        `KV path '${path}' has no field '${field}'`,
        "field_not_found",
        404,
      );
    }
    const value = data[field];
    if (value === null || value === undefined) {
      throw new VaultKVError(
        `KV path '${path}' field '${field}' is null/undefined`,
        "field_not_found",
        404,
      );
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  async write(path: string, data: Record<string, unknown>): Promise<void> {
    validateKvPath(path);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new VaultKVError("KV data must be an object", "invalid_data");
    }
    try {
      const c = await this.client();
      await c.kvWrite(KV_MOUNT, path, data);
      log.info({ path }, "KV write succeeded");
    } catch (err) {
      throw wrapVaultError(err, "write", path);
    }
  }

  /** KV v2 server-side merge against the latest version. */
  async patch(path: string, data: Record<string, unknown>): Promise<void> {
    validateKvPath(path);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new VaultKVError("KV data must be an object", "invalid_data");
    }
    try {
      const c = await this.client();
      await c.kvPatch(KV_MOUNT, path, data);
      log.info({ path }, "KV patch succeeded");
    } catch (err) {
      throw wrapVaultError(err, "patch", path);
    }
  }

  /**
   * Soft-delete the latest version (history preserved). Pass
   * `permanent: true` to wipe all versions and metadata.
   */
  async delete(path: string, opts: { permanent?: boolean } = {}): Promise<void> {
    validateKvPath(path);
    try {
      const c = await this.client();
      if (opts.permanent) {
        await c.kvDeleteMetadata(KV_MOUNT, path);
      } else {
        await c.kvDelete(KV_MOUNT, path);
      }
      log.info({ path, permanent: !!opts.permanent }, "KV delete succeeded");
    } catch (err) {
      throw wrapVaultError(err, "delete", path);
    }
  }
}

/**
 * Map a low-level Vault HTTP error into a structured KV error with a code
 * the route handler can translate to a meaningful HTTP status. Vault is
 * sometimes specific (`sealed`, `standby`, `permission denied`) and
 * sometimes generic — we lean on the response status and the well-known
 * error strings rather than fragile regex on the body.
 */
function wrapVaultError(err: unknown, op: string, path: string): VaultKVError {
  if (err instanceof VaultKVError) return err;
  if (err instanceof VaultHttpError) {
    const code = classifyVaultHttpError(err);
    return new VaultKVError(
      `Vault KV ${op} failed for '${path}': ${err.message}`,
      code,
      err.status,
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new VaultKVError(`Vault KV ${op} failed for '${path}': ${msg}`, "vault_error");
}

function classifyVaultHttpError(err: VaultHttpError): string {
  // 503 from Vault means sealed or standby — both are transient and the
  // caller should retry once Mini Infra reconnects.
  if (err.status === 503) {
    if (err.errors.some((e) => /sealed/i.test(e))) return "vault_sealed";
    if (err.errors.some((e) => /standby/i.test(e))) return "vault_standby";
    return "vault_unavailable";
  }
  if (err.status === 429) return "vault_rate_limited";
  if (err.status === 412) return "vault_standby"; // Vault sends 412 for read-after-write on a standby node
  if (err.status === 403) return "vault_permission_denied";
  if (err.status === 0) return "vault_unavailable"; // network-level failure
  return "vault_error";
}

let kvServiceSingleton: VaultKVService | null = null;
export function getVaultKVService(): VaultKVService {
  if (!kvServiceSingleton) kvServiceSingleton = new VaultKVService();
  return kvServiceSingleton;
}

/** Test-only reset for the singleton. */
export function __resetVaultKVServiceForTests(): void {
  kvServiceSingleton = null;
}
