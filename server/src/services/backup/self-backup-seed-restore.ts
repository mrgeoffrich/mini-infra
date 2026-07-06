/**
 * Backup-layer glue for the Phase 2 identity-seed restore: given a stored
 * self-backup id, download the artifact from whichever storage backend wrote
 * it and pull the encrypted NATS identity-seed blob back out of the zip.
 *
 * This is the artifact-I/O half of the restore; the seed *semantics* (decrypt,
 * classify, write to Vault KV with the present-but-different guard) live in
 * `services/nats/nats-identity-seed-backup.ts`. Keeping them apart means the
 * NATS module never has to know about zips or storage providers.
 */

import AdmZip from "adm-zip";
import prismaDefault, { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";
import { StorageService } from "../storage/storage-service";
import type { StorageProviderId } from "@mini-infra/types";
import { NATS_SEED_BACKUP_ZIP_ENTRY } from "../nats/nats-identity-seed-backup";

const log = getLogger("backup", "self-backup-seed-restore");

/** The referenced self-backup id does not exist. */
export class SelfBackupNotFoundError extends Error {
  readonly code = "SELF_BACKUP_NOT_FOUND";
  constructor(backupId: string) {
    super(`Self-backup '${backupId}' not found`);
    this.name = "SelfBackupNotFoundError";
  }
}

/** The referenced self-backup exists but carries no identity-seed blob. */
export class SelfBackupNoSeedEntryError extends Error {
  readonly code = "SELF_BACKUP_NO_SEED_ENTRY";
  constructor(backupId: string) {
    super(
      `Self-backup '${backupId}' does not contain a NATS identity-seed blob ` +
        `(it predates identity-seed backup, or was taken while Vault was unavailable)`,
    );
    this.name = "SelfBackupNoSeedEntryError";
  }
}

/**
 * Resolve the storage object name for a self-backup row. Azure stamps the full
 * blob URL in `storageObjectUrl`; other providers use the bare file name. This
 * mirrors the logic in the `/api/self-backups/:id/download` route so both the
 * download and the seed-restore paths agree on the object name.
 */
export function resolveSelfBackupObjectName(backup: {
  storageProviderAtCreation: string | null;
  storageObjectUrl: string | null;
  fileName: string;
}): string {
  if (backup.storageProviderAtCreation === "azure" && backup.storageObjectUrl) {
    const urlParts = backup.storageObjectUrl.split("/");
    return urlParts.length >= 5 ? urlParts.slice(4).join("/") : backup.fileName;
  }
  return backup.fileName;
}

async function bufferStream(stream: unknown): Promise<Buffer> {
  const readable = stream as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    readable.on("data", (chunk: Buffer | string) =>
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}

/**
 * Download a stored self-backup and extract the encrypted identity-seed blob.
 *
 * Throws {@link SelfBackupNotFoundError} if the id is unknown, or
 * {@link SelfBackupNoSeedEntryError} if the artifact carries no seed blob.
 * Storage/provider errors (e.g. `ProviderNoLongerConfiguredError`) propagate
 * unchanged for the route handler to map.
 */
export async function loadIdentitySeedBlobFromSelfBackup(
  backupId: string,
  db: PrismaClient = prismaDefault,
): Promise<Buffer> {
  const backup = await db.selfBackup.findUnique({ where: { id: backupId } });
  if (!backup) throw new SelfBackupNotFoundError(backupId);
  if (!backup.storageLocationId || !backup.storageProviderAtCreation) {
    throw new SelfBackupNoSeedEntryError(backupId);
  }

  const provider = backup.storageProviderAtCreation as StorageProviderId;
  const objectName = resolveSelfBackupObjectName(backup);

  const backend = await StorageService.getInstance(db).getBackendByProviderIdOrThrow(provider);
  const download = await backend.getDownloadStream({ id: backup.storageLocationId }, objectName);
  const zipBuffer = await bufferStream(download.stream);

  const zip = new AdmZip(zipBuffer);
  const entry = zip.getEntry(NATS_SEED_BACKUP_ZIP_ENTRY);
  if (!entry) throw new SelfBackupNoSeedEntryError(backupId);

  log.info(
    { backupId, providerId: backend.providerId, objectName },
    "extracted encrypted NATS identity-seed blob from self-backup artifact",
  );
  return entry.getData();
}
