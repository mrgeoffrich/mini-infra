/**
 * A tiny in-process, per-key async mutex.
 *
 * The server is single-process, so this is sufficient to close
 * `findFirst`-then-`create` TOCTOU races within a single Node event loop —
 * it does NOT coordinate across multiple server processes/replicas. Two
 * calls to `runExclusive()` with the *same* key are guaranteed to run their
 * callbacks one at a time, in call order; calls with *different* keys never
 * block each other.
 *
 * A bare DB transaction does not fix this class of bug on its own: SQLite's
 * default isolation lets two concurrent `findFirst` calls both observe "no
 * row yet" before either `create` runs (see
 * `server/src/services/networks/membership-store.ts` for the concrete
 * find-or-create races this closes).
 */
export class KeyedMutex {
  /**
   * Per-key promise chain. Each entry always resolves (never rejects) once
   * its holder's callback has settled, so the *next* queued call for that
   * key can start regardless of whether the previous call threw. The actual
   * result/rejection of a given call is carried by a separate promise
   * (`run` in `runExclusive`) so callers still see their own callback's
   * outcome.
   */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Runs `fn` exclusively with respect to any other `runExclusive` call
   * sharing the same `key` — a later call waits for every earlier call on
   * that key to finish (success or failure) before its `fn` starts.
   */
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = this.tails.get(key) ?? Promise.resolve();

    // `fn` only runs once `previousTail` settles — `previousTail` itself
    // never rejects (see below), so the `.then` success handler is the only
    // one that ever fires, and it fires strictly after every earlier queued
    // call on this key has finished.
    const run = previousTail.then(fn);

    // The new tail: resolves once `run` settles, whatever the outcome —
    // this is what the NEXT call on this key awaits, so one callback
    // throwing never wedges the queue for the rest.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);

    // Once this call's tail is no longer the queue's current tail for this
    // key (i.e. nothing is waiting behind it), drop the entry so the map
    // doesn't grow without bound over the server's lifetime.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });

    return run;
  }
}
