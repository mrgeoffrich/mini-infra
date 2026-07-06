/**
 * Unit tests for the slimmed `fw-agent-sidecar.ts` (ALT-27).
 *
 * The legacy host-singleton flow (`ensureFwAgent`/`removeFwAgent`/Unix
 * socket health checks) is gone — the fw-agent is now a stack template
 * bootstrapped by `bootstrapFwAgentStack`. The surviving compatibility
 * surface is small enough that focused tests are clearer than a re-do
 * of the legacy mock matrix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrisma,
  mockListContainers,
  mockGetDockerInstance,
  mockResolveFwAgentHealthBaseUrl,
  mockScrapeAgentHealth,
} = vi.hoisted(() => ({
  mockPrisma: {
    systemSettings: {
      findMany: vi.fn(),
    },
  },
  mockListContainers: vi.fn(),
  mockGetDockerInstance: vi.fn(),
  mockResolveFwAgentHealthBaseUrl: vi.fn(),
  mockScrapeAgentHealth: vi.fn(),
}));

vi.mock("../../../lib/prisma", () => ({ default: mockPrisma }));

vi.mock("../../docker", () => ({
  default: {
    getInstance: () => ({
      getDockerInstance: mockGetDockerInstance,
    }),
  },
}));

// Stub the out-of-band /healthz scrape so the connection-state path is
// exercised deterministically without standing up an agent or Docker.
vi.mock("../agent-health-scraper", () => ({
  resolveFwAgentHealthBaseUrl: mockResolveFwAgentHealthBaseUrl,
  scrapeAgentHealth: mockScrapeAgentHealth,
}));

// We do NOT exercise the bootstrap path in these tests — that's covered
// by the stack-bootstrap-specific tests. Stub it to a no-op so calling
// `restartFwAgent` here doesn't pull the whole apply pipeline in.
vi.mock("../fw-agent-stack-bootstrap", () => ({
  bootstrapFwAgentStack: vi.fn(async () => ({
    stackId: "stack-id-stub",
    applyDispatched: true,
    reason: null,
  })),
}));

import {
  findFwAgent,
  getFwAgentConfig,
  isFwAgentHealthy,
  restartFwAgent,
  composeFwAgentStatus,
  getFwAgentConnState,
  _pollAgentConnStateOnceForTest,
  FW_AGENT_STARTUP_STEPS,
} from "../fw-agent-sidecar";

beforeEach(() => {
  mockPrisma.systemSettings.findMany.mockReset();
  mockListContainers.mockReset();
  mockGetDockerInstance.mockReset();
  mockGetDockerInstance.mockResolvedValue({
    listContainers: mockListContainers,
  });
  mockResolveFwAgentHealthBaseUrl.mockReset();
  mockScrapeAgentHealth.mockReset();
});

describe("getFwAgentConfig", () => {
  it("falls back to the env-injected image when no setting is present", async () => {
    mockPrisma.systemSettings.findMany.mockResolvedValue([]);
    process.env.EGRESS_FW_AGENT_IMAGE_TAG = "ghcr.io/mini-infra/fw-agent:test";

    const cfg = await getFwAgentConfig();
    expect(cfg.image).toBe("ghcr.io/mini-infra/fw-agent:test");
    expect(cfg.autoStart).toBe(true);

    delete process.env.EGRESS_FW_AGENT_IMAGE_TAG;
  });

  it("treats auto_start='false' as disabled, anything else as enabled", async () => {
    mockPrisma.systemSettings.findMany.mockResolvedValue([
      { key: "auto_start", value: "false" },
    ]);
    expect((await getFwAgentConfig()).autoStart).toBe(false);

    mockPrisma.systemSettings.findMany.mockResolvedValue([
      { key: "auto_start", value: "true" },
    ]);
    expect((await getFwAgentConfig()).autoStart).toBe(true);

    mockPrisma.systemSettings.findMany.mockResolvedValue([]);
    expect((await getFwAgentConfig()).autoStart).toBe(true);
  });

  it("setting `image` overrides the env fallback", async () => {
    mockPrisma.systemSettings.findMany.mockResolvedValue([
      { key: "image", value: "registry.local/custom-fw:9.9" },
    ]);
    process.env.EGRESS_FW_AGENT_IMAGE_TAG = "ghcr.io/mini-infra/fw-agent:test";

    const cfg = await getFwAgentConfig();
    expect(cfg.image).toBe("registry.local/custom-fw:9.9");

    delete process.env.EGRESS_FW_AGENT_IMAGE_TAG;
  });
});

describe("findFwAgent", () => {
  it("returns the first container with the fw-agent label", async () => {
    mockListContainers.mockResolvedValue([
      { Id: "abc123", State: "running" },
    ]);
    const found = await findFwAgent();
    expect(found).toEqual({ id: "abc123", state: "running" });
    expect(mockListContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ["mini-infra.egress.fw-agent=true"] },
    });
  });

  it("returns null when no labelled container exists", async () => {
    mockListContainers.mockResolvedValue([]);
    expect(await findFwAgent()).toBeNull();
  });

  it("returns null and swallows docker errors", async () => {
    mockListContainers.mockRejectedValue(new Error("docker down"));
    expect(await findFwAgent()).toBeNull();
  });
});

describe("isFwAgentHealthy", () => {
  it("returns false (Phase 2 stub — Stage D10 wires it to KV)", () => {
    // Pinned so a careless re-introduction of the Unix-socket health path
    // fails the test. Stage D10 will replace the body and update this
    // assertion to read from the egress-fw-health KV bucket.
    expect(isFwAgentHealthy()).toBe(false);
  });
});

describe("restartFwAgent + FW_AGENT_STARTUP_STEPS", () => {
  it("preserves the four legacy step names for UI backward compat", () => {
    expect(FW_AGENT_STARTUP_STEPS).toEqual([
      "Pull fw-agent image",
      "Create container",
      "Start container",
      "Verify health",
    ]);
  });

  it("emits all four progress steps when the stack apply dispatches", async () => {
    // Container appears running on first poll → Verify health = "completed".
    mockListContainers.mockResolvedValue([
      { Id: "fw-id-1", State: "running" },
    ]);
    const events: { step: string; status: string }[] = [];
    const result = await restartFwAgent({
      onProgress: (step) => events.push({ step: step.step, status: step.status }),
    });
    expect(result).toEqual({ containerId: "fw-id-1" });
    expect(events.map((e) => e.step)).toEqual([...FW_AGENT_STARTUP_STEPS]);
    expect(events.every((e) => e.status === "completed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — out-of-band /healthz scrape + status composition
// ---------------------------------------------------------------------------

describe("out-of-band conn-state scrape (Phase 3)", () => {
  it("caches auth-failed from a scraped /healthz", async () => {
    mockResolveFwAgentHealthBaseUrl.mockResolvedValue("http://172.17.0.1:9750");
    mockScrapeAgentHealth.mockResolvedValue({
      status: "auth-failed",
      lastHeartbeatAgeMs: 42_000,
    });

    await _pollAgentConnStateOnceForTest();

    expect(mockScrapeAgentHealth).toHaveBeenCalledWith("http://172.17.0.1:9750");
    expect(getFwAgentConnState()).toBe("auth-failed");
  });

  it("caches null when the agent's /healthz can't be resolved/reached", async () => {
    mockResolveFwAgentHealthBaseUrl.mockResolvedValue(null);
    await _pollAgentConnStateOnceForTest();
    expect(getFwAgentConnState()).toBeNull();
    expect(mockScrapeAgentHealth).not.toHaveBeenCalled();
  });
});

describe("composeFwAgentStatus (Phase 3)", () => {
  it("flags authFailing when the container runs but /healthz reports auth-failed", () => {
    const status = composeFwAgentStatus({
      ownContainerId: "server-abc",
      found: { id: "fw-id-1", state: "running" },
      healthy: false, // in-band heartbeat can't publish under auth failure
      connState: "auth-failed",
    });
    expect(status.authFailing).toBe(true);
    expect(status.natsConnState).toBe("auth-failed");
    // available stays false — the in-band health is not fresh — but the UI can
    // now distinguish this from "still starting".
    expect(status.available).toBe(false);
    expect(status.containerRunning).toBe(true);
    expect(status.containerId).toBe("fw-id-1");
  });

  it("does not flag authFailing for a healthy connected agent", () => {
    const status = composeFwAgentStatus({
      ownContainerId: "server-abc",
      found: { id: "fw-id-1", state: "running" },
      healthy: true,
      connState: "connected",
    });
    expect(status.authFailing).toBe(false);
    expect(status.available).toBe(true);
    expect(status.natsConnState).toBe("connected");
  });

  it("does not flag authFailing when the container isn't running (still starting)", () => {
    // connState might momentarily be auth-failed while the container is being
    // recreated; authFailing requires the container to actually be running.
    const status = composeFwAgentStatus({
      ownContainerId: "server-abc",
      found: null,
      healthy: false,
      connState: "auth-failed",
    });
    expect(status.authFailing).toBe(false);
    expect(status.containerRunning).toBe(false);
    expect(status.available).toBe(false);
  });

  it("reports the not-in-docker case with no auth-failing signal", () => {
    const status = composeFwAgentStatus({
      ownContainerId: null,
      found: null,
      healthy: false,
      connState: null,
    });
    expect(status.available).toBe(false);
    expect(status.authFailing).toBe(false);
    expect(status.reason).toBe("Not running inside a Docker container");
  });
});
