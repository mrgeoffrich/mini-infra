import type { PrismaClient } from '../../generated/prisma/client';
import type { DockerExecutorService } from '../docker-executor';
import { getLogger } from '../../lib/logger-factory';
import { runJobPool } from './job-pool-spawner';

const log = getLogger('stacks', 'job-pool-retry-scheduler');

/** Initial backoff for the first retry, in milliseconds. */
const BASE_BACKOFF_MS = 30_000;

interface RetryContext {
  stackId: string;
  serviceName: string;
  /** Number of retries already attempted for the current run lineage. */
  attemptedRetries: number;
  onFailure: { retries: number; backoff: 'fixed' | 'exponential' };
  trigger: { kind: 'cron' | 'nats-request' | 'manual'; name: string };
}

/**
 * Schedule a retry for a failed JobPool run after the policy's backoff. The
 * scheduler runs in-process — there's no durable queue, so a server restart
 * loses pending retries. That's an acceptable limitation for Phase 2: the
 * cron / nats-request triggers (Phase 3) own their own re-fire cadence, and
 * a missed retry is logged so operators can manually re-fire if needed.
 *
 * Backoff:
 *  - `fixed`: every retry waits exactly `BASE_BACKOFF_MS`.
 *  - `exponential`: attempt N waits `BASE_BACKOFF_MS * 2^N` (capped at 1h).
 *
 * The scheduler chains itself: if a scheduled retry also fails (the spawn
 * succeeds but the *container* exits non-zero), the exit watcher will
 * call back into here with an incremented `attemptedRetries`. The
 * `attemptedRetries < retries` guard keeps the chain bounded.
 */
export function scheduleJobPoolRetry(
  prisma: PrismaClient,
  dockerExecutor: DockerExecutorService,
  ctx: RetryContext,
): void {
  if (ctx.attemptedRetries >= ctx.onFailure.retries) {
    log.info(
      {
        stackId: ctx.stackId,
        serviceName: ctx.serviceName,
        attemptedRetries: ctx.attemptedRetries,
        maxRetries: ctx.onFailure.retries,
      },
      'JobPool retry budget exhausted — no further retries scheduled',
    );
    return;
  }

  const backoffMs = computeBackoffMs(ctx.attemptedRetries, ctx.onFailure.backoff);
  log.info(
    {
      stackId: ctx.stackId,
      serviceName: ctx.serviceName,
      attemptedRetries: ctx.attemptedRetries,
      backoffMs,
      backoffPolicy: ctx.onFailure.backoff,
    },
    'Scheduling JobPool retry',
  );

  setTimeout(() => {
    void runJobPool(prisma, dockerExecutor, {
      stackId: ctx.stackId,
      serviceName: ctx.serviceName,
      trigger: { kind: ctx.trigger.kind, name: `${ctx.trigger.name}#retry${ctx.attemptedRetries + 1}` },
    })
      .then((result) => {
        if (!result.ok) {
          log.warn(
            { stackId: ctx.stackId, serviceName: ctx.serviceName, result },
            'JobPool retry spawn failed at dispatch — no further chained retries',
          );
        }
        // Chained retry on container exit code is handled by the exit
        // watcher when the new run's container dies (it bumps
        // attemptedRetries via its own scheduleJobPoolRetry call).
      })
      .catch((err) => {
        log.error(
          {
            stackId: ctx.stackId,
            serviceName: ctx.serviceName,
            err: err instanceof Error ? err.message : String(err),
          },
          'JobPool retry runJobPool threw',
        );
      });
  }, backoffMs).unref();
}

export function computeBackoffMs(
  attemptedRetries: number,
  policy: 'fixed' | 'exponential',
): number {
  if (policy === 'fixed') return BASE_BACKOFF_MS;
  const cap = 60 * 60 * 1000; // 1 hour
  const exponent = Math.max(0, attemptedRetries);
  return Math.min(cap, BASE_BACKOFF_MS * Math.pow(2, exponent));
}
