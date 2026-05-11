/**
 * Regression test for MINI-50 review finding M5 — per-fire
 * `DockerExecutorService` allocation in the JobPool cron + nats-request
 * trigger registries.
 *
 * Pre-fix, both registries called `await this.resolveDockerExecutor()` on
 * every fire (`fireOnce` for cron, the NATS subscription handler for
 * nats-request). The factory in `server.ts` constructs a fresh executor
 * each call — so a 1-minute cron allocated ~1,440 executors per day. The
 * fix mirrors the `lazyDockerExecutor` pattern in
 * `job-pool-exit-watcher.ts` — the registry caches the resolved executor
 * after the first fire.
 */
import { describe, it, expect, vi } from 'vitest';
import { JobPoolCronRegistry } from '../job-pool-cron-registry';
import { JobPoolNatsRegistry } from '../job-pool-nats-registry';
import type { DockerExecutorService } from '../../docker-executor';

// Minimal Prisma stub — these tests only exercise the executor-caching
// path, never the actual runJobPool call. `fireOnce` short-circuits when
// the service-not-found lookup returns null below.
function buildPrismaStub() {
  return {
    stackService: { findFirst: vi.fn().mockResolvedValue(null) },
    stack: { findUnique: vi.fn().mockResolvedValue(null) },
    poolInstance: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
}

describe('M5 — JobPoolCronRegistry caches DockerExecutorService across fires', () => {
  it('invokes the resolver exactly once across multiple fireOnce calls', async () => {
    const fakeExecutor = { id: 'exec-1' } as unknown as DockerExecutorService;
    const resolver = vi.fn().mockResolvedValue(fakeExecutor);
    const prisma = buildPrismaStub();

    const registry = new JobPoolCronRegistry(prisma as never, resolver);

    // fireOnce is private — invoke via the public API by introspecting
    // the prototype. We're testing the cached-executor seam, not the
    // overall fire semantics (those have their own tests).
    const fireOnce = (registry as unknown as {
      fireOnce: (stackId: string, serviceName: string, triggerName: string) => Promise<void>;
    }).fireOnce.bind(registry);

    await fireOnce('stack-1', 'backup', 'cron-1');
    await fireOnce('stack-1', 'backup', 'cron-1');
    await fireOnce('stack-1', 'backup', 'cron-1');
    await fireOnce('stack-1', 'backup', 'cron-1');
    await fireOnce('stack-1', 'backup', 'cron-1');

    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent first-time resolves so only one executor is constructed', async () => {
    let resolveExecutor: ((exec: DockerExecutorService) => void) | undefined;
    const executorPromise = new Promise<DockerExecutorService>((res) => {
      resolveExecutor = res;
    });
    const resolver = vi.fn().mockReturnValue(executorPromise);
    const prisma = buildPrismaStub();

    const registry = new JobPoolCronRegistry(prisma as never, resolver);
    const fireOnce = (registry as unknown as {
      fireOnce: (stackId: string, serviceName: string, triggerName: string) => Promise<void>;
    }).fireOnce.bind(registry);

    // Kick off 10 concurrent fires before the resolver settles.
    const fires = Array.from({ length: 10 }, () => fireOnce('stack-1', 'backup', 'cron-1'));
    // Resolver was called by the first fire; subsequent fires await the
    // same in-flight promise so the count stays at 1.
    await Promise.resolve();
    expect(resolver).toHaveBeenCalledTimes(1);
    resolveExecutor!({ id: 'exec-1' } as unknown as DockerExecutorService);
    await Promise.all(fires);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('clears the cache on resolver failure so a transient blip can retry', async () => {
    const prisma = buildPrismaStub();
    const resolver = vi
      .fn()
      .mockRejectedValueOnce(new Error('docker not yet ready'))
      .mockResolvedValue({ id: 'exec-1' } as unknown as DockerExecutorService);

    const registry = new JobPoolCronRegistry(prisma as never, resolver);
    const fireOnce = (registry as unknown as {
      fireOnce: (stackId: string, serviceName: string, triggerName: string) => Promise<void>;
    }).fireOnce.bind(registry);

    // First fire — resolver rejects; the fireOnce catch swallows the
    // error (registries don't fail-stop on a single fire).
    await fireOnce('stack-1', 'backup', 'cron-1');
    // Second fire — resolver should be invoked again because the
    // cached promise was cleared on the rejection.
    await fireOnce('stack-1', 'backup', 'cron-1');

    expect(resolver).toHaveBeenCalledTimes(2);
  });
});

describe('M5 — JobPoolNatsRegistry also caches the executor', () => {
  it('exposes the same private cache shape (structural pin)', () => {
    const resolver = vi.fn();
    const prisma = buildPrismaStub();
    const registry = new JobPoolNatsRegistry(prisma as never, resolver);
    // Inspect: the cached fields must exist so the M5 regression can't
    // silently slip back. Use `in` to avoid touching the private surface.
    expect('cachedDockerExecutor' in (registry as unknown as Record<string, unknown>)).toBe(true);
    expect('cachedDockerExecutorPromise' in (registry as unknown as Record<string, unknown>)).toBe(true);
  });
});

describe('M5 — BackupExecutorService caches the executor across queueBackup calls', () => {
  it('exposes the cached fields (structural pin)', async () => {
    const { BackupExecutorService } = await import('../../backup/backup-executor');
    const prisma = buildPrismaStub();
    const svc = new BackupExecutorService(prisma as never);
    expect('cachedDockerExecutor' in (svc as unknown as Record<string, unknown>)).toBe(true);
    expect('cachedDockerExecutorPromise' in (svc as unknown as Record<string, unknown>)).toBe(true);
  });
});

describe('M5 — postgres-restore route caches the executor at module scope', () => {
  it('exports a test-only reset helper indicating module-level caching is in place', async () => {
    const mod = await import('../../../routes/postgres-restore');
    expect(typeof mod.__resetRestoreDockerExecutorForTests).toBe('function');
    // Calling it should not throw.
    expect(() => mod.__resetRestoreDockerExecutorForTests()).not.toThrow();
  });
});
