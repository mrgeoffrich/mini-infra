/**
 * Phase 2 — Identity seed backup & durability.
 *
 * The NATS *identity* is the operator NKey seed (Vault KV `shared/nats-operator`)
 * plus each account's NKey seed (its `seedKvPath`). These seeds are the crown
 * jewels: lose them and Phase 1's re-key guard trips forever (it refuses to
 * regenerate a recorded-but-missing identity), leaving every egress agent's
 * baked-in `NATS_CREDS` orphaned with no recovery path. This module is that
 * recovery path — it exports the seeds to durable off-Vault storage and
 * restores them back into Vault KV *without minting a new identity*.
 *
 * DRY note: the seeds ride along inside the existing self-backup artifact
 * (`SelfBackupExecutor`), reusing its storage backend + scheduler + manual
 * trigger rather than standing up a parallel backup subsystem. This file owns
 * only the NATS-identity-specific concerns: which seeds to capture, how they're
 * encrypted, and how a restore is applied safely. The zip/storage wiring lives
 * in the backup layer.
 *
 * Encryption: the seeds are secrets and are NEVER written to a blob in
 * plaintext. They are AES-256-GCM encrypted (via `lib/crypto`) under a key
 * derived from the server's internal auth secret — the same
 * `getAuthSecret()`-derived-HMAC pattern `stack-vault-snapshot.ts` uses. This
 * lets the server decrypt at restore time on its own, which matters precisely
 * in the DR case where Vault (and any operator passphrase held there) is gone.
 */

import crypto from "crypto";
import { encryptString, decryptString, CryptoError, zeroise } from "../../lib/crypto";
import { getAuthSecret } from "../../lib/security-config";
import { getLogger } from "../../lib/logger-factory";
import prismaDefault, { PrismaClient } from "../../lib/prisma";
import { getVaultKVService } from "../vault/vault-kv-service";
import { VaultKVError } from "../vault/vault-kv-paths";
import { loadKeyPair } from "./nats-key-manager";
import {
  NATS_OPERATOR_KV_PATH,
  FIELD_OPERATOR_SEED,
  FIELD_ACCOUNT_SEED,
} from "./nats-control-plane-service";
import { UserEventService } from "../user-events/user-event-service";
import type {
  NatsIdentitySeedRestoreEntry,
  NatsIdentitySeedRestoreResult,
} from "@mini-infra/types";

const log = getLogger("backup", "nats-identity-seed-backup");

/** Entry name of the encrypted seed manifest inside the self-backup zip. */
export const NATS_SEED_BACKUP_ZIP_ENTRY = "nats-identity-seeds.enc";

/**
 * SystemSettings coordinates for the last-seed-backup marker. Recording the
 * timestamp in the existing settings store avoids a schema change (Phase 2
 * declares none) and lets the NATS status surface read it cheaply.
 */
export const NATS_SEED_BACKUP_SETTINGS_CATEGORY = "nats-seed-backup";
export const NATS_SEED_BACKUP_LAST_AT_KEY = "last_backup_at";
export const NATS_SEED_BACKUP_LAST_COUNT_KEY = "last_backup_count";

/** One captured identity seed (operator or account), pre-encryption. */
interface SeedManifestEntryV1 {
  /** Canonical Vault KV path the seed lives at — the restore target. */
  kvPath: string;
  /** Vault KV field name holding the seed value. */
  field: string;
  /** The NKey seed string (SECRET — only ever present inside the encrypted blob). */
  seed: string;
  /** Public key derived from the seed. Lets restore verify identity + report. */
  publicKey: string;
  /** Human label, e.g. `operator mini-infra-operator` / `account foo`. */
  label: string;
}

interface SeedManifestV1 {
  version: 1;
  createdAt: string;
  entries: SeedManifestEntryV1[];
}

/** Metadata about a produced backup (never carries the seeds themselves). */
export interface IdentitySeedBackupMeta {
  createdAt: string;
  count: number;
  labels: string[];
}

/**
 * Derive the AES key that wraps the seed manifest. Mirrors
 * `stack-vault-snapshot.ts`: HMAC-SHA256 of a fixed domain-separation label
 * under the server's internal auth secret, yielding a stable 32-byte key.
 * Because it's derived from the app secret (not from Vault), the server can
 * decrypt a backup even when Vault has been wiped — the whole point of DR.
 */
