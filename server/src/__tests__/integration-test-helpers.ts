import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { createId } from "@paralleldrive/cuid2";
import { parseSqliteDatabaseUrl } from "../lib/database-url-parser";
import {
  buildSqliteDatabaseFromMigrations,
  cloneSqliteDatabase,
  hasCurrentSqliteTemplateDatabase,
  hasSqliteSchema,
  listMigrationFiles,
  removeSqliteArtifacts,
} from "../test-support/sqlite-test-database";

const PRISMA_DIR = path.join(process.cwd(), "prisma");
const MIGRATIONS_DIR = path.join(PRISMA_DIR, "migrations");
const MIGRATION_FILES = listMigrationFiles(MIGRATIONS_DIR);
const TEMPLATE_DB_URL = "file:./test-template.db";
const TEMPLATE_DB_PATH = parseSqliteDatabaseUrl(
  TEMPLATE_DB_URL,
  PRISMA_DIR,
);
const TEMPLATE_DB_LOCK_PATH = `${TEMPLATE_DB_PATH}.lock`;
const TEMPLATE_DB_FINGERPRINT_PATH = `${TEMPLATE_DB_PATH}.migrations-sha256`;

function getWorkerId(): string {
  return process.env.VITEST_WORKER_ID ?? "0";
}

export function getWorkerTestDatabaseUrl(): string {
  return `file:./test-worker-${getWorkerId()}.db`;
}

function getWorkerTestDatabasePath(): string {
  return parseSqliteDatabaseUrl(
    getWorkerTestDatabaseUrl(),
    PRISMA_DIR,
  );
}

const TEST_DB_PATH = getWorkerTestDatabasePath();
const TEST_DB_URL = getWorkerTestDatabaseUrl();

type IntegrationTestState = {
  prisma?: PrismaClient;
  initPromise?: Promise<PrismaClient>;
};

declare global {
  var __miniInfraIntegrationTestState: IntegrationTestState | undefined;
}

function getState(): IntegrationTestState {
  globalThis.__miniInfraIntegrationTestState ??= {};
  return globalThis.__miniInfraIntegrationTestState;
}

function getInitializedPrisma(): PrismaClient {
  const prisma = getState().prisma;

  if (!prisma) {
    throw new Error(
      "Integration test database is not initialized. Check setup-integration.ts.",
    );
  }

  return prisma;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function hasCurrentTemplateDatabase(): boolean {
  return hasCurrentSqliteTemplateDatabase({
    dbPath: TEMPLATE_DB_PATH,
    fingerprintPath: TEMPLATE_DB_FINGERPRINT_PATH,
    migrationFiles: MIGRATION_FILES,
  });
}

function createTemplateDatabaseFromMigrations(): void {
  buildSqliteDatabaseFromMigrations({
    targetDbPath: TEMPLATE_DB_PATH,
    fingerprintPath: TEMPLATE_DB_FINGERPRINT_PATH,
    migrationFiles: MIGRATION_FILES,
  });
}

async function withTemplateDatabaseLock<T>(
  callback: () => Promise<T>,
): Promise<T> {
  const timeoutMs = 30_000;
  const pollMs = 50;
  const startTime = Date.now();

  while (true) {
    try {
      fs.mkdirSync(TEMPLATE_DB_LOCK_PATH);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code !== "EEXIST") {
        throw error;
      }

      if (Date.now() - startTime > timeoutMs) {
        throw new Error("Timed out waiting for integration test database lock");
      }

      await sleep(pollMs);
    }
  }

  try {
    return await callback();
  } finally {
    fs.rmSync(TEMPLATE_DB_LOCK_PATH, { recursive: true, force: true });
  }
}

async function ensureTemplateDatabase(): Promise<void> {
  await withTemplateDatabaseLock(async () => {
    if (hasCurrentTemplateDatabase()) {
      return;
    }

    createTemplateDatabaseFromMigrations();
  });
}

