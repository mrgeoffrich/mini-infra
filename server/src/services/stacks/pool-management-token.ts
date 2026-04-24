import crypto from 'crypto';
import argon2 from 'argon2';
import type { PrismaClient } from '../../generated/prisma/client';
import type { PoolConfig } from '@mini-infra/types';
import { getLogger } from '../../lib/logger-factory';

const log = getLogger('stacks', 'pool-management-token');

/** Number of random bytes; hex-encoded result is 64 chars. */
const TOKEN_BYTES = 32;

/**
 * Mint fresh pool management tokens for any Pool service whose `managedBy`
 * caller is being (re)created in this apply, or that has no existing token
 * yet. Stores the argon2id hash in `StackService.poolManagementTokenHash`
 * and returns the plaintext map so the caller can inject it into the
 * `managedBy` service's environment.
 *
 * Rotating unconditionally would break in-stack callers whose action is
 * `no-op`: their running container keeps the old token in env, but the
 * server-side hash has moved on — every subsequent API call would 401.
 * Instead we bind the token's lifetime to the container that consumes it:
 * rotate only when that container is being replaced.
 *
 * Returns a map of {poolServiceName -> plaintext token}. Plaintext is never
 * persisted. Services without `managedBy` are skipped — they cannot be
 * addressed via the management-token path and there's no target service to
 * inject the token into.
 */
export async function rotatePoolManagementTokens(
  prisma: PrismaClient,
  stackId: string,
  /**
   * Set of service names whose containers are being created or recreated in
   * this apply. A pool service's token is rotated iff its `managedBy` caller
   * is in this set (or the pool service has no token yet).
   */
  recreatedCallers: ReadonlySet<string>,
): Promise<Record<string, string>> {
  const poolServices = await prisma.stackService.findMany({
    where: { stackId, serviceType: 'Pool' },
    select: {
      id: true,
      serviceName: true,
      poolConfig: true,
      poolManagementTokenHash: true,
    },
  });

  const tokens: Record<string, string> = {};
  for (const svc of poolServices) {
    const config = svc.poolConfig as unknown as PoolConfig | null;
    if (!config?.managedBy) continue;

    // Rotate when the caller is being (re)created, or on first provisioning
    // when no hash exists yet. Otherwise the caller is a no-op and still
    // holds the previous plaintext in its container env — leave the hash
    // alone so that token keeps verifying.
    const shouldRotate =
      recreatedCallers.has(config.managedBy) || !svc.poolManagementTokenHash;
    if (!shouldRotate) continue;

    const plaintext = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
    await prisma.stackService.update({
      where: { id: svc.id },
      data: { poolManagementTokenHash: hash },
    });
    tokens[svc.serviceName] = plaintext;
    log.debug({ stackId, serviceName: svc.serviceName }, 'Rotated pool management token');
  }
  return tokens;
}

/**
 * Validate a plaintext bearer token against a stored hash.
 */
export async function verifyPoolManagementToken(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err) }, 'Token verify failed');
    return false;
  }
}
