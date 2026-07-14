/**
 * Guard: a database built from scratch by replaying `prisma/migrations` must
 * have every column the Prisma schema declares.
 *
 * This exists because of a trap that is silent on every database that already
 * exists, and only bites fresh installs and CI.
 *
 * SQLite cannot add a foreign key in place, so Prisma emits a *table redefine*
 * for those migrations: `CREATE TABLE new_<t>` with a column list snapshotted at
 * authoring time, copy the rows, `DROP TABLE <t>`, rename. If a later-authored
 * migration happens to sort BEFORE that redefine — which is exactly what happens
 * when an older migration carries a hand-rounded timestamp sitting in the future
 * — then its `ADD COLUMN`s are applied first and silently dropped when the
 * redefine recreates the table from its stale column list.
 *
 * Existing databases never notice (the redefine is already applied and will not
 * re-run), so the damage only shows up on a fresh `migrate deploy` — a new
 * install, or CI's template database. The migration
 * `20260714130000_stack_runtime_status_monitor` was originally generated as
 * `...104307` and lost both of its columns exactly this way.
 *
 * If this test fails, the fix is almost always to rename your migration
 * directory so it sorts AFTER the redefine that is eating it.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import {
  listMigrationFiles,
  buildSqliteDatabaseFromMigrations,
} from "../test-support/sqlite-test-database";

interface ParsedModel {
  name: string;
  table: string;
  columns: string[];
}

/**
 * Minimal Prisma schema parser — just enough to answer "what columns should
 * this model have?". The generated client's DMMF is not exported by the
 * `prisma-client` generator, so we read the schema itself.
 */
function parseSchema(schemaPath: string): ParsedModel[] {
  const source = fs.readFileSync(schemaPath, "utf8");

  const blocks = [...source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => ({
    name: m[1],
    body: m[2],
  }));
  const modelNames = new Set(blocks.map((b) => b.name));

  return blocks.map(({ name, body }) => {
    const mapMatch = body.match(/@@map\("([^"]+)"\)/);
    const table = mapMatch ? mapMatch[1] : name;

    const columns: string[] = [];
    for (const rawLine of body.split("\n")) {
      const line = rawLine.replace(/\/\/.*$/, "").trim();
      if (!line || line.startsWith("@@")) continue;

      const field = line.match(/^(\w+)\s+(\S+)/);
      if (!field) continue;

      const [, fieldName, rawType] = field;
      const baseType = rawType.replace(/[?[\]]/g, "");

      // Relation fields are not columns — their FK scalars are declared
      // separately and get checked on their own.
      if (modelNames.has(baseType)) continue;
      // List scalars are not columns in SQLite either.
      if (rawType.includes("[]")) continue;

      const colMatch = line.match(/@map\("([^"]+)"\)/);
      columns.push(colMatch ? colMatch[1] : fieldName);
    }

    return { name, table, columns };
  });
}

/** Build a throwaway database by replaying every migration in order. */
function buildFreshDatabase(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-infra-migrations-"));
  const dbPath = path.join(dir, "fresh.db");

  buildSqliteDatabaseFromMigrations({
    targetDbPath: dbPath,
    fingerprintPath: path.join(dir, "fingerprint"),
    migrationFiles: listMigrationFiles(path.join(process.cwd(), "prisma", "migrations")),
  });

  return new Database(dbPath, { readonly: true });
}

describe("migrations produce the declared schema", () => {
  const db = buildFreshDatabase();
  const models = parseSchema(path.join(process.cwd(), "prisma", "schema.prisma"));

  it("parses the schema and replays every migration", () => {
    expect(models.length).toBeGreaterThan(0);
  });

  it.each(models.map((m) => [m.name, m] as const))(
    "%s has every column the schema declares",
    (_name, model) => {
      const rows = db
        .prepare(`PRAGMA table_info("${model.table}")`)
        .all() as Array<{ name: string }>;
      const present = new Set(rows.map((r) => r.name));

      expect(
        rows.length,
        `Table "${model.table}" does not exist after replaying all migrations.`,
      ).toBeGreaterThan(0);

      const missing = model.columns.filter((column) => !present.has(column));

      expect(
        missing,
        `Table "${model.table}" is missing [${missing.join(", ")}] after replaying all ` +
          `migrations. A later table-redefine migration is probably dropping them — ` +
          `rename your migration directory so it sorts AFTER that redefine.`,
      ).toEqual([]);
    },
  );
});
