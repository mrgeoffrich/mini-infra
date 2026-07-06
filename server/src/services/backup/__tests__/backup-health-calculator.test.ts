import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const selfBackupFindFirst = vi.fn();
const selfBackupCount = vi.fn();

vi.mock("../../../lib/prisma", () => ({
  default: {
    systemSettings: { findUnique: (...args: unknown[]) => findUnique(...args) },
    selfBackup: {
      findFirst: (...args: unknown[]) => selfBackupFindFirst(...args),
      count: (...args: unknown[]) => selfBackupCount(...args),
    },
  },
}));

import { calculateBackupHealth } from "../backup-health-calculator";

function mockSettings({
  storageLocationId,
  enabled,
}: {
  storageLocationId: string | null;
  enabled: boolean;
}) {
  findUnique.mockImplementation(({ where }: { where: { category_key: { key: string } } }) => {
    const { key } = where.category_key;
    if (key === "storage_location_id") {
      return Promise.resolve(storageLocationId ? { value: storageLocationId } : null);
    }
    if (key === "enabled") {
      return Promise.resolve({ value: enabled ? "true" : "false" });
    }
    return Promise.resolve(null);
  });
}

describe("calculateBackupHealth", () => {
  beforeEach(() => {
    findUnique.mockReset();
    selfBackupFindFirst.mockReset();
    selfBackupCount.mockReset();
  });

  it("reports not_configured when no storage location is set, even with a healthy backup history", async () => {
    mockSettings({ storageLocationId: null, enabled: true });

    const result = await calculateBackupHealth();

    expect(result.status).toBe("not_configured");
    expect(result.message).toBe("Self-backup not configured");
  });

  it("reports healthy once a storage location is configured, enabled, and backups are recent", async () => {
    mockSettings({ storageLocationId: "miniinfrabackup", enabled: true });
    selfBackupFindFirst
      .mockResolvedValueOnce({ startedAt: new Date(), status: "completed" }) // lastBackup
      .mockResolvedValueOnce({ completedAt: new Date() }); // lastSuccessfulBackup
    selfBackupCount.mockResolvedValue(0);

    const result = await calculateBackupHealth();

    expect(result.status).toBe("healthy");
    expect(result.message).toBe("Backups running normally");
  });

  it("reports disabled when a storage location is configured but scheduling is off", async () => {
    mockSettings({ storageLocationId: "miniinfrabackup", enabled: false });

    const result = await calculateBackupHealth();

    expect(result.status).toBe("not_configured");
    expect(result.message).toBe("Self-backup disabled");
  });
});
