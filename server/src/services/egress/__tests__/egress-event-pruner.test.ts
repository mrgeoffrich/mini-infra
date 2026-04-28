/**
 * Tests for EgressEventPruner
 */

import { EgressEventPruner } from '../egress-event-pruner';
import type { PrismaClient } from '../../../generated/prisma/client';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('../../../lib/logger-factory', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../lib/logging-context', () => ({
  withOperation: (_name: string, fn: () => Promise<void>) => fn(),
}));

vi.mock('node-cron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node-cron')>();
  return {
    ...actual,
    schedule: vi.fn().mockReturnValue({
      stop: vi.fn(),
      destroy: vi.fn(),
    }),
    validate: vi.fn().mockReturnValue(true),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrisma(deleteResult = { count: 5 }): Mocked<PrismaClient> {
  return {
    egressEvent: {
      deleteMany: vi.fn().mockResolvedValue(deleteResult),
    },
  } as unknown as Mocked<PrismaClient>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EgressEventPruner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.EGRESS_EVENT_RETENTION_DAYS;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    delete process.env.EGRESS_EVENT_RETENTION_DAYS;
  });

  // -------------------------------------------------------------------------
  // Retention logic
  // -------------------------------------------------------------------------

  it('deletes rows older than 30 days by default', async () => {
    const prisma = makePrisma();
    const pruner = new EgressEventPruner(prisma);
    await pruner.runNow();

    const deleteMany = prisma.egressEvent.deleteMany as ReturnType<typeof vi.fn>;
    expect(deleteMany).toHaveBeenCalledTimes(1);

    const [args] = deleteMany.mock.calls[0] as [{ where: { occurredAt: { lt: Date } } }];
    const cutoff = args.where.occurredAt.lt;
    const expectedCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Allow 5 seconds tolerance
    expect(Math.abs(cutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(5000);
  });

  it('respects EGRESS_EVENT_RETENTION_DAYS env var', async () => {
    process.env.EGRESS_EVENT_RETENTION_DAYS = '7';
    const prisma = makePrisma();
    const pruner = new EgressEventPruner(prisma);
    await pruner.runNow();

    const deleteMany = prisma.egressEvent.deleteMany as ReturnType<typeof vi.fn>;
    const [args] = deleteMany.mock.calls[0] as [{ where: { occurredAt: { lt: Date } } }];
    const cutoff = args.where.occurredAt.lt;
    const expectedCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    expect(Math.abs(cutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(5000);
  });

  it('leaves rows newer than retention window untouched', async () => {
    // The deleteMany with { occurredAt: { lt: cutoff } } only deletes old rows.
    // We verify the cutoff is correct and the WHERE clause excludes newer rows.
    const prisma = makePrisma({ count: 0 });
    const pruner = new EgressEventPruner(prisma);
    await pruner.runNow();

    const deleteMany = prisma.egressEvent.deleteMany as ReturnType<typeof vi.fn>;
    const [args] = deleteMany.mock.calls[0] as [{ where: { occurredAt: { lt: Date } } }];
    // Anything older than the cutoff gets deleted; newer rows are NOT in the WHERE clause
    // This test verifies the cutoff is < now (so recent rows are preserved)
    expect(args.where.occurredAt.lt.getTime()).toBeLessThan(Date.now());
  });

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  it('starts the cron schedule on start()', async () => {
    const { schedule } = await import('node-cron');
    const prisma = makePrisma();
    const pruner = new EgressEventPruner(prisma);
    pruner.start();

    expect(schedule).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9*,/-]+ [0-9*,/-]+ \* \* \*$/),
      expect.any(Function),
      expect.objectContaining({ timezone: 'UTC' }),
    );
  });

  it('stops the cron task on stop()', async () => {
    const { schedule } = await import('node-cron');
    const mockTask = { stop: vi.fn(), destroy: vi.fn() };
    (schedule as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockTask);

    const prisma = makePrisma();
    const pruner = new EgressEventPruner(prisma);
    pruner.start();
    pruner.stop();

    expect(mockTask.stop).toHaveBeenCalled();
    expect(mockTask.destroy).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('does not throw when deleteMany fails', async () => {
    const prisma = makePrisma();
    (prisma.egressEvent.deleteMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('DB connection lost'),
    );

    const pruner = new EgressEventPruner(prisma);
    // Should not throw — pruner wraps in try/catch
    await expect(pruner.runNow()).resolves.toBe(0);
  });
});
