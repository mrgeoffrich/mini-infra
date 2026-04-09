import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import Database from "better-sqlite3";

export function hasSqliteSchema(
  dbPath: string,
  markerTable: string = "users",
): boolean {
  if (!fs.existsSync(dbPath)) {
    return false;
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    const result = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(markerTable);
    db.close();
    return Boolean(result);
  } catch {
    return false;
  }
}

export function removeSqliteArtifacts(dbPath: string): void {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
}

export function listMigrationFiles(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(migrationsDir, entry.name, "migration.sql"))
    .filter((migrationPath) => fs.existsSync(migrationPath))
    .sort();
}

export function computeSqliteMigrationFingerprint(
  migrationFiles: string[],
): string {
  const hash = createHash("sha256");

  for (const migrationFile of migrationFiles) {
    hash.update(path.basename(path.dirname(migrationFile)));
    hash.update("\0");
    hash.update(fs.readFileSync(migrationFile));
    hash.update("\0");
  }

  return hash.digest("hex");
}

export function hasCurrentSqliteTemplateDatabase(options: {
  dbPath: string;
  fingerprintPath: string;
  migrationFiles: string[];
  markerTable?: string;
}): boolean {
  if (!hasSqliteSchema(options.dbPath, options.markerTable)) {
    return false;
  }

  if (!fs.existsSync(options.fingerprintPath)) {
    return false;
  }

  return (
    fs.readFileSync(options.fingerprintPath, "utf8")
    === computeSqliteMigrationFingerprint(options.migrationFiles)
  );
}

export function buildSqliteDatabaseFromMigrations(options: {
  targetDbPath: string;
  fingerprintPath: string;
  migrationFiles: string[];
}): void {
  removeSqliteArtifacts(options.targetDbPath);
  fs.rmSync(options.fingerprintPath, { force: true });

  const db = new Database(options.targetDbPath);
  try {
    for (const migrationFile of options.migrationFiles) {
      db.exec(fs.readFileSync(migrationFile, "utf8"));
    }
    fs.writeFileSync(
      options.fingerprintPath,
      computeSqliteMigrationFingerprint(options.migrationFiles),
    );
  } finally {
    db.close();
  }
}

export function cloneSqliteDatabase(
  templateDbPath: string,
  targetDbPath: string,
): void {
  removeSqliteArtifacts(targetDbPath);
  fs.copyFileSync(templateDbPath, targetDbPath);
}
