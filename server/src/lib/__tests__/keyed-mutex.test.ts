import { KeyedMutex } from "../keyed-mutex";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("KeyedMutex", () => {
  it("serializes concurrent calls sharing the same key", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const task = (label: string, delayMs: number) =>
      mutex.runExclusive("same-key", async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        order.push(`${label}:start`);
        await wait(delayMs);
        order.push(`${label}:end`);
        concurrentCount--;
      });

    await Promise.all([task("a", 20), task("b", 5), task("c", 1)]);

    expect(maxConcurrent).toBe(1);
    // Call order is preserved even though later calls have shorter delays —
    // each callback only starts once the previous one has fully finished.
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("does not block calls with different keys", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    await Promise.all([
      mutex.runExclusive("key-1", async () => {
        order.push("key-1:start");
        await wait(20);
        order.push("key-1:end");
      }),
      mutex.runExclusive("key-2", async () => {
        order.push("key-2:start");
        await wait(1);
        order.push("key-2:end");
      }),
    ]);

    // key-2's short task finishes well before key-1's long task, proving
    // they ran concurrently rather than being serialized against each other.
    expect(order.indexOf("key-2:end")).toBeLessThan(order.indexOf("key-1:end"));
  });

  it("propagates the callback's own rejection to its caller", async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.runExclusive("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("does not wedge the queue when an earlier call throws", async () => {
    const mutex = new KeyedMutex();

    const first = mutex.runExclusive("k", async () => {
      throw new Error("first failed");
    });
    const second = mutex.runExclusive("k", async () => "second succeeded");

    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe("second succeeded");
  });

  it("runs N concurrent calls on the same key exactly once each, in order, with no overlap", async () => {
    const mutex = new KeyedMutex();
    let active = 0;
    let ranCount = 0;
    let overlapped = false;

    const calls = Array.from({ length: 20 }, (_, i) =>
      mutex.runExclusive("shared", async () => {
        active++;
        if (active > 1) overlapped = true;
        await wait(Math.random() * 3);
        ranCount++;
        active--;
        return i;
      }),
    );

    const results = await Promise.all(calls);

    expect(overlapped).toBe(false);
    expect(ranCount).toBe(20);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