function deriveSeedBackupKey(): Buffer {
  const secret = getAuthSecret();
  return Buffer.from(
    crypto.createHmac("sha256", secret).update("nats-identity-seed-backup-v1").digest(),
  );
}

/** Read a KV field, mapping only genuine not-found to null; rethrow the rest. */
async function tryReadSeedField(path: string, field: string): Promise<string | null> {
  try {
    return await getVaultKVService().readField(path, field);
  } catch (err) {
    if (
      err instanceof VaultKVError &&
      (err.code === "path_not_found" || err.code === "field_not_found")
    ) {
      return null;
    }
    throw err;
  }
}

/** Derive the public key for a seed, returning null if the seed is unparseable. */
function derivePublicKeySafe(seed: string): string | null {
  try {
    return loadKeyPair(seed).getPublicKey();
  } catch {
    return null;
  }
}

/**
 * Collect the operator seed plus every account seed currently in Vault KV.
 * A missing individual seed is skipped (nothing to protect for it); an
 * unparseable seed is skipped with a warning. Throws only on a genuine Vault
 * failure (sealed / unavailable), which the caller treats as "skip seed
 * capture this run" so a DB backup still proceeds.
 */
export async function collectIdentitySeeds(
  db: PrismaClient = prismaDefault,
): Promise<SeedManifestEntryV1[]> {
  const entries: SeedManifestEntryV1[] = [];

  const operatorSeed = await tryReadSeedField(NATS_OPERATOR_KV_PATH, FIELD_OPERATOR_SEED);
  if (operatorSeed) {
    const publicKey = derivePublicKeySafe(operatorSeed);
    if (publicKey) {
      entries.push({
        kvPath: NATS_OPERATOR_KV_PATH,
        field: FIELD_OPERATOR_SEED,
        seed: operatorSeed,
        publicKey,
        label: "operator",
      });
    }
  }

  const accounts = await db.natsAccount.findMany({ orderBy: { name: "asc" } });
  for (const account of accounts) {
    const seed = await tryReadSeedField(account.seedKvPath, FIELD_ACCOUNT_SEED);
    if (!seed) continue;
    const publicKey = derivePublicKeySafe(seed);
    if (!publicKey) {
      log.warn({ account: account.name }, "account seed in Vault is unparseable; skipping from backup");
      continue;
    }
    entries.push({
      kvPath: account.seedKvPath,
      field: FIELD_ACCOUNT_SEED,
      seed,
      publicKey,
      label: `account ${account.name}`,
    });
  }

  return entries;
}

/**
 * Export the identity seeds as an AES-256-GCM encrypted blob suitable for
 * storing inside the self-backup artifact. Returns `null` (best-effort) when
 * there is nothing to protect yet (pre-bootstrap) or Vault is unavailable —
 * callers must let the surrounding DB backup proceed regardless.
 */
export async function exportEncryptedIdentitySeeds(
  db: PrismaClient = prismaDefault,
): Promise<{ blob: Buffer; meta: IdentitySeedBackupMeta } | null> {
  let entries: SeedManifestEntryV1[];
  try {
    entries = await collectIdentitySeeds(db);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "identity-seed export skipped: Vault unavailable (DB backup will still proceed)",
    );
    return null;
  }

  if (entries.length === 0) {
    log.info("identity-seed export skipped: no seeds present in Vault yet (pre-bootstrap)");
    return null;
  }

  const manifest: SeedManifestV1 = {
    version: 1,
    createdAt: new Date().toISOString(),
    entries,
  };

  const key = deriveSeedBackupKey();
  try {
    const blob = encryptString(key, JSON.stringify(manifest));
    return {
      blob,
      meta: {
        createdAt: manifest.createdAt,
        count: entries.length,
        labels: entries.map((e) => e.label),
      },
    };
  } finally {
    zeroise(key);
  }
}

/** Error thrown when a seed backup blob can't be decrypted or is malformed. */
export class IdentitySeedBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentitySeedBackupError";
  }
}

/**
 * Decrypt + validate an encrypted seed blob produced by
 * `exportEncryptedIdentitySeeds`. Throws {@link IdentitySeedBackupError} on a
 * wrong key, corruption, or an unrecognised manifest shape.
 */
