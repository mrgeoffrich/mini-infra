/**
 * Unit tests for the Phase 4 self-heal supervisor.
 *
 * The state-machine core is driven directly via `tick()` with a fake clock and
 * injected fakes for every I/O boundary (probe / flag / recreate / cap-audit),
 * so the dwell → backoff → cap → recovery logic is exercised deterministically
 * without Docker, NATS, or the reconciler. A second block proves the production
 * recreate wrapper reaches for `reconciler.update({ forceRecreate: true })` —
 * NOT a container restart — which is the load-bearing correctness point.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EgressAgentConnState } from "@mini-infra/types";

// ---------------------------------------------------------------------------
// Mock the heavy production-wiring deps so importing the module is side-effect
// free. The core-state-machine tests don't touch these; the recreate test
// drives the reconciler mock below.
// ---------------------------------------------------------------------------

const { mockBuildStackOperationServices, mockUpdate, mockCreateEvent, mockUpdateEvent } =
  vi.hoisted(() => ({
    mockBuildStackOperationServices: vi.fn(),
    mockUpdate: vi.fn(),
    mockCreateEvent: vi.fn(),
    mockUpdateEvent: vi.fn(),
  }));

vi.mock("../../stacks/stack-operation-context", () => ({
  buildStackOperationServices: mockBuildStackOperationServices,
}));

vi.mock("../../user-events/user-event-service", () => ({
  UserEventService: class {
    createEvent = mockCreateEvent;
    updateEvent = mockUpdateEvent;
  },
}));

vi.mock("../../stacks/stack-socket-emitter", () => ({
  emitStackApplyServiceResult: vi.fn(),
  emitStackApplyCompleted: vi.fn(),
  emitStackApplyFailed: vi.fn(),
}));

vi.mock("../../docker", () => ({
  default: { getInstance: () => ({ getDockerInstance: vi.fn() }) },
}));

vi.mock("../fw-agent-sidecar", () => ({
  findFwAgent: vi.fn(),
  getFwAgentConnState: vi.fn(),
  getFwAgentConfig: vi.fn(),
}));

vi.mock("../agent-health-scraper", () => ({
  scrapeGatewayConnState: vi.fn(),
}));

import {
  EgressSelfHealSupervisor,
  recreateEgressStackForSelfHeal,
  type EgressStackHealthProbe,
  type SelfHealConfig,
  type RecreateTarget,
} from "../egress-self-heal-supervisor";
import { stackOperationLock } from "../../stacks/operation-lock";

// ---------------------------------------------------------------------------
// Test harness for the core state machine.
// ---------------------------------------------------------------------------

const STACK_ID = "stack-fw-1";

function fwProbe(connState: EgressAgentConnState | null, containerRunning = true): EgressStackHealthProbe {
  return {
    stackId: STACK_ID,
    stackName: "egress-fw-agent",
    kind: "fw-agent",
    environmentId: null,
    containerRunning,
    connState,
  };
}

interface Harness {
  supervisor: EgressSelfHealSupervisor;
  setNow: (ms: number) => void;
  advance: (ms: number) => void;
  setProbes: (probes: EgressStackHealthProbe[]) => void;
  setEnabled: (enabled: boolean) => void;
  recreate: ReturnType<typeof vi.fn>;
  onCapReached: ReturnType<typeof vi.fn>;
  isLocked: ReturnType<typeof vi.fn>;
}

function makeHarness(config?: Partial<SelfHealConfig>): Harness {
  let now = 0;
  let probes: EgressStackHealthProbe[] = [];
  let enabled = true;
  const recreate = vi.fn(async (_t: RecreateTarget) => {});
  const onCapReached = vi.fn(async () => {});
  const isLocked = vi.fn(() => false);

  const supervisor = new EgressSelfHealSupervisor({
    probe: async () => probes,
    isEnabled: async () => enabled,
    recreate,
    onCapReached,
    isLocked,
    now: () => now,
    // Tiny, readable windows for deterministic driving.
    config: {
      tickIntervalMs: 1_000,
      dwellMs: 10,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      maxAttempts: 3,
      ...config,
    },
  });

  return {
    supervisor,
    setNow: (ms) => (now = ms),
    advance: (ms) => (now += ms),
    setProbes: (p) => (probes = p),
    setEnabled: (e) => (enabled = e),
    recreate,
    onCapReached,
    isLocked,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EgressSelfHealSupervisor — dwell + single recreate", () => {
  it("recreates exactly once after auth-failed holds past the dwell threshold", async () => {
    const h = makeHarness();
    h.setProbes([fwProbe("auth-failed")]);

    // t=0: first observation — dwell not yet met.
    h.setNow(0);
    await h.supervisor.tick();
    expect(h.recreate).not.toHaveBeenCalled();

    // t=dwell: dwell met → one recreate.
    h.setNow(10);
    await h.supervisor.tick();
    expect(h.recreate).toHaveBeenCalledTimes(1);
    expect(h.recreate).toHaveBeenCalledWith(
      expect.objectContaining({ stackId: STACK_ID, kind: "fw-agent", attempt: 1, maxAttempts: 3 }),
    );
  });

  it("does NOT re-trigger on a second tick inside the backoff window", async () => {
    const h = makeHarness();
    h.setProbes([fwProbe("auth-failed")]);

    h.setNow(0);
    await h.supervisor.tick(); // arm dwell
    h.setNow(10);
    await h.supervisor.tick(); // recreate #1 (lastAttempt=10, backoff(1)=100)
    expect(h.recreate).toHaveBeenCalledTimes(1);

    // t=10+50 < 10+100: still inside the backoff window.
    h.setNow(60);
    await h.supervisor.tick();
    expect(h.recreate).toHaveBeenCalledTimes(1);
  });
});

describe("EgressSelfHealSupervisor — backoff cap", () => {
  it("stops after maxAttempts and emits a single cap-reached event", async () => {
    const h = makeHarness(); // maxAttempts=3, base=100, dwell=10
    h.setProbes([fwProbe("auth-failed")]);

    h.setNow(0);
    await h.supervisor.tick(); // arm dwell
    h.setNow(10);
    await h.supervisor.tick(); // attempt 1 @10
    h.setNow(10 + 100); // backoff(1)=100
    await h.supervisor.tick(); // attempt 2 @110
    h.setNow(110 + 200); // backoff(2)=200
    await h.supervisor.tick(); // attempt 3 @310
    expect(h.recreate).toHaveBeenCalledTimes(3);
    expect(h.onCapReached).not.toHaveBeenCalled();

    // Next eligible window → cap reached, no further recreate.
    h.setNow(310 + 400); // backoff(3)=400
    await h.supervisor.tick();
    expect(h.recreate).toHaveBeenCalledTimes(3);
    expect(h.onCapReached).toHaveBeenCalledTimes(1);
    expect(h.onCapReached).toHaveBeenCalledWith(
      expect.objectContaining({ stackId: STACK_ID, maxAttempts: 3 }),
    );

    // And it never re-emits the cap alarm on subsequent ticks.
    h.setNow(310 + 400 + 5_000);
    await h.supervisor.tick();
    expect(h.onCapReached).toHaveBeenCalledTimes(1);
    expect(h.recreate).toHaveBeenCalledTimes(3);
  });
});

describe("EgressSelfHealSupervisor — recovery resets state", () => {
  it("resets attempts/backoff when the stack recovers to connected", async () => {
    const h = makeHarness();

    // One recreate under auth-failed.
    h.setProbes([fwProbe("auth-failed")]);
    h.setNow(0);
    await h.supervisor.tick();
    h.setNow(10);
    await h.supervisor.tick();
    expect(h.recreate).toHaveBeenCalledTimes(1);
    expect(h.supervisor._getStateForTest(STACK_ID)?.attempts).toBe(1);

    // Recovery → state cleared.
    h.setProbes([fwProbe("connected")]);
    h.setNow(20);
    await h.supervisor.tick();
    expect(h.supervisor._getStateForTest(STACK_ID)).toBeUndefined();

    // Auth-fails again later → treated as a fresh incident (dwell restarts,
    // attempt counter back to 1).
    h.setProbes([fwProbe("auth-failed")]);
    h.setNow(1_000);
    await h.supervisor.tick(); // arm dwell fresh
    h.setNow(1_010);
    await h.supervisor.tick(); // recreate again
    expect(h.recreate).toHaveBeenCalledTimes(2);
    expect(h.supervisor._getStateForTest(STACK_ID)?.attempts).toBe(1);
  });
});

describe("EgressSelfHealSupervisor — feature flag off", () => {
  it("takes no action when auto-remediation is disabled", async () => {
    const h = makeHarness();
    h.setEnabled(false);
    h.setProbes([fwProbe("auth-failed")]);

    h.setNow(0);
    await h.supervisor.tick();
    h.setNow(10_000); // well past dwell
    await h.supervisor.tick();

    expect(h.recreate).not.toHaveBeenCalled();
    expect(h.onCapReached).not.toHaveBeenCalled();
  });
});

describe("EgressSelfHealSupervisor — transient states never trigger", () => {
  it("ignores a reconnecting state no matter how long it persists", async () => {
    const h = makeHarness();
    h.setProbes([fwProbe("reconnecting")]);

    for (const t of [0, 10, 100, 1_000, 10_000]) {
      h.setNow(t);
      await h.supervisor.tick();
    }
    expect(h.recreate).not.toHaveBeenCalled();
  });

  it("ignores an unreachable (null) /healthz and a not-running container", async () => {
    const h = makeHarness();

    // null connState (agent /healthz unreachable — e.g. still starting).
    h.setProbes([fwProbe(null)]);
    h.setNow(0);
    await h.supervisor.tick();
    h.setNow(10_000);
    await h.supervisor.tick();
    expect(h.recreate).not.toHaveBeenCalled();

    // auth-failed but the container isn't running → not a candidate.
    h.setProbes([fwProbe("auth-failed", /* containerRunning */ false)]);
    h.setNow(20_000);
    await h.supervisor.tick();
    h.setNow(40_000);
    await h.supervisor.tick();
    expect(h.recreate).not.toHaveBeenCalled();
  });

  it("does not fire while an auth-failed flap dips through a transient state before dwell elapses", async () => {
    const h = makeHarness(); // dwell=10
    h.setNow(0);
    h.setProbes([fwProbe("auth-failed")]);
    await h.supervisor.tick(); // arm dwell @0

    // Blip to reconnecting before dwell elapses — clears the dwell marker.
    h.setNow(5);
    h.setProbes([fwProbe("reconnecting")]);
    await h.supervisor.tick();

    // Back to auth-failed; dwell must restart from here.
    h.setNow(8);
    h.setProbes([fwProbe("auth-failed")]);
    await h.supervisor.tick();

    // t=15 is >10 from t=0 but only 7ms since the marker re-armed at t=8.
    h.setNow(15);
    await h.supervisor.tick();
    expect(h.recreate).not.toHaveBeenCalled();

    // t=18 → 10ms since re-arm → now it fires.
    h.setNow(18);
    await h.supervisor.tick();
    expect(h.recreate).toHaveBeenCalledTimes(1);
  });
});