function cloneWorkerDatabaseFromTemplate(): void {
  cloneSqliteDatabase(TEMPLATE_DB_PATH, TEST_DB_PATH);
}

export function isWorkerDatabaseInitialized(): boolean {
  return hasSqliteSchema(TEST_DB_PATH);
}

export async function resetWorkerIntegrationTestDatabase(): Promise<void> {
  await ensureTemplateDatabase();

  const state = getState();
  const sharedPrisma = (globalThis as { prisma?: PrismaClient }).prisma;
  const statePrisma = state.prisma;

  if (statePrisma) {
    await statePrisma.$disconnect();
    state.prisma = undefined;
  }

  if (sharedPrisma && sharedPrisma !== statePrisma) {
    await sharedPrisma.$disconnect();
  }

  (globalThis as { prisma?: PrismaClient }).prisma = undefined;
  state.initPromise = undefined;
  cloneWorkerDatabaseFromTemplate();
}

export async function ensureIntegrationTestDatabase(): Promise<void> {
  await ensureTemplateDatabase();

  if (!isWorkerDatabaseInitialized()) {
    cloneWorkerDatabaseFromTemplate();
  }
}

export async function initializeIntegrationTestDatabase(): Promise<PrismaClient> {
  const state = getState();

  if (state.prisma) {
    return state.prisma;
  }

  if (!state.initPromise) {
    state.initPromise = (async () => {
      process.env.DATABASE_URL = TEST_DB_URL;

      await ensureIntegrationTestDatabase();

      const prisma = new PrismaClient({
        datasources: {
          db: {
            url: TEST_DB_URL,
          },
        },
      });

      await prisma.$connect();
      state.prisma = prisma;
      return prisma;
    })().catch((error) => {
      state.initPromise = undefined;
      throw error;
    });
  }

  return state.initPromise;
}

export async function truncateIntegrationTestDatabase(): Promise<void> {
  const prisma = getInitializedPrisma();
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    SELECT name FROM sqlite_master
    WHERE type='table'
      AND name NOT LIKE '_prisma%'
      AND name != 'sqlite_sequence'
  `;

  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = OFF");

  try {
    for (const { name } of tables) {
      await prisma.$executeRawUnsafe(`DELETE FROM "${name}"`);
    }
  } finally {
    await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  }
}

export async function disconnectIntegrationTestDatabase(): Promise<void> {
  const state = getState();
  const sharedPrisma = (globalThis as { prisma?: PrismaClient }).prisma;
  const statePrisma = state.prisma;

  if (!statePrisma) {
    if (sharedPrisma) {
      await sharedPrisma.$disconnect();
      (globalThis as { prisma?: PrismaClient }).prisma = undefined;
    }
    return;
  }

  await statePrisma.$disconnect();
  state.prisma = undefined;
  state.initPromise = undefined;

  if (sharedPrisma === statePrisma) {
    (globalThis as { prisma?: PrismaClient }).prisma = undefined;
  } else if (sharedPrisma) {
    await sharedPrisma.$disconnect();
    (globalThis as { prisma?: PrismaClient }).prisma = undefined;
  }
}

export const testPrisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const prisma = getInitializedPrisma();
    const value = Reflect.get(prisma, property, receiver);
    return typeof value === "function" ? value.bind(prisma) : value;
  },
});

export async function createTestUser() {
  const prisma = getInitializedPrisma();
  const userId = createId();

  return prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@example.com`,
      name: `Test User ${userId}`,
      googleId: `google-${userId}`,
      image: `https://example.com/avatar/${userId}.jpg`,
    },
  });
}

export async function createTestApiKey(
  userId: string,
  name: string = "Test API Key",
) {
  const prisma = getInitializedPrisma();
  const keyId = createId();

  return prisma.apiKey.create({
    data: {
      id: keyId,
      name,
      key: `mk_${keyId.padEnd(64, "0")}`,
      userId,
      active: true,
    },
  });
}
