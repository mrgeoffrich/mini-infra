/**
 * Self-restore engine — the inverse of `self-backup-executor.ts`.
 *
 * Given a stored `mini-infra-<timestamp>.db.zip` artifact, download it, pull
 * the SQLite `.db` dump out of the zip, and STAGE it on the data volume next
 * to the live DB. The actual swap happens on the next boot, in
 * `docker-entrypoint.sh`, *before* Prisma opens the DB — because the running
 * process holds `production.db` open in WAL mode and cannot safely overwrite
 * it in place.
 *
 * Flow:
 *   1. `stageRestore()` downloads + unzips + writes `<dataDir>/restore-pending.db`,
 *      runs the schema-version guard, and drops a `<dataDir>/.restore-pending`
 *      marker. It never restarts.
 *   2. The route handler responds, then calls `triggerRestoreRestart()`.
 *   3. Docker (`restart: unless-stopped`) restarts the container; the entrypoint
 *      sees the marker, atomically renames the staged DB over `production.db`,
 *      drops the stale WAL sidecars, then runs `prisma migrate deploy`.
 *
 * The schema-version guard blocks a backup taken with a NEWER Mini Infra
 * version than this image: such a DB would fail forward-only `migrate deploy`
 * on boot and crash-loop the container. We reject it up-front instead.
 */

import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import fs from "fs/promises";
import path from "path";
import prismaDefault, { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";
import { StorageService } from "../storage/storage-service";
import { bufferStream } from "../storage/stream-utils";
import { getDatabaseFilePath } from "../../lib/database-url-parser";
import type { StorageProviderId } from "@mini-infra/types";

const log = () => getLogger("backup", "self-restore-executor");

/** Filename of the staged DB written next to the live DB on the data volume. */
export const RESTORE_STAGED_DB_FILENAME = "restore-pending.db";
/** Marker filename the entrypoint checks to know a restore swap is pending. */
export const RESTORE_MARKER_FILENAME = ".restore-pending";

/** The downloaded archive isn't a recognisable Mini Infra backup. */
export class RestoreArtifactInvalidError extends Error {
  readonly code = "RESTORE_ARTIFACT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "RestoreArtifactInvalidError";
  }
}

/**
 * The backup was taken with a newer Mini Infra version than this image — it
 * contains an applied migration this image doesn't ship, so restoring it would
 * fail `migrate deploy` on boot. The operator must upgrade first.
 */
export class BackupNewerThanImageError extends Error {
  readonly code = "BACKUP_NEWER_THAN_IMAGE";
  readonly unknownMigration: string;
  constructor(unknownMigration: string) {
    super(
      `This backup was taken with a newer version of Mini Infra — it contains ` +
        `migration '${unknownMigration}' that this instance does not recognise. ` +
        `Upgrade this instance to at least that version before restoring from it.`,
    );
    this.unknownMigration = unknownMigration;
    this.name = "BackupNewerThanImageError";
  }
}

export interface StageRestoreParams {
  providerId: StorageProviderId;
  locationId: string;
  objectName: string;
}

export interface StageRestoreResult {
  stagedDbPath: string;
  markerPath: string;
  sizeBytes: number;
}

/** Optional overrides — the paths are injectable so unit tests stay hermetic. */
export interface StageRestoreOptions {
  /** Directory the live DB lives in (defaults to dirname of DATABASE_URL). */
  dataDir?: string;
  /**
   * The set of migration names this image ships. Defaults to reading the
   * `prisma/migrations` directory relative to the process cwd.
   */
  localMigrationNames?: Set<string>;
}

function defaultDataDir(): string {
  return path.dirname(getDatabaseFilePath());
}

function defaultMigrationsDir(): string {
  // At runtime the server's cwd is the `server/` dir (Dockerfile WORKDIR
  // /app/server), so migrations resolve at `<cwd>/prisma/migrations`.
  return path.join(process.cwd(), "prisma", "migrations");
}

/** Read the migration names this image ships (directory names). */
export async function readLocalMigrationNames(
  migrationsDir: string = defaultMigrationsDir(),
): Promise<Set<string>> {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
}

/**
 * Locate and return the SQLite `.db` dump inside a backup archive. The archive
 * also carries an optional encrypted NATS identity-seed blob under a named
 * entry; we key purely off the `.db` suffix, of which there is exactly one.
 */
export function extractDbFromZip(zipBuffer: Buffer): Buffer {
  const zip = new AdmZip(zipBuffer);
  const dbEntry = zip
    .getEntries()
    .find((e) => !e.isDirectory && e.entryName.endsWith(".db"));
  if (!dbEntry) {
    throw new RestoreArtifactInvalidError(
      "Backup archive does not contain a .db database file",
    );
  }
  return dbEntry.getData();
}

