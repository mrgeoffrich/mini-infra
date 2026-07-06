import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "../../__tests__/integration-test-helpers";

const { mockRunJobPool } = vi.hoisted(() => ({
  mockRunJobPool: vi.fn(),
}));

vi.mock("../docker-executor", () => ({
  DockerExecutorService: vi.fn(function () {
    return { initialize: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock("../stacks/job-pool-spawner", () => ({
  runJobPool: (...args: unknown[]) => mockRunJobPool(...args),
}));

import { BackupExecutorService } from "../backup/backup-executor";
import { PG_AZ_BACKUP_SERVICE_NAME } from "../backup/backup-job-pool-materialiser";

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

  await testPrisma.stackService.create({
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

  return stack.id;
}

async function seedDatabase(environmentId: string | null) {
  const token = createId().slice(0, 8);
  return testPrisma.postgresDatabase.create({
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
}

describe("BackupExecutorService.queueBackup — environment-scoped stack routing", () => {
  beforeEach(() => {
    mockRunJobPool.mockReset();
  });

  it("routes a manual backup to the pg-az-backup stack in the database's own environment", async () => {
    const envA = await seedEnvironment();
    const envB = await seedEnvironment();
    const stackA = await seedPgAzBackupStack(envA.id);
    await seedPgAzBackupStack(envB.id);
    const dbA = await seedDatabase(envA.id);

    mockRunJobPool.mockResolvedValue({
      ok: true,
      runId: "op-1",
      instanceRowId: "row-1",
      containerId: "container-1",
    });
    await testPrisma.backupOperation.create({
      data: {
        id: "op-1",
        databaseId: dbA.id,
        operationType: "manual",
        status: "pending",
      },
    });

    const executor = new BackupExecutorService(testPrisma);
    await executor.queueBackup(dbA.id, "manual", "user-1");

    expect(mockRunJobPool).toHaveBeenCalledWith(
      testPrisma,
      expect.anything(),
      expect.objectContaining({ stackId: stackA }),
    );
  });

  it("throws when the database doesn't exist", async () => {
    const executor = new BackupExecutorService(testPrisma);

    await expect(
      executor.queueBackup("nonexistent-db-id", "manual", "user-1"),
    ).rejects.toThrow("Database nonexistent-db-id not found");
    expect(mockRunJobPool).not.toHaveBeenCalled();
  });

  it("does not fall back to a stack applied in a different environment", async () => {
    const envA = await seedEnvironment();
    const envB = await seedEnvironment();
    // Only environment B has an applied pg-az-backup stack.
    await seedPgAzBackupStack(envB.id);
    const dbA = await seedDatabase(envA.id);

    const executor = new BackupExecutorService(testPrisma);

    await expect(
      executor.queueBackup(dbA.id, "manual", "user-1"),
    ).rejects.toThrow(
      "No pg-az-backup stack is currently applied. Deploy the pg-az-backup template from the template catalog before triggering a manual backup.",
    );
    expect(mockRunJobPool).not.toHaveBeenCalled();
  });
});
