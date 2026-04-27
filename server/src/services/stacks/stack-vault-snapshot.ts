/**
 * Snapshot v2 types, encryption helpers, and restore-walker for the Vault
 * reconciliation phase.
 *
 * Schema version history:
 *   v1 (PR2/PR3) — hashes-only. No rollback target. Stored as raw JSON in the
 *                  Json? column. When read back the `version` field is absent.
 *   v2 (PR4)     — concrete bodies + hashes, AES-256-GCM encrypted. Stored as
 *                  base64 ciphertext in the String? column.
 *
 * The column changed from Json? to String? in PR4. Existing rows that stored
 * raw JSON (v1) will no longer deserialise — the column is now opaque text. Any
 * row that was written with v1 data has a JSON string in the column; attempting
 * to decrypt it will throw a CryptoError. `decryptSnapshot` catches that and
 * returns null, which callers treat as "no rollback target available."
 */

import crypto from "crypto";
import { encryptString, decryptString, CryptoError, zeroise } from "../../lib/crypto";
import { getAuthSecret } from "../../lib/security-config";

// =====================
// Key derivation
// =====================

function deriveSnapshotKey(): Buffer {
  const secret = getAuthSecret();
  return Buffer.from(
    crypto.createHmac("sha256", secret).update("stack-vault-snapshot-v2").digest(),
  );
}

// =====================
// SnapshotV2 shape
// =====================

export interface SnapshotV2PolicyEntry {
  body: string;
  scope: string;
  hash: string;
}

export interface SnapshotV2AppRoleEntry {
  policy: string;
  tokenPeriod?: string | null;
  tokenTtl?: string | null;
  tokenMaxTtl?: string | null;
  secretIdNumUses?: number | null;
  secretIdTtl?: string | null;
  scope: string;
  hash: string;
}

export interface SnapshotV2KvEntry {
  /** Plaintext field values — encrypted at rest inside the snapshot blob. */
  fields: Record<string, string>;
  hash: string;
}

export interface SnapshotV2 {
  version: 2;
  policies: Record<string, SnapshotV2PolicyEntry>;
  appRoles: Record<string, SnapshotV2AppRoleEntry>;
  kv: Record<string, SnapshotV2KvEntry>;
}

export function emptySnapshotV2(): SnapshotV2 {
  return { version: 2, policies: {}, appRoles: {}, kv: {} };
}

// =====================
// Encryption round-trip
// =====================

/**
 * Encrypt a SnapshotV2 object to a base64 ciphertext suitable for storing in
 * Stack.lastAppliedVaultSnapshot (String? column).
 */
export function encryptSnapshot(snapshot: SnapshotV2): string {
  const key = deriveSnapshotKey();
  const plaintext = JSON.stringify(snapshot);
  const cipherBuf = encryptString(key, plaintext);
  zeroise(key);
  return cipherBuf.toString("base64");
}

/**
 * Decrypt a base64 blob produced by encryptSnapshot() back to a SnapshotV2.
 *
 * Returns null on any decryption or parse failure (covers v1 JSON rows, corrupt
 * data, wrong key). Callers should treat null as "no rollback target available."
 */
export function decryptSnapshot(encrypted: string): SnapshotV2 | null {
  let key: Buffer | null = null;
  try {
    key = deriveSnapshotKey();
    const cipherBuf = Buffer.from(encrypted, "base64");
    const plaintext = decryptString(key, cipherBuf);
    const parsed: unknown = JSON.parse(plaintext);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>)["version"] !== 2
    ) {
      return null;
    }
    return parsed as SnapshotV2;
  } catch (err) {
    if (err instanceof CryptoError) return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  } finally {
    if (key) zeroise(key);
  }
}

// =====================
// Restore-walker types
// =====================

/**
 * What the reconciler tracked as "applied this run" so the rollback knows
 * which resources to restore.
 */
export interface AppliedThisRun {
  policies: string[];   // concrete names written this apply (in order)
  appRoles: string[];   // concrete names written this apply (in order)
  kv: string[];         // concrete paths written this apply (in order)
}

export interface RollbackTarget {
  priorSnapshot: SnapshotV2;
  appliedThisRun: AppliedThisRun;
}

/**
 * Compute the list of concrete names/paths that need restoring for each phase,
 * given the resources written in this apply and the prior snapshot state.
 *
 * Restore order: KV → AppRoles → Policies (reverse apply order, safest for
 * dependency chain: by the time we rebind an AppRole, the policy is back to
 * its prior body).
 */
export function computeRestoreItems(target: RollbackTarget): {
  kvToRestore: Array<{ path: string; entry: SnapshotV2KvEntry }>;
  appRolesToRestore: Array<{ name: string; entry: SnapshotV2AppRoleEntry }>;
  policiesToRestore: Array<{ name: string; entry: SnapshotV2PolicyEntry }>;
} {
  const { priorSnapshot, appliedThisRun } = target;

  const kvToRestore = appliedThisRun.kv
    .filter((path) => path in priorSnapshot.kv)
    .map((path) => ({ path, entry: priorSnapshot.kv[path] }));

  const appRolesToRestore = appliedThisRun.appRoles
    .filter((name) => name in priorSnapshot.appRoles)
    .map((name) => ({ name, entry: priorSnapshot.appRoles[name] }));

  const policiesToRestore = appliedThisRun.policies
    .filter((name) => name in priorSnapshot.policies)
    .map((name) => ({ name, entry: priorSnapshot.policies[name] }));

  return { kvToRestore, appRolesToRestore, policiesToRestore };
}