/**
 * Guard against restoring a DB newer than this image. Opens the staged file
 * read-only and compares its applied migrations against `localMigrationNames`.
 * Throws {@link BackupNewerThanImageError} on the first unknown migration, or
 * {@link RestoreArtifactInvalidError} if the file isn't a Mini Infra DB.
 */
export function assertBackupNotNewer(
  stagedDbPath: string,
  localMigrationNames: Set<string>,
): void {
  let db: Database.Database | null = null;
  try {
    db = new Database(stagedDbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL",
      )
      .all() as { migration_name: string }[];
    for (const { migration_name } of rows) {
      if (!localMigrationNames.has(migration_name)) {
        throw new BackupNewerThanImageError(migration_name);
      }
    }
  } catch (err) {
    if (err instanceof BackupNewerThanImageError) throw err;
    // A missing `_prisma_migrations` table (or an unreadable file) means this
    // isn't a Mini Infra database dump.
    throw new RestoreArtifactInvalidError(
      `Staged database is not a valid Mini Infra backup: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    );
  } finally {
    db?.close();
  }
}

/**
 * Stage an already-downloaded backup archive: extract the DB, run the
 * schema-version guard, and write the staged DB + marker. Separated from the
 * network download so it can be unit-tested with a crafted zip.
 */
export async function stageRestoreFromBuffer(
  zipBuffer: Buffer,
  params: StageRestoreParams,
  options: StageRestoreOptions = {},
): Promise<StageRestoreResult> {
  const dir = options.dataDir ?? defaultDataDir();
  const dbBytes = extractDbFromZip(zipBuffer);

  await fs.mkdir(dir, { recursive: true });
  const stagedDbPath = path.join(dir, RESTORE_STAGED_DB_FILENAME);
  await fs.writeFile(stagedDbPath, dbBytes);

  // Schema-version guard — refuse a newer-than-image backup BEFORE we commit
  // to a restart, rolling back the staged file so a rejected restore leaves
  // no residue on the volume.
  try {
    const localNames =
      options.localMigrationNames ?? (await readLocalMigrationNames());
    assertBackupNotNewer(stagedDbPath, localNames);
  } catch (err) {
    await fs.rm(stagedDbPath, { force: true });
    throw err;
  }

  const markerPath = path.join(dir, RESTORE_MARKER_FILENAME);
  await fs.writeFile(
    markerPath,
    JSON.stringify({
      providerId: params.providerId,
      locationId: params.locationId,
      objectName: params.objectName,
      stagedDbFilename: RESTORE_STAGED_DB_FILENAME,
      stagedAt: new Date().toISOString(),
    }),
  );

  log().info(
    {
      providerId: params.providerId,
      objectName: params.objectName,
      stagedDbPath,
      markerPath,
      sizeBytes: dbBytes.length,
    },
    "Restore staged; awaiting restart to apply",
  );

  return { stagedDbPath, markerPath, sizeBytes: dbBytes.length };
}

/**
 * Download a backup artifact from its storage backend and stage it for the
 * next-boot swap. Resolves the backend by the provider id the backup was
 * created under (via `getBackendByProviderIdOrThrow`), so it works even if the
 * operator has since switched active providers.
 */
export async function stageRestore(
  params: StageRestoreParams,
  db: PrismaClient = prismaDefault,
  options: StageRestoreOptions = {},
): Promise<StageRestoreResult> {
  const { providerId, locationId, objectName } = params;
  const backend = await StorageService.getInstance(
    db,
  ).getBackendByProviderIdOrThrow(providerId);

  log().info(
    { providerId, locationId, objectName },
    "Downloading backup artifact for restore",
  );
  const download = await backend.getDownloadStream(
    { id: locationId },
    objectName,
  );
  const zipBuffer = await bufferStream(download.stream);

  return stageRestoreFromBuffer(zipBuffer, params, options);
}

/**
 * Restart the process so the staged DB is swapped in on the next boot. Routes
 * through SIGTERM so the existing `gracefulShutdown` tears schedulers down
 * cleanly; Docker's `restart: unless-stopped` policy brings the container back.
 * A short delay lets the HTTP response flush to the client first.
 */
export function triggerRestoreRestart(delayMs = 750): void {
  log().warn(
    { delayMs },
    "Restart requested to apply restored database on next boot",
  );
  setTimeout(() => {
    process.kill(process.pid, "SIGTERM");
  }, delayMs);
}
