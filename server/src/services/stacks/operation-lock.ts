/**
 * In-process lock that prevents concurrent long-running operations on the same
 * stack. Apply, update, and destroy all share a single lock namespace because
 * running any two concurrently would corrupt Docker state and the reconciler
 * snapshot.
 *
 * This is intentionally in-process only — it does NOT coordinate across
 * multiple Mini Infra instances. Deploying horizontally requires a
 * distributed lock (Redis, Postgres advisory) which is out of scope here.
 */
export class StackOperationLock {
  private readonly inFlight = new Set<string>();

  has(stackId: string): boolean {
    return this.inFlight.has(stackId);
  }

  /** Adds the stackId to the lock set. Returns false if already held. */
  tryAcquire(stackId: string): boolean {
    if (this.inFlight.has(stackId)) return false;
    this.inFlight.add(stackId);
    return true;
  }

  release(stackId: string): void {
    this.inFlight.delete(stackId);
  }
}

/** Module-wide singleton used by the stacks routes. */
export const stackOperationLock = new StackOperationLock();
