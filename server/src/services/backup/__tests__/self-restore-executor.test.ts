import { describe, it, expect, beforeEach, afterEach } from "vitest";
import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import {
  extractDbFromZip,
  assertBackupNotNewer,
  stageRestoreFromBuffer,
  RestoreArtifactInvalidError,
  BackupNewerThanImageError,
  RESTORE_STAGED_DB_FILENAME,
  RESTORE_MARKER_FILENAME,
} from "../self-restore-executor";

/**
 * Build a real SQLite DB file carrying a `_prisma_migrations` table with the
 * given applied migration names, and return its bytes. Mirrors the shape the
 * self-backup produces (a `.db` dump), so the restore path sees a genuine DB.
 */
function buildDbBuffer(migrationNames: string[], withTable = true): Buffer {
  const tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "restore-db-")),
    "sample.db",
  );
  const db = new Database(tmpFile);
  if (withTable) {
    db.exec(
      `CREATE TABLE _prisma_migrations (
         id TEXT PRIMARY KEY,
         migration_name TEXT NOT NULL,
         finished_at DATETIME,
         started_at DATETIME
       )`,
    );
    const insert = db.prepare(
      "INSERT INTO _prisma_migrations (id, migration_name, finished_at, started_at) VALUES (?, ?, ?, ?)",
    );
    const now = new Date().toISOString();
    migrationNames.forEach((name, i) =>
      insert.run(String(i), name, now, now),
    );
  } else {
    db.exec("CREATE TABLE some_other_table (id INTEGER PRIMARY KEY)");
  }
  db.close();
  const bytes = fs.readFileSync(tmpFile);
  fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  return bytes;
}

/** Zip a DB buffer under a `mini-infra-<ts>.db` entry, plus optional extras. */
function zipWith(entries: Record<string, Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries(entries)) {
    zip.addFile(name, data);
  }
  return zip.toBuffer();
}

describe("self-restore-executor", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-data-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe("extractDbFromZip", () => {
    it("returns the .db entry bytes when present", () => {
      const dbBytes = buildDbBuffer(["0001_init"]);
      const buffer = zipWith({ "mini-infra-2026-07-07T00-00-00.db": dbBytes });
      const extracted = extractDbFromZip(buffer);
      expect(extracted.length).toBe(dbBytes.length);
      expect(extracted.equals(dbBytes)).toBe(true);
    });

    it("throws when the archive has no .db entry", () => {
      const buffer = zipWith({ "nats-identity-seeds.enc": Buffer.from("seed") });
      expect(() => extractDbFromZip(buffer)).toThrow(RestoreArtifactInvalidError);
    });
  });

  describe("assertBackupNotNewer", () => {
    it("passes when every applied migration is known to this image", () => {
      const dbPath = path.join(dataDir, "sample.db");
      fs.writeFileSync(dbPath, buildDbBuffer(["0001_init", "0002_next"]));
      expect(() =>
        assertBackupNotNewer(dbPath, new Set(["0001_init", "0002_next", "0003_future"])),
      ).not.toThrow();
    });

    it("throws BackupNewerThanImageError on an unknown migration", () => {
      const dbPath = path.join(dataDir, "sample.db");
      fs.writeFileSync(dbPath, buildDbBuffer(["0001_init", "9999_from_the_future"]));
      expect(() =>
        assertBackupNotNewer(dbPath, new Set(["0001_init"])),
      ).toThrow(BackupNewerThanImageError);
    });

    it("throws RestoreArtifactInvalidError when there's no _prisma_migrations table", () => {
      const dbPath = path.join(dataDir, "sample.db");
      fs.writeFileSync(dbPath, buildDbBuffer([], false));
      expect(() => assertBackupNotNewer(dbPath, new Set())).toThrow(
        RestoreArtifactInvalidError,
      );
    });
  });

  describe("stageRestoreFromBuffer", () => {
    const params = {
      providerId: "azure" as const,
      locationId: "backups",
      objectName: "mini-infra-2026-07-07T00-00-00.db.zip",
    };

    it("stages the DB and writes the marker on the happy path", async () => {
      const buffer = zipWith({
        "mini-infra-2026-07-07T00-00-00.db": buildDbBuffer(["0001_init"]),
      });
      const result = await stageRestoreFromBuffer(buffer, params, {
        dataDir,
        localMigrationNames: new Set(["0001_init"]),
      });

      expect(result.stagedDbPath).toBe(path.join(dataDir, RESTORE_STAGED_DB_FILENAME));
      expect(fs.existsSync(result.stagedDbPath)).toBe(true);

      const markerPath = path.join(dataDir, RESTORE_MARKER_FILENAME);
      expect(fs.existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(await fsp.readFile(markerPath, "utf8"));
      expect(marker).toMatchObject({
        providerId: "azure",
        locationId: "backups",
        objectName: params.objectName,
        stagedDbFilename: RESTORE_STAGED_DB_FILENAME,
      });
    });

    it("rejects a newer-than-image backup and rolls back the staged file", async () => {
      const buffer = zipWith({
        "mini-infra-2026-07-07T00-00-00.db": buildDbBuffer(["0001_init", "9999_future"]),
      });
      await expect(
        stageRestoreFromBuffer(buffer, params, {
          dataDir,
          localMigrationNames: new Set(["0001_init"]),
        }),
      ).rejects.toBeInstanceOf(BackupNewerThanImageError);

      // Neither the staged DB nor the marker should survive a rejected restore.
      expect(fs.existsSync(path.join(dataDir, RESTORE_STAGED_DB_FILENAME))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, RESTORE_MARKER_FILENAME))).toBe(false);
    });

    it("throws when the archive contains no .db entry", async () => {
      const buffer = zipWith({ "nats-identity-seeds.enc": Buffer.from("seed") });
      await expect(
        stageRestoreFromBuffer(buffer, params, {
          dataDir,
          localMigrationNames: new Set(["0001_init"]),
        }),
      ).rejects.toBeInstanceOf(RestoreArtifactInvalidError);
    });
  });
});
