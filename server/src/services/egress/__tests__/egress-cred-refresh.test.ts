/**
 * Unit tests for the Phase 6 live cred refresh.
 *
 * The state-less core (`refreshEgressAgentCreds`) and the rotation-gated
 * post-apply handler (`makeNatsPostApplyHandler`) are driven directly with
 * injected fakes for every I/O boundary (flag / enumeration / mint / write /
 * audit), so the behaviour is exercised deterministically without Docker,
 * NATS, or Prisma. The load-bearing points proven here:
 *   - a rotation with the flag ON re-mints + rewrites the creds file for each
 *     running egress agent and triggers NO recreate (the core has no
 *     reconciler dependency at all — it only ever writes the creds file);
 *   - the flag OFF ⇒ no push (recovery defers to Phase 4's self-heal);
 *   - a write failure is audited and never throws into the apply path;
 *   - a no-op apply (rotated: false) does not re-mint.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the heavy production-wiring deps so importing the module is side-effect
// free. The core tests inject their own fakes and never touch these.
// ---------------------------------------------------------------------------

vi.mock("../../docker", () => ({
  default: { getInstance: () => ({ getDockerInstance: vi.fn() }) },
}));

vi.mock("../../docker-executor", () => ({
  DockerExecutorService: class {
    initialize = vi.fn();
  },
}));

vi.mock("../fw-agent-sidecar", () => ({
  getFwAgentConfig: vi.fn(),
}));

vi.mock("../../user-events/user-event-service", () => ({
  UserEventService: class {
    createEvent = vi.fn();
  },
}));

vi.mock("../../nats/nats-control-plane-service", () => ({
  getNatsControlPlaneService: vi.fn(),
  setNatsPostApplyHook: vi.fn(),
}));

import {
  refreshEgressAgentCreds,
  makeNatsPostApplyHandler,
  type EgressCredRefreshDeps,
  type RunningEgressAgent,
} from "../egress-cred-refresh";
import type { NatsIdentityRotationInfo } from "../../nats/nats-control-plane-service";
import { natsCredsFileName } from "../../nats/nats-creds-volume";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fwAgent(): RunningEgressAgent {
  return {
    stackId: "stack-fw-1",
    stackName: "egress-fw-agent",
    kind: "fw-agent",
    environmentId: null,
    projectName: "mini-infra-egress-fw-agent",
    credentialProfileId: "profile-fw",
  };
}

function gatewayAgent(): RunningEgressAgent {
  return {
    stackId: "stack-gw-1",
    stackName: "egress-gateway",
    kind: "gateway",
    environmentId: "env-1",
    projectName: "prod-egress-gateway",
    credentialProfileId: "profile-gw",
  };
}

/**
 * Build a deps set with sensible spies; override per test. Returns handles that
 * reference the *merged* deps (so an override is what the returned spy points
 * at), plus the `deps` object to pass to the code under test.
 */