describe("EgressSelfHealSupervisor — respects the operation lock", () => {
  it("defers a recreate while a stack operation is in progress", async () => {
    const h = makeHarness();
    h.setProbes([fwProbe("auth-failed")]);
    h.isLocked.mockReturnValue(true);

    h.setNow(0);
    await h.supervisor.tick();
    h.setNow(10);
    await h.supervisor.tick();
    expect(h.recreate).not.toHaveBeenCalled();

    // Lock releases → next eligible tick recreates.
    h.isLocked.mockReturnValue(false);
    h.setNow(20);
    await h.supervisor.tick();
    expect(h.recreate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Production recreate wrapper — force-recreate, NOT restart.
// ---------------------------------------------------------------------------

describe("recreateEgressStackForSelfHeal (production wiring)", () => {
  const target: RecreateTarget = {
    stackId: "stack-gw-prod",
    stackName: "egress-gateway",
    kind: "gateway",
    environmentId: "env-1",
    attempt: 1,
    maxAttempts: 5,
    connState: "auth-failed",
  };

  beforeEach(() => {
    mockCreateEvent.mockResolvedValue({ id: "evt-1" });
    mockUpdateEvent.mockResolvedValue({ id: "evt-1" });
    mockUpdate.mockResolvedValue({
      success: true,
      stackId: target.stackId,
      appliedVersion: 2,
      serviceResults: [{ serviceName: "gateway", action: "recreate", success: true, duration: 5 }],
      resourceResults: [],
      duration: 5,
    });
    mockBuildStackOperationServices.mockResolvedValue({ reconciler: { update: mockUpdate } });
    // ensure the lock is free at the start of each case
    stackOperationLock.release(target.stackId);
  });

  it("calls reconciler.update with forceRecreate:true (re-mints creds; no restart)", async () => {
    await recreateEgressStackForSelfHeal({} as never, target);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const [calledStackId, opts] = mockUpdate.mock.calls[0];
    expect(calledStackId).toBe(target.stackId);
    expect(opts).toEqual(
      expect.objectContaining({ forceRecreate: true, triggeredBy: "system" }),
    );
    // audit trail: running event then a terminal update.
    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCategory: "infrastructure", triggeredBy: "system" }),
    );
    expect(mockUpdateEvent).toHaveBeenCalledWith(
      "evt-1",
      expect.objectContaining({ status: "completed" }),
    );
    // lock released afterwards.
    expect(stackOperationLock.has(target.stackId)).toBe(false);
  });

  it("skips (no reconciler call) when the operation lock is already held", async () => {
    stackOperationLock.tryAcquire(target.stackId);
    try {
      await recreateEgressStackForSelfHeal({} as never, target);
      expect(mockUpdate).not.toHaveBeenCalled();
    } finally {
      stackOperationLock.release(target.stackId);
    }
  });

  it("marks the event failed and releases the lock when the reconciler throws", async () => {
    mockUpdate.mockRejectedValue(new Error("boom"));
    await recreateEgressStackForSelfHeal({} as never, target);

    expect(mockUpdateEvent).toHaveBeenCalledWith(
      "evt-1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(stackOperationLock.has(target.stackId)).toBe(false);
  });
});
