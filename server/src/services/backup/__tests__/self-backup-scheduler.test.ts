import { describe, it, expect, afterEach } from "vitest";
import { ErrorCode } from "@mini-infra/types";
import { ValidationError, InternalError } from "../../../lib/errors";
import { SelfBackupScheduler } from "../self-backup-scheduler";
import type { PrismaClient } from "../../../lib/prisma";

/**
 * Phase 11 — taxonomy conversion coverage for `SelfBackupScheduler`. Neither
 * `registerSchedule()` nor `enableSchedule()` touch Prisma, so a stub is
 * enough to construct the scheduler for these two error-path tests.
 */
describe("SelfBackupScheduler — error taxonomy", () => {
  let scheduler: SelfBackupScheduler;

  afterEach(async () => {
    // Avoid leaking a live node-cron task across tests.
    await scheduler?.unregisterSchedule();
  });

  it("registerSchedule() rejects an invalid cron expression with a ValidationError", async () => {
    scheduler = new SelfBackupScheduler({} as PrismaClient);

    await expect(
      scheduler.registerSchedule("not a cron expression", "UTC", "backups"),
    ).rejects.toMatchObject({
      constructor: ValidationError,
      code: ErrorCode.SELF_BACKUP_INVALID_CRON,
      statusCode: 400,
      isOperational: true,
    });
  });

  it("enableSchedule() rejects with an InternalError when no schedule has been registered", async () => {
    scheduler = new SelfBackupScheduler({} as PrismaClient);

    await expect(scheduler.enableSchedule()).rejects.toMatchObject({
      constructor: InternalError,
      code: ErrorCode.INTERNAL,
      statusCode: 500,
      isOperational: false,
    });
  });

  it("registerSchedule() accepts a valid cron expression and enableSchedule() then succeeds", async () => {
    scheduler = new SelfBackupScheduler({} as PrismaClient);

    await scheduler.registerSchedule("0 2 * * *", "UTC", "backups");
    await expect(scheduler.enableSchedule()).resolves.toBeUndefined();

    expect(scheduler.getScheduleInfo()).toMatchObject({
      isEnabled: true,
      schedule: "0 2 * * *",
      isRegistered: true,
    });
  });
});
