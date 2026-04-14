export interface RetryOptions {
  attempts?: number;
  minMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryContext {
  attempt: number;
  abort(): void;
  retryAfterMs(ms: number): void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function retryWithBackoff<T>(
  fn: (ctx: RetryContext) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const attempts = opts.attempts ?? 10;
  const min = opts.minMs ?? 5_000;
  const max = opts.maxMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;

  let aborted = false;
  let explicitDelay: number | null = null;

  for (let i = 0; i < attempts; i++) {
    const ctx: RetryContext = {
      attempt: i,
      abort: () => {
        aborted = true;
      },
      retryAfterMs: (ms) => {
        explicitDelay = ms;
      },
    };
    try {
      return await fn(ctx);
    } catch (err) {
      if (aborted) throw err;
      if (i + 1 >= attempts) throw err;
      const backoff = Math.min(min * 2 ** i, max);
      const delay = explicitDelay !== null ? Math.max(backoff, Math.min(explicitDelay, max)) : backoff;
      explicitDelay = null;
      await sleep(delay);
    }
  }
  throw new Error("retryWithBackoff exhausted attempts without result");
}
