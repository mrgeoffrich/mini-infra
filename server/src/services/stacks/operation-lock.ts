import { getLogger } from '../../lib/logger-factory';

const logger = getLogger('stacks', 'operation-lock');

/**
 * Generous upper bound on how long any single stack operation (apply / update /
 * destroy / stop) may legitimately hold the lock. A well-behaved operation
 * always runs its `finally { release() }`, so an entry older than this can only
 * mean the holding operation died without releasing (process crash mid-op, an
 * un-awaited promise that threw, a hung Docker call that outlived a restart of
 * the async work but not the process). Rather than wedge apply/update/destroy
 * behind a 409 forever, we treat such an entry as abandoned and let the next
 * caller steal it.
 *
 * 30 minutes is deliberately far longer than any real apply — image pulls,
 * blue/green rollouts, and multi-service reconciles all complete well inside a
 * few minutes — so a stolen lock reliably indicates a genuine leak, not a
 * slow-but-live operation.
 */
export const STACK_OPERATION_LOCK_TTL_MS = 30 * 60 * 1000;

/**
 * In-process lock that prevents concurrent long-running operations on the same
 * stack. Apply, update, and destroy all share a single lock namespace because
 * running any two concurrently would corrupt Docker state and the reconciler
 * snapshot.
 *
 * Each held entry records the wall-clock time it was acquired. An entry older
 * than {@link STACK_OPERATION_LOCK_TTL_MS} is considered stale — a leaked lock
 * from an operation that never released — so `has()`/`tryAcquire()` log a
 * warning and proceed as if the lock were free (stealing it). Without this a
 * single hung operation would 409 every future apply/update/destroy until the
 * process restarts.
 *
 * This is intentionally in-process only — it does NOT coordinate across
 * multiple Mini Infra instances. Deploying horizontally requires a
 * distributed lock (Redis, Postgres advisory) which is out of scope here.
 */
export class StackOperationLock {
  /** stackId → epoch-ms the lock was acquired. */
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly ttlMs: number = STACK_OPERATION_LOCK_TTL_MS) {}

  /**
   * True when a live (non-stale) lock is held for the stack. A stale entry is
   * pruned and reported as not-held, so a leaked lock never blocks callers
   * beyond the TTL.
   */
  has(stackId: string): boolean {
    const acquiredAt = this.inFlight.get(stackId);
    if (acquiredAt === undefined) return false;

    if (this.isStale(acquiredAt)) {
      logger.warn(
        { stackId, heldForMs: Date.now() - acquiredAt, ttlMs: this.ttlMs },
        'Stack operation lock is stale — treating as released (a prior operation never released it)',
      );
      this.inFlight.delete(stackId);
      return false;
    }
    return true;
  }

  /**
   * Adds the stackId to the lock set. Returns false if a live lock is already
   * held. A stale lock is stolen (with a warning) and acquisition succeeds.
   */
  tryAcquire(stackId: string): boolean {
    const acquiredAt = this.inFlight.get(stackId);
    if (acquiredAt !== undefined && !this.isStale(acquiredAt)) {
      return false;
    }
    if (acquiredAt !== undefined) {
      logger.warn(
        { stackId, heldForMs: Date.now() - acquiredAt, ttlMs: this.ttlMs },
        'Stealing stale stack operation lock',
      );
    }
    this.inFlight.set(stackId, Date.now());
    return true;
  }

  release(stackId: string): void {
    this.inFlight.delete(stackId);
  }

  private isStale(acquiredAt: number): boolean {
    return Date.now() - acquiredAt >= this.ttlMs;
  }
}

/** Module-wide singleton used by the stacks routes. */
export const stackOperationLock = new StackOperationLock();