function makeDeps(overrides: Partial<EgressCredRefreshDeps> = {}): {
  deps: EgressCredRefreshDeps;
  isEnabled: ReturnType<typeof vi.fn>;
  listRunningAgents: ReturnType<typeof vi.fn>;
  mint: ReturnType<typeof vi.fn>;
  writeCreds: ReturnType<typeof vi.fn>;
  auditPush: ReturnType<typeof vi.fn>;
  auditFailure: ReturnType<typeof vi.fn>;
} {
  const deps: EgressCredRefreshDeps = {
    isEnabled: vi.fn().mockResolvedValue(true),
    listRunningAgents: vi.fn().mockResolvedValue([fwAgent(), gatewayAgent()]),
    mint: vi.fn().mockImplementation(async (id: string) => `creds-for-${id}`),
    writeCreds: vi.fn().mockResolvedValue(undefined),
    auditPush: vi.fn().mockResolvedValue(undefined),
    auditFailure: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return {
    deps,
    isEnabled: deps.isEnabled as ReturnType<typeof vi.fn>,
    listRunningAgents: deps.listRunningAgents as ReturnType<typeof vi.fn>,
    mint: deps.mint as ReturnType<typeof vi.fn>,
    writeCreds: deps.writeCreds as ReturnType<typeof vi.fn>,
    auditPush: deps.auditPush as ReturnType<typeof vi.fn>,
    auditFailure: deps.auditFailure as ReturnType<typeof vi.fn>,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Core: refreshEgressAgentCreds
// ---------------------------------------------------------------------------

describe("refreshEgressAgentCreds", () => {
  it("flag ON: re-mints + rewrites the creds file for each running agent (no recreate)", async () => {
    const h = makeDeps();

    const result = await refreshEgressAgentCreds(h.deps, { reason: "rotation-x" });

    expect(result).toEqual({ enabled: true, attempted: 2, pushed: 2, failed: 0 });

    // Re-minted once per agent, from its bound credential profile id.
    expect(h.mint).toHaveBeenCalledTimes(2);
    expect(h.mint).toHaveBeenCalledWith("profile-fw");
    expect(h.mint).toHaveBeenCalledWith("profile-gw");

    // Wrote the per-stack `<stackId>.creds` into each stack's own volume
    // (keyed by project name) — this is the whole mechanism, and it is the
    // ONLY side effect (no reconciler / recreate is ever reached).
    expect(h.writeCreds).toHaveBeenCalledTimes(2);
    expect(h.writeCreds).toHaveBeenCalledWith("mini-infra-egress-fw-agent", [
      { fileName: natsCredsFileName("stack-fw-1"), contents: "creds-for-profile-fw" },
    ]);
    expect(h.writeCreds).toHaveBeenCalledWith("prod-egress-gateway", [
      { fileName: natsCredsFileName("stack-gw-1"), contents: "creds-for-profile-gw" },
    ]);

    // Each successful push is audited; no failures.
    expect(h.auditPush).toHaveBeenCalledTimes(2);
    expect(h.auditFailure).not.toHaveBeenCalled();
  });

  it("flag OFF: pushes nothing (defers to Phase 4 self-heal)", async () => {
    const h = makeDeps({ isEnabled: vi.fn().mockResolvedValue(false) });

    const result = await refreshEgressAgentCreds(h.deps, { reason: "rotation-x" });

    expect(result).toEqual({ enabled: false, attempted: 0, pushed: 0, failed: 0 });
    expect(h.listRunningAgents).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.writeCreds).not.toHaveBeenCalled();
    expect(h.auditPush).not.toHaveBeenCalled();
    expect(h.auditFailure).not.toHaveBeenCalled();
  });

  it("a write failure is audited and does not throw (recovery falls back to Phase 4)", async () => {
    const writeCreds = vi
      .fn()
      // fw-agent write blows up; gateway write succeeds.
      .mockRejectedValueOnce(new Error("volume write boom"))
      .mockResolvedValueOnce(undefined);
    const h = makeDeps({ writeCreds });

    const result = await refreshEgressAgentCreds(h.deps, { reason: "rotation-x" });

    // Never throws; one push, one failure.
    expect(result).toEqual({ enabled: true, attempted: 2, pushed: 1, failed: 1 });
    expect(h.auditFailure).toHaveBeenCalledTimes(1);
    expect(h.auditFailure).toHaveBeenCalledWith(fwAgent(), "rotation-x", expect.any(Error));
    expect(h.auditPush).toHaveBeenCalledTimes(1);
    expect(h.auditPush).toHaveBeenCalledWith(gatewayAgent(), "rotation-x");
  });

  it("a mint failure is audited and does not throw", async () => {
    const mint = vi.fn().mockRejectedValue(new Error("vault read boom"));
    const h = makeDeps({ mint });

    const result = await refreshEgressAgentCreds(h.deps, { reason: "rotation-x" });

    expect(result).toEqual({ enabled: true, attempted: 2, pushed: 0, failed: 2 });
    expect(h.writeCreds).not.toHaveBeenCalled();
    expect(h.auditFailure).toHaveBeenCalledTimes(2);
  });

  it("a push-audit failure never breaks the push loop", async () => {
    const auditPush = vi.fn().mockRejectedValue(new Error("audit boom"));
    const h = makeDeps({ auditPush });

    const result = await refreshEgressAgentCreds(h.deps, { reason: "rotation-x" });

    // Both creds files still written despite audit failures.
    expect(result).toEqual({ enabled: true, attempted: 2, pushed: 2, failed: 0 });
    expect(h.writeCreds).toHaveBeenCalledTimes(2);
  });

  it("no running agents: clean no-op", async () => {
    const h = makeDeps({ listRunningAgents: vi.fn().mockResolvedValue([]) });

    const result = await refreshEgressAgentCreds(h.deps, { reason: "rotation-x" });

    expect(result).toEqual({ enabled: true, attempted: 0, pushed: 0, failed: 0 });
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.writeCreds).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Handler: makeNatsPostApplyHandler — rotation gating
// ---------------------------------------------------------------------------

function rotationInfo(rotated: boolean): NatsIdentityRotationInfo {
  return {
    rotated,
    generatedSeeds: false,
    operatorPublic: "OABCDEF1234567890",
    systemAccountPublic: "ASYS1234567890",
  };
}

describe("makeNatsPostApplyHandler", () => {
  it("no-op apply (rotated: false) does not re-mint or enumerate", async () => {
    const h = makeDeps();
    const handler = makeNatsPostApplyHandler(h.deps);

    await handler(rotationInfo(false));

    expect(h.isEnabled).not.toHaveBeenCalled();
    expect(h.listRunningAgents).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.writeCreds).not.toHaveBeenCalled();
  });

  it("rotation (rotated: true) drives the live refresh", async () => {
    const h = makeDeps();
    const handler = makeNatsPostApplyHandler(h.deps);

    await handler(rotationInfo(true));

    expect(h.isEnabled).toHaveBeenCalledTimes(1);
    expect(h.listRunningAgents).toHaveBeenCalledTimes(1);
    expect(h.mint).toHaveBeenCalledTimes(2);
    expect(h.writeCreds).toHaveBeenCalledTimes(2);
  });

  it("rotation with flag OFF still no-op-pushes (defers to Phase 4)", async () => {
    const h = makeDeps({ isEnabled: vi.fn().mockResolvedValue(false) });
    const handler = makeNatsPostApplyHandler(h.deps);

    await handler(rotationInfo(true));

    expect(h.isEnabled).toHaveBeenCalledTimes(1);
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.writeCreds).not.toHaveBeenCalled();
  });
});
