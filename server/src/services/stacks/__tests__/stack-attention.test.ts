import { describe, it, expect } from "vitest";
import { computeStackAttention } from "@mini-infra/types";

/**
 * The needs-attention rollup is the honest signal: `status` is a coarse
 * lifecycle field, and a crashed container lands there as `drifted`, which
 * badly undersells "your app is down". These pin the level mapping.
 *
 * It lives in @mini-infra/types so the server (inside serializeStack) and the
 * client share ONE implementation — the client used to reimplement it, which is
 * why the agent sidecar and API-key callers had no rollup at all.
 */
describe("computeStackAttention", () => {
  it("is quiet for a healthy synced stack", () => {
    const attention = computeStackAttention({ status: "synced" });

    expect(attention).toEqual({
      level: "none",
      needsAttention: false,
      reasons: [],
      updateAvailable: false,
    });
  });

  it("reports a dead service as CRITICAL and names it", () => {
    // The whole point of 3.1: the badge used to say `synced` while the app was
    // down. A dead container is not merely "drifted" — it is an outage.
    const attention = computeStackAttention({
      status: "drifted",
      runtimeIssues: [{ kind: "not-running", serviceName: "api", status: "exited" }],
    });

    expect(attention.level).toBe("critical");
    expect(attention.needsAttention).toBe(true);
    expect(attention.reasons).toEqual([
      "Service 'api' is not running (exited) — run Apply to restart it.",
    ]);
  });

  it("reports a missing container as CRITICAL", () => {
    const attention = computeStackAttention({
      status: "drifted",
      runtimeIssues: [{ kind: "missing", serviceName: "worker" }],
    });

    expect(attention.level).toBe("critical");
    expect(attention.reasons[0]).toContain("has no container");
  });

  it("reports an out-of-band replacement as WARNING — the app is up, just not ours", () => {
    const attention = computeStackAttention({
      status: "drifted",
      runtimeIssues: [{ kind: "hash-mismatch", serviceName: "api" }],
    });

    expect(attention.level).toBe("warning");
    expect(attention.reasons[0]).toContain("no longer matches the applied definition");
  });

  it("falls back to generic drift copy only when the monitor has no specifics", () => {
    // Drift a human found by opening the plan (template edit, network drift) —
    // the cheap runtime check cannot see it, so there are no runtimeIssues.
    const attention = computeStackAttention({ status: "drifted" });

    expect(attention.level).toBe("warning");
    expect(attention.reasons).toEqual([
      "Live containers have drifted from the definition — run Apply to reconcile.",
    ]);
  });

  it("does not emit the generic drift copy alongside specific issues", () => {
    const attention = computeStackAttention({
      status: "drifted",
      runtimeIssues: [{ kind: "not-running", serviceName: "api", status: "exited" }],
    });

    expect(attention.reasons).toHaveLength(1);
    expect(attention.reasons.join(" ")).not.toContain("Live containers have drifted");
  });

  it("reports a failed apply as CRITICAL with the failure reason", () => {
    const attention = computeStackAttention({
      status: "error",
      lastFailureReason: "image pull failed: unauthorized",
    });

    expect(attention.level).toBe("critical");
    expect(attention.reasons[0]).toBe("Last apply failed: image pull failed: unauthorized");
  });

  it("reports unapplied edits as WARNING", () => {
    const attention = computeStackAttention({ status: "pending" });

    expect(attention.level).toBe("warning");
    expect(attention.reasons[0]).toContain("hasn't been applied");
  });

  it("reports an available template update as INFO — an opportunity, not a problem", () => {
    const attention = computeStackAttention({
      status: "synced",
      templateUpdateAvailable: true,
    });

    expect(attention.level).toBe("info");
    expect(attention.updateAvailable).toBe(true);
    expect(attention.needsAttention).toBe(true);
  });

  it("folds NATS drift in as WARNING, orthogonal to status", () => {
    const attention = computeStackAttention({
      status: "synced",
      natsDrift: { drifted: true },
    });

    expect(attention.level).toBe("warning");
    expect(attention.reasons[0]).toContain("NATS configuration has drifted");
  });

  it("takes the loudest level when several signals fire at once", () => {
    const attention = computeStackAttention({
      status: "drifted",
      runtimeIssues: [{ kind: "not-running", serviceName: "api", status: "exited" }],
      natsDrift: { drifted: true },
      templateUpdateAvailable: true,
    });

    // critical (dead service) must win over warning (nats) and info (update).
    expect(attention.level).toBe("critical");
    expect(attention.reasons).toHaveLength(3);
    expect(attention.updateAvailable).toBe(true);
  });
});
