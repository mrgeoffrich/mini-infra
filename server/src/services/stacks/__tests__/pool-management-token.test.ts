import { describe, it, expect, vi } from 'vitest';
import { rotatePoolManagementTokens } from '../pool-management-token';

/**
 * Regression tests for the token-lifetime rule: a pool service's token is
 * bound to its `managedBy` caller's container lifecycle. Rotating on every
 * apply would 401 no-op callers whose running container still holds the
 * previous plaintext.
 */

type PrismaLike = Parameters<typeof rotatePoolManagementTokens>[0];

function makePrisma(services: Array<{
  id: string;
  serviceName: string;
  managedBy: string | null;
  poolManagementTokenHash: string | null;
}>) {
  const findMany = vi.fn().mockResolvedValue(
    services.map((s) => ({
      id: s.id,
      serviceName: s.serviceName,
      poolConfig: s.managedBy
        ? { defaultIdleTimeoutMinutes: 30, maxInstances: null, managedBy: s.managedBy }
        : { defaultIdleTimeoutMinutes: 30, maxInstances: null, managedBy: null },
      poolManagementTokenHash: s.poolManagementTokenHash,
    })),
  );
  const update = vi.fn().mockResolvedValue({});
  return {
    prisma: { stackService: { findMany, update } } as unknown as PrismaLike,
    findMany,
    update,
  };
}

describe('rotatePoolManagementTokens', () => {
  it('rotates when the managedBy caller is being recreated', async () => {
    const { prisma, update } = makePrisma([
      {
        id: 'svc-1',
        serviceName: 'worker',
        managedBy: 'manager',
        poolManagementTokenHash: 'old-hash',
      },
    ]);

    const tokens = await rotatePoolManagementTokens(prisma, 'stack-1', new Set(['manager']));

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'svc-1' },
        data: expect.objectContaining({
          poolManagementTokenHash: expect.any(String),
        }),
      }),
    );
    expect(tokens.worker).toBeDefined();
    expect(tokens.worker.length).toBe(64); // 32 bytes hex-encoded
  });

  it('mints on first apply when no hash exists, even without the caller in the set', async () => {
    const { prisma, update } = makePrisma([
      {
        id: 'svc-1',
        serviceName: 'worker',
        managedBy: 'manager',
        poolManagementTokenHash: null,
      },
    ]);

    const tokens = await rotatePoolManagementTokens(prisma, 'stack-1', new Set());

    expect(update).toHaveBeenCalledTimes(1);
    expect(tokens.worker).toBeDefined();
  });

  it('does NOT rotate when the managedBy caller is a no-op and a hash already exists', async () => {
    // This is the critical regression: previously rotated every apply, which
    // 401-locked running callers still holding the old plaintext in env.
    const { prisma, update } = makePrisma([
      {
        id: 'svc-1',
        serviceName: 'worker',
        managedBy: 'manager',
        poolManagementTokenHash: 'existing-hash',
      },
    ]);

    const tokens = await rotatePoolManagementTokens(prisma, 'stack-1', new Set());

    expect(update).not.toHaveBeenCalled();
    expect(tokens).toEqual({});
  });

  it('rotates only the affected pools when some callers are recreated and others are not', async () => {
    const { prisma, update } = makePrisma([
      {
        id: 'svc-a',
        serviceName: 'pool-a',
        managedBy: 'manager-a',
        poolManagementTokenHash: 'hash-a',
      },
      {
        id: 'svc-b',
        serviceName: 'pool-b',
        managedBy: 'manager-b',
        poolManagementTokenHash: 'hash-b',
      },
    ]);

    const tokens = await rotatePoolManagementTokens(
      prisma,
      'stack-1',
      new Set(['manager-a']),
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'svc-a' } }),
    );
    expect(tokens['pool-a']).toBeDefined();
    expect(tokens['pool-b']).toBeUndefined();
  });

  it('skips pools without managedBy', async () => {
    const { prisma, update } = makePrisma([
      {
        id: 'svc-1',
        serviceName: 'worker',
        managedBy: null,
        poolManagementTokenHash: null,
      },
    ]);

    const tokens = await rotatePoolManagementTokens(
      prisma,
      'stack-1',
      new Set(['anything']),
    );

    expect(update).not.toHaveBeenCalled();
    expect(tokens).toEqual({});
  });
});
