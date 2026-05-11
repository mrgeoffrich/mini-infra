import { describe, it, expect } from "vitest";
import { buildTriggersFromBackupConfigurations } from "../backup/backup-job-pool-materialiser";

describe("buildTriggersFromBackupConfigurations (Phase 4, MINI-53)", () => {
  it("emits one cron trigger per enabled + scheduled config and a single nats-request trigger", () => {
    const triggers = buildTriggersFromBackupConfigurations([
      { databaseId: "db1", schedule: "0 2 * * *", timezone: "UTC", isEnabled: true },
      { databaseId: "db2", schedule: "30 3 * * *", timezone: "America/New_York", isEnabled: true },
    ]);

    const cronTriggers = triggers.filter((t) => t.kind === "cron");
    const natsTriggers = triggers.filter((t) => t.kind === "nats-request");

    expect(cronTriggers).toHaveLength(2);
    expect(natsTriggers).toHaveLength(1);

    expect(cronTriggers).toEqual([
      {
        kind: "cron",
        name: "cron-db1",
        schedule: "0 2 * * *",
        timezone: "UTC",
        // Structured metadata carries the databaseId so the runtime env
        // resolver can read it directly rather than parsing it out of the
        // cron-<id> name (MINI-50 review finding M8).
        metadata: { databaseId: "db1" },
      },
      {
        kind: "cron",
        name: "cron-db2",
        schedule: "30 3 * * *",
        timezone: "America/New_York",
        metadata: { databaseId: "db2" },
      },
    ]);

    expect(natsTriggers[0]).toEqual({
      kind: "nats-request",
      name: "nats-request",
      subject: "mini-infra.backup.run",
      ackWithRunId: true,
    });
  });

  it("skips disabled configurations but still emits the nats-request trigger", () => {
    const triggers = buildTriggersFromBackupConfigurations([
      { databaseId: "db1", schedule: "0 2 * * *", timezone: "UTC", isEnabled: false },
    ]);
    expect(triggers.filter((t) => t.kind === "cron")).toHaveLength(0);
    expect(triggers.filter((t) => t.kind === "nats-request")).toHaveLength(1);
  });

  it("skips configurations with no schedule but still emits the nats-request trigger", () => {
    const triggers = buildTriggersFromBackupConfigurations([
      { databaseId: "db1", schedule: null, timezone: "UTC", isEnabled: true },
    ]);
    expect(triggers.filter((t) => t.kind === "cron")).toHaveLength(0);
    expect(triggers.filter((t) => t.kind === "nats-request")).toHaveLength(1);
  });

  it("emits one nats-request trigger even with zero configurations", () => {
    const triggers = buildTriggersFromBackupConfigurations([]);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].kind).toBe("nats-request");
  });

  it("uses stable cron trigger names that survive config edits", () => {
    const first = buildTriggersFromBackupConfigurations([
      { databaseId: "db1", schedule: "0 2 * * *", timezone: "UTC", isEnabled: true },
    ]);
    const second = buildTriggersFromBackupConfigurations([
      { databaseId: "db1", schedule: "0 5 * * *", timezone: "UTC", isEnabled: true }, // schedule changed
    ]);
    const firstCron = first.find((t) => t.kind === "cron");
    const secondCron = second.find((t) => t.kind === "cron");
    expect(firstCron && "name" in firstCron && firstCron.name).toBe("cron-db1");
    expect(secondCron && "name" in secondCron && secondCron.name).toBe("cron-db1");
  });
});
