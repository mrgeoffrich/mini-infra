import { describe, it, expect } from "vitest";
import {
  healthcheckToDocker,
  normaliseHealthcheckToMs,
  MS_HEURISTIC_THRESHOLD,
} from "../healthcheck-config";
import { resolveHealthCheckTimeoutMs } from "../../haproxy/health-check-timeout";

/**
 * These pin the unit contract for `StackContainerConfig.healthcheck`:
 * milliseconds in, nanoseconds out, converted in exactly one place.
 *
 * Each block below corresponds to a bug that shipped because nothing tested
 * this seam. Keep them.
 */
describe("healthcheckToDocker", () => {
  it("converts millisecond durations to nanoseconds", () => {
    const docker = healthcheckToDocker({
      test: ["CMD", "true"],
      interval: 30_000,
      timeout: 5_000,
      retries: 3,
      startPeriod: 15_000,
    });

    expect(docker).toEqual({
      Test: ["CMD", "true"],
      Interval: 30_000_000_000, // 30s
      Timeout: 5_000_000_000, //  5s
      Retries: 3,
      StartPeriod: 15_000_000_000, // 15s
    });
  });

  it("does not scale retries — it is a count, not a duration", () => {
    const docker = healthcheckToDocker({
      test: ["CMD", "true"],
      interval: 10_000,
      timeout: 3_000,
      retries: 5,
      startPeriod: 10_000,
    });

    expect(docker?.Retries).toBe(5);
  });

  it("keeps a 30s interval at 30s — the *1e9 bug made it ~8.3 hours", () => {
    // The regression: a UI-authored app stores interval 30000 (ms). The old
    // container-create paths multiplied by 1e9 as though it were seconds,
    // producing 30_000 seconds of Docker interval, so the healthcheck never ran
    // and the container sat `health: starting` forever.
    const docker = healthcheckToDocker({
      test: ["CMD", "true"],
      interval: 30_000,
      timeout: 5_000,
      retries: 3,
      startPeriod: 30_000,
    });

    const intervalSeconds = (docker?.Interval ?? 0) / 1_000_000_000;
    expect(intervalSeconds).toBe(30);
    expect(intervalSeconds).toBeLessThan(60); // not 30_000s (~8.3h)
  });

  it("returns undefined when no healthcheck is declared", () => {
    expect(healthcheckToDocker(undefined)).toBeUndefined();
  });

  it("narrows already-resolved template references", () => {
    // The template engine resolves "{{params.x}}" to a number before this runs,
    // but the type is NumOrTemplate so the value arrives as unknown-ish.
    const docker = healthcheckToDocker({
      test: ["CMD", "true"],
      interval: "20000" as unknown as number,
      timeout: "4000" as unknown as number,
      retries: "2" as unknown as number,
      startPeriod: "8000" as unknown as number,
    });

    expect(docker?.Interval).toBe(20_000_000_000);
    expect(docker?.Retries).toBe(2);
  });
});

describe("normaliseHealthcheckToMs (legacy seconds backfill)", () => {
  it("scales sub-threshold values as seconds", () => {
    const result = normaliseHealthcheckToMs({
      test: ["CMD", "true"],
      interval: 30,
      timeout: 5,
      retries: 3,
      startPeriod: 30,
    });

    expect(result?.healthcheck).toMatchObject({
      interval: 30_000,
      timeout: 5_000,
      startPeriod: 30_000,
    });
  });

  it("never scales retries, even though it is below the threshold", () => {
    const result = normaliseHealthcheckToMs({
      test: ["CMD", "true"],
      interval: 30,
      timeout: 5,
      retries: 3, // a count — must survive untouched
      startPeriod: 30,
    });

    expect(result?.healthcheck.retries).toBe(3);
    expect(result?.conversions.map((c) => c.key)).toEqual([
      "interval",
      "timeout",
      "startPeriod",
    ]);
  });

  it("returns null when everything is already milliseconds", () => {
    expect(
      normaliseHealthcheckToMs({
        test: ["CMD", "true"],
        interval: 30_000,
        timeout: 5_000,
        retries: 3,
        startPeriod: 30_000,
      }),
    ).toBeNull();
  });

  it("is idempotent — the backfill runs on every boot", () => {
    const first = normaliseHealthcheckToMs({
      test: ["CMD", "true"],
      interval: 30,
      timeout: 5,
      retries: 3,
      startPeriod: 30,
    });
    expect(first).not.toBeNull();

    // Re-running over the already-converted value must be a no-op, otherwise
    // every boot would multiply the interval by another 1000.
    const second = normaliseHealthcheckToMs(first!.healthcheck);
    expect(second).toBeNull();
  });

  it("leaves unrendered template expressions alone", () => {
    const result = normaliseHealthcheckToMs({
      test: ["CMD", "true"],
      interval: "{{params.interval}}",
      timeout: 5,
      retries: 3,
      startPeriod: "{{params.boot}}",
    });

    expect(result?.healthcheck.interval).toBe("{{params.interval}}");
    expect(result?.healthcheck.startPeriod).toBe("{{params.boot}}");
    expect(result?.healthcheck.timeout).toBe(5_000);
  });

  it("treats the threshold as already-ms", () => {
    expect(
      normaliseHealthcheckToMs({
        test: ["CMD", "true"],
        interval: MS_HEURISTIC_THRESHOLD,
        timeout: MS_HEURISTIC_THRESHOLD,
        retries: 3,
        startPeriod: MS_HEURISTIC_THRESHOLD,
      }),
    ).toBeNull();
  });
});

describe("resolveHealthCheckTimeoutMs consumes the same unit", () => {
  it("lets a slow-booting service extend past the 90s default", () => {
    // A template-authored startPeriod of 30 (seconds) used to reach this as
    // 30ms, fall under the floor, and clamp to the default — the slow-boot
    // extension was silently inert for every template-authored service. In ms
    // it now does what it says.
    expect(resolveHealthCheckTimeoutMs(180_000)).toBe(180_000);
  });

  it("still floors short values at the 90s default", () => {
    expect(resolveHealthCheckTimeoutMs(30_000)).toBe(90_000);
  });
});
