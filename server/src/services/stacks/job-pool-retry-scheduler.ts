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
  /**
   * Number of retries already attempted for this run lineage. The
   * exit-watcher passes `attemptedRetries + 1` here — i.e. the count
   * **for** the retry we're about to schedule. The scheduler's guard
   * `attemptedRetries > onFailure.retries` (note: strictly greater)
   * bounds the chain so attempt N=onFailure.retries still fires but
   * N+1 doesn't.
   */
  attemptedRetries: number;
  onFailure: { retries: number; backoff: 'fixed' | 'exponential' };
  trigger: {
    kind: 'cron' | 'nats-request' | 'manual';
    name: string;
    metadata?: Record<string, string>;
  };
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
 * Counter semantics — `ctx.attemptedRetries` is the index **of the retry
 * about to be scheduled** (1 = first retry, 2 = second, ...). The
 * exit-watcher post-increments before calling here, so a freshly-failed
 * first attempt arrives with `attemptedRetries: 1`. The guard
 * `attemptedRetries > onFailure.retries` bounds the chain: when
 * `onFailure.retries: 3`, attempts 1/2/3 fire and attempt 4 short-circuits.
 *
 * Pre-fix (MINI-50 review finding H1), the watcher always passed `0` and
 * the scheduler used `>= retries` as the guard — so every retry was
 * treated as "attempt 0" and the chain ran forever the moment any operator
 * set `retries >= 1`. The combined fix moves the post-increment into the
 * watcher and switches the scheduler to `>` so the budget is the actual
 * number of retries declared.
 */
export function scheduleJobPoolRetry(
  prisma: PrismaClient,
  dockerExecutor: DockerExecutorService,
  ctx: RetryContext,
): void {
  if (ctx.attemptedRetries > ctx.onFailure.retries) {
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

  // Backoff index is `attempt - 1` so the first retry waits BASE, the
  // second waits 2×BASE on exponential, etc. (matches the table in
  // unit tests for `computeBackoffMs`).
  const backoffMs = computeBackoffMs(ctx.attemptedRetries - 1, ctx.onFailure.backoff);
  log.info(
    {
      stackId: ctx.stackId,
      serviceName: ctx.serviceName,
      attemptedRetries: ctx.attemptedRetries,
      maxRetries: ctx.onFailure.retries,
      backoffMs,
      backoffPolicy: ctx.onFailure.backoff,
    },
    'Scheduling JobPool retry',
  );

  setTimeout(() => {
    void runJobPool(prisma, dockerExecutor, {
      stackId: ctx.stackId,
      serviceName: ctx.serviceName,
      trigger: {
        kind: ctx.trigger.kind,
        // Append the attempt suffix to the trigger name so a chain of
        // retries is traceable in logs / history events. The base
        // trigger.name is the operator-declared trigger; the suffix is
        // the retry counter.
        name: `${stripRetrySuffix(ctx.trigger.name)}#retry${ctx.attemptedRetries}`,
        metadata: ctx.trigger.metadata,
      },
      attemptedRetries: ctx.attemptedRetries,
    })
      .then((result) => {
        if (!result.ok) {
          log.warn(
            { stackId: ctx.stackId, serviceName: ctx.serviceName, result },
            'JobPool retry spawn failed at dispatch — no further chained retries',
          );
        }
        // Chained retry on container exit code is handled by the exit
        // watcher when the new run's container dies (it post-increments
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

/**
 * Strip any trailing `#retry<N>` suffix the previous chain hop may have
 * appended so we don't accumulate `name#retry1#retry2#retry3` after a
 * multi-retry sequence. The base trigger name remains the operator-
 * declared identifier.
 */
function stripRetrySuffix(name: string): string {
  return name.replace(/(#retry\d+)+$/, '');
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