function decryptSeedManifest(blob: Buffer): SeedManifestV1 {
  const key = deriveSeedBackupKey();
  try {
    const json = decryptString(key, blob);
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      throw new IdentitySeedBackupError("Unrecognised NATS identity seed manifest");
    }
    return parsed as SeedManifestV1;
  } catch (err) {
    if (err instanceof IdentitySeedBackupError) throw err;
    if (err instanceof CryptoError) {
      throw new IdentitySeedBackupError(
        "Failed to decrypt NATS identity seed backup (wrong key or corrupt artifact)",
      );
    }
    if (err instanceof SyntaxError) {
      throw new IdentitySeedBackupError("NATS identity seed backup is not valid JSON after decryption");
    }
    throw err;
  } finally {
    zeroise(key);
  }
}

/**
 * Restore identity seeds from an encrypted blob back into Vault KV at their
 * canonical paths.
 *
 * Safety contract (Phase 2):
 *   - The normal restore target is a missing/empty seed path (the DR case Phase
 *     1 detects). Those are written.
 *   - A path that already holds the *same* seed is left untouched (idempotent).
 *   - A path that holds a *different* seed is a conflict. Without `force`, the
 *     restore is refused **entirely** — nothing is written (all-or-nothing), so
 *     a restore can never silently swap a live identity under running agents.
 *     With `force`, conflicts are overwritten too.
 *
 * Requires an unsealed Vault (writes to KV). Records a UserEvent for audit.
 */
export async function restoreEncryptedIdentitySeeds(
  blob: Buffer,
  opts: { force?: boolean; userId?: string; db?: PrismaClient },
): Promise<NatsIdentitySeedRestoreResult> {
  const db = opts.db ?? prismaDefault;
  const force = opts.force ?? false;
  const manifest = decryptSeedManifest(blob);
  const kv = getVaultKVService();

  // First pass: classify every entry against the *current* Vault state without
  // writing anything, so a conflict can abort before any mutation.
  type Classified = { entry: SeedManifestEntryV1; action: "restore" | "unchanged" | "conflict"; currentPublicKey: string | null };
  const classified: Classified[] = [];
  for (const entry of manifest.entries) {
    const current = await tryReadSeedField(entry.kvPath, entry.field);
    if (!current) {
      classified.push({ entry, action: "restore", currentPublicKey: null });
      continue;
    }
    const currentPublicKey = derivePublicKeySafe(current);
    if (currentPublicKey === entry.publicKey) {
      classified.push({ entry, action: "unchanged", currentPublicKey });
    } else {
      classified.push({ entry, action: "conflict", currentPublicKey });
    }
  }

  const conflicts = classified.filter((c) => c.action === "conflict");
  const buildEntries = (): NatsIdentitySeedRestoreEntry[] =>
    classified.map((c) => ({
      label: c.entry.label,
      kvPath: c.entry.kvPath,
      // Internal action "restore" maps to the public outcome "restored".
      outcome: c.action === "restore" ? "restored" : c.action,
      backupPublicKey: c.entry.publicKey,
      currentPublicKey: c.currentPublicKey,
    }));

  if (conflicts.length > 0 && !force) {
    log.warn(
      { conflicts: conflicts.map((c) => c.entry.label) },
      "identity-seed restore refused: present-but-different seed(s) would be clobbered; pass force to override",
    );
    await recordRestoreEvent(db, {
      applied: false,
      restored: 0,
      unchanged: classified.filter((c) => c.action === "unchanged").length,
      conflicts: conflicts.length,
      force,
      userId: opts.userId,
      labels: conflicts.map((c) => c.entry.label),
    });
    return {
      applied: false,
      restored: 0,
      unchanged: classified.filter((c) => c.action === "unchanged").length,
      conflicts: conflicts.length,
      entries: buildEntries(),
    };
  }

  // Second pass: apply. Writes are idempotent; unchanged entries are skipped.
  let restored = 0;
  for (const c of classified) {
    if (c.action === "restore" || (c.action === "conflict" && force)) {
      await kv.write(c.entry.kvPath, { [c.entry.field]: c.entry.seed });
      restored += 1;
    }
  }

  const result: NatsIdentitySeedRestoreResult = {
    applied: true,
    restored,
    unchanged: classified.filter((c) => c.action === "unchanged").length,
    conflicts: force ? conflicts.length : 0,
    entries: buildEntries(),
  };

  log.info(
    { restored: result.restored, unchanged: result.unchanged, conflicts: result.conflicts, force },
    "NATS identity seeds restored into Vault KV",
  );
  await recordRestoreEvent(db, {
    applied: true,
    restored: result.restored,
    unchanged: result.unchanged,
    conflicts: result.conflicts,
    force,
    userId: opts.userId,
    labels: classified.filter((c) => c.action === "restore" || (c.action === "conflict" && force)).map((c) => c.entry.label),
  });
  return result;
}

