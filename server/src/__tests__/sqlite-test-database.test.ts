import fs from "fs";
import os from "os";
import path from "path";
import {
  buildSqliteDatabaseFromMigrations,
  cloneSqliteDatabase,
  computeSqliteMigrationFingerprint,
  hasCurrentSqliteTemplateDatabase,
  hasSqliteSchema,
  listMigrationFiles,
  removeSqliteArtifacts,
} from "../test-support/sqlite-test-database";

describe("sqlite test database support", () => {
  let tempDir: string;
  let migrationsDir: string;
  let templateDbPath: string;
  let workerDbPath: string;
  let fingerprintPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-infra-sqlite-"));
    migrationsDir = path.join(tempDir, "migrations");
    templateDbPath = path.join(tempDir, "template.db");
    workerDbPath = path.join(tempDir, "worker.db");
    fingerprintPath = `${templateDbPath}.migrations-sha256`;

    fs.mkdirSync(path.join(migrationsDir, "0001_init"), { recursive: true });
    fs.mkdirSync(path.join(migrationsDir, "0002_more"), { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, "0001_init", "migration.sql"),
      "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);",
    );
    fs.writeFileSync(
      path.join(migrationsDir, "0002_more", "migration.sql"),
      "CREATE TABLE api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);",
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("builds, fingerprints, and clones a SQLite template database", () => {
    const migrationFiles = listMigrationFiles(migrationsDir);
    expect(migrationFiles).toHaveLength(2);
    expect(computeSqliteMigrationFingerprint(migrationFiles)).toHaveLength(64);

    buildSqliteDatabaseFromMigrations({
      targetDbPath: templateDbPath,
      fingerprintPath,
      migrationFiles,
    });

    expect(hasSqliteSchema(templateDbPath)).toBe(true);
    expect(
      hasCurrentSqliteTemplateDatabase({
        dbPath: templateDbPath,
        fingerprintPath,
        migrationFiles,
      }),
    ).toBe(true);

    cloneSqliteDatabase(templateDbPath, workerDbPath);
    expect(hasSqliteSchema(workerDbPath)).toBe(true);

    fs.writeFileSync(
      path.join(migrationsDir, "0002_more", "migration.sql"),
      "CREATE TABLE api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);",
    );

    expect(
      hasCurrentSqliteTemplateDatabase({
        dbPath: templateDbPath,
        fingerprintPath,
        migrationFiles: listMigrationFiles(migrationsDir),
      }),
    ).toBe(false);

    removeSqliteArtifacts(workerDbPath);
    expect(fs.existsSync(workerDbPath)).toBe(false);
  });
});
