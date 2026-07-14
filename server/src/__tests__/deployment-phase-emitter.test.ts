/**
 * Blue-green phase reporting (P4 4.7).
 *
 * The roadmap called this "mostly presentation" because "the events already
 * exist". They did not: the state machine only logged, and the runner discarded
 * every intermediate snapshot, so a multi-minute zero-downtime deploy reached the
 * UI as one spinning row. These pin the mapping that now carries it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const emitToChannel = vi.fn();
vi.mock("../lib/socket", () => ({
  emitToChannel: (...args: unknown[]) => emitToChannel(...args),
}));

import { phaseForState, createPhaseReporter } from "../services/stacks/deployment-phase-emitter";

describe("phaseForState", () => {
  it("maps the happy path of both blue-green machines", () => {
    expect(phaseForState("deployingGreenApp")).toBe("deploying-green");
    expect(phaseForState("waitingGreenReady")).toBe("waiting-green-ready");
    expect(phaseForState("healthCheckWait")).toBe("health-check");
    expect(phaseForState("openingTraffic")).toBe("switching-traffic");
    expect(phaseForState("completed")).toBe("completed");
    // Only on the recreate machine, not the update machine — one map serves both.
    expect(phaseForState("configuringFrontend")).toBe("registering-green");
  });

  it("collapses the three teardown states into one phase", () => {
    // An operator does not need to distinguish decommissioning the load-balancer
    // entry from stopping the container from removing it — it is all "removing
    // the old containers".
    expect(phaseForState("decommissioningBlueLB")).toBe("removing-blue");
    expect(phaseForState("stoppingBlueApp")).toBe("removing-blue");
    expect(phaseForState("removingBlueApp")).toBe("removing-blue");
  });

  it("reports a completed rollback as a FAILED deploy", () => {
    // The machine tidied up after itself, but the new version did not ship.
    // Calling that "complete" would be the most misleading thing on the page.
    expect(phaseForState("rollbackComplete")).toBe("failed");
    expect(phaseForState("rollbackStoppingGreenApp")).toBe("rolling-back");
  });

  it("is silent for unknown or non-string states", () => {
    // A machine gaining an internal state should emit nothing, rather than
    // surfacing a raw state name to an operator.
    expect(phaseForState("someNewInternalState")).toBeNull();
    expect(phaseForState(undefined)).toBeNull();
    expect(phaseForState({ nested: "state" })).toBeNull();
  });
});

describe("createPhaseReporter", () => {
  beforeEach(() => emitToChannel.mockClear());

  it("emits once per phase, not once per machine state", () => {
    const report = createPhaseReporter("stack-1", "web");

    report({ value: "deployingGreenApp" });
    // All three collapse to `removing-blue` — emitting three identical steps
    // would render as three identical rows.
    report({ value: "decommissioningBlueLB" });
    report({ value: "stoppingBlueApp" });
    report({ value: "removingBlueApp" });

    const phases = emitToChannel.mock.calls.map((c) => (c[2] as { phase: string }).phase);
    expect(phases).toEqual(["deploying-green", "removing-blue"]);
  });

  it("marks cutOver only once traffic is on the new containers", () => {
    const report = createPhaseReporter("stack-1", "web");

    report({ value: "healthCheckWait" });
    report({ value: "openingTraffic" });

    const events = emitToChannel.mock.calls.map((c) => c[2] as { phase: string; cutOver: boolean });
    // Before the switch a failure rolls back and nothing user-visible happened;
    // after it the new version is live and there is no going back.
    expect(events[0]).toMatchObject({ phase: "health-check", cutOver: false });
    expect(events[1]).toMatchObject({ phase: "switching-traffic", cutOver: true });
  });

  it("carries the stack and service so the client can attach it to the open apply", () => {
    const report = createPhaseReporter("stack-abc", "api");
    report({ value: "deployingGreenApp" });

    expect(emitToChannel).toHaveBeenCalledWith(
      "stacks",
      "stack:deployment:phase",
      expect.objectContaining({
        stackId: "stack-abc",
        serviceName: "api",
        label: "Deploying new containers",
      }),
    );
  });

  it("emits nothing for unknown states", () => {
    const report = createPhaseReporter("stack-1", "web");
    report({ value: "idle" });
    report({ value: "totallyNewState" });
    expect(emitToChannel).not.toHaveBeenCalled();
  });
});