/**
 * Record the last-seed-backup marker in SystemSettings (no schema change). Both
 * scheduled and manual self-backups call this after a successful seed capture;
 * the NATS status surface reads it back for the "last identity-seed backup"
 * timestamp.
 */
export async function recordSeedBackupMarker(
  meta: IdentitySeedBackupMeta,
  userId?: string,
  db: PrismaClient = prismaDefault,
): Promise<void> {
  const writer = userId ?? "system";
  await upsertSetting(db, NATS_SEED_BACKUP_LAST_AT_KEY, meta.createdAt, writer);
  await upsertSetting(db, NATS_SEED_BACKUP_LAST_COUNT_KEY, String(meta.count), writer);
}

async function upsertSetting(
  db: PrismaClient,
  key: string,
  value: string,
  writer: string,
): Promise<void> {
  await db.systemSettings.upsert({
    where: {
      category_key: { category: NATS_SEED_BACKUP_SETTINGS_CATEGORY, key },
    },
    create: {
      category: NATS_SEED_BACKUP_SETTINGS_CATEGORY,
      key,
      value,
      isEncrypted: false,
      isActive: true,
      createdBy: writer,
      updatedBy: writer,
    },
    update: {
      value,
      updatedBy: writer,
      updatedAt: new Date(),
    },
  });
}

/**
 * Read the last-seed-backup marker for the NATS status surface. Returns nulls
 * when no seed backup has been recorded yet.
 */
export async function getIdentitySeedBackupStatus(
  db: PrismaClient = prismaDefault,
): Promise<{ lastIdentitySeedBackupAt: string | null; lastIdentitySeedBackupCount: number | null }> {
  const rows = await db.systemSettings.findMany({
    where: { category: NATS_SEED_BACKUP_SETTINGS_CATEGORY },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const at = map.get(NATS_SEED_BACKUP_LAST_AT_KEY) ?? null;
  const countRaw = map.get(NATS_SEED_BACKUP_LAST_COUNT_KEY);
  const count = countRaw !== undefined ? Number.parseInt(countRaw, 10) : null;
  return {
    lastIdentitySeedBackupAt: at,
    lastIdentitySeedBackupCount: Number.isNaN(count as number) ? null : count,
  };
}

async function recordRestoreEvent(
  db: PrismaClient,
  info: {
    applied: boolean;
    restored: number;
    unchanged: number;
    conflicts: number;
    force: boolean;
    userId?: string;
    labels: string[];
  },
): Promise<void> {
  try {
    await new UserEventService(db).createEvent({
      eventType: "system_maintenance",
      eventCategory: "infrastructure",
      eventName: info.applied
        ? "NATS identity seeds restored from backup"
        : "NATS identity seed restore refused (conflict)",
      triggeredBy: info.userId ? "user" : "system",
      status: info.applied ? "completed" : "failed",
      progress: info.applied ? 100 : 0,
      resourceType: "system",
      resourceName: "nats-identity",
      userId: info.userId,
      description: info.applied
        ? `Restored ${info.restored} NATS identity seed(s) into Vault KV (${info.unchanged} unchanged, ${info.conflicts} force-overwritten)`
        : `Refused to restore ${info.conflicts} NATS identity seed(s): a present-but-different seed would be clobbered without force`,
      metadata: {
        applied: info.applied,
        restored: info.restored,
        unchanged: info.unchanged,
        conflicts: info.conflicts,
        force: info.force,
        identities: info.labels,
      },
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to record identity-seed restore UserEvent (non-fatal)",
    );
  }
}
