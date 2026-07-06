import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";
import {
  materialiseTriggersForStack,
  refreshAllPgBackupTriggers,
  PG_AZ_BACKUP_SERVICE_NAME,
} from "../services/backup/backup-job-pool-materialiser";
import type { JobPoolConfig } from "@mini-infra/types";

async function seedEnvironment() {
  return testPrisma.environment.create({
    data: {
      name: `env-${createId().slice(0, 8)}`,
      type: "nonproduction",
      networkType: "local",
    },
  });
}

async function seedPgAzBackupStack(environmentId: string | null) {
  const stack = await testPrisma.stack.create({
    data: {
      name: `pg-az-backup-${createId().slice(0, 8)}`,
      environmentId,
      version: 1,
      networks: [],
      volumes: [],
    },
  });

  const service = await testPrisma.stackService.create({
    data: {
      stackId: stack.id,
      serviceName: PG_AZ_BACKUP_SERVICE_NAME,
      serviceType: "JobPool",
      dockerImage: "mini-infra-pg-az-backup",
      dockerTag: "latest",
      containerConfig: {},
      configFiles: [],
      initCommands: [],
      dependsOn: [],
      order: 0,
    },
  });

  return { stackId: stack.id, serviceId: service.id };
}

async function seedDatabaseWithBackupConfig(environmentId: string | null, schedule = "0 2 * * *") {
  const token = createId().slice(0, 8);
  const database = await testPrisma.postgresDatabase.create({
    data: {
      name: `db-${token}`,
      connectionString: "postgresql://user:pass@host:5432/db",
      host: "host",
      port: 5432,
      database: "db",
      username: "user",
      environmentId,
      tags: "[]",
    },
  });

  await testPrisma.backupConfiguration.create({
    data: {
      databaseId: database.id,
      schedule,
      isEnabled: true,
    },
  });

  return database;
}

function cronTriggerNames(config: unknown): string[] {
  const triggers = (config as JobPoolConfig | null)?.triggers ?? [];
  return triggers.filter((t) => t.kind === "cron").map((t) => t.name);
}

describe("materialiseTriggersForStack — environment scoping", () => {
  it("only materialises triggers for BackupConfiguration rows in the stack's own environment", async () => {
    const envA = await seedEnvironment();
    const envB = await seedEnvironment();

    const stackA = await seedPgAzBackupStack(envA.id);
    const stackB = await seedPgAzBackupStack(envB.id);

    const dbA = await seedDatabaseWithBackupConfig(envA.id);
    const dbB = await seedDatabaseWithBackupConfig(envB.id);

    await materialiseTriggersForStack(testPrisma, stackA.stackId);
    await materialiseTriggersForStack(testPrisma, stackB.stackId);

    const serviceA = await testPrisma.stackService.findUniqueOrThrow({ where: { id: stackA.serviceId } });
    const serviceB = await testPrisma.stackService.findUniqueOrThrow({ where: { id: stackB.serviceId } });

    expect(cronTriggerNames(serviceA.jobPoolConfig)).toEqual([`cron-${dbA.id}`]);
    expect(cronTriggerNames(serviceB.jobPoolConfig)).toEqual([`cron-${dbB.id}`]);
  });

  it("never materialises a trigger for a database with no environment set", async () => {
    const env = await seedEnvironment();
    const stack = await seedPgAzBackupStack(env.id);

    // Orphaned database — no environment assigned.
    await seedDatabaseWithBackupConfig(null);
    const scopedDb = await seedDatabaseWithBackupConfig(env.id);

    await materialiseTriggersForStack(testPrisma, stack.stackId);

    const service = await testPrisma.stackService.findUniqueOrThrow({ where: { id: stack.serviceId } });
    expect(cronTriggerNames(service.jobPoolConfig)).toEqual([`cron-${scopedDb.id}`]);
  });

  it("refreshAllPgBackupTriggers keeps every applied stack independently scoped", async () => {
    const envA = await seedEnvironment();
    const envB = await seedEnvironment();

    const stackA = await seedPgAzBackupStack(envA.id);
    const stackB = await seedPgAzBackupStack(envB.id);

    const dbA = await seedDatabaseWithBackupConfig(envA.id);
    const dbB = await seedDatabaseWithBackupConfig(envB.id);

    await refreshAllPgBackupTriggers(testPrisma);

    const serviceA = await testPrisma.stackService.findUniqueOrThrow({ where: { id: stackA.serviceId } });
    const serviceB = await testPrisma.stackService.findUniqueOrThrow({ where: { id: stackB.serviceId } });

    expect(cronTriggerNames(serviceA.jobPoolConfig)).toEqual([`cron-${dbA.id}`]);
    expect(cronTriggerNames(serviceB.jobPoolConfig)).toEqual([`cron-${dbB.id}`]);
  });
});
