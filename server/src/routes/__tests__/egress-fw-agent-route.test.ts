/**
 * Route contract test for GET /api/egress-fw-agent/status (Phase 3).
 *
 * Done-when: when an agent's NATS connection is rejected with an auth error,
 * its /healthz reports auth-failed and the server status endpoint reflects
 * `auth-failing`. Here the scrape is stubbed (getFwAgentConnState — fed by the
 * out-of-band /healthz scrape) while the real `composeFwAgentStatus` runs, so
 * this exercises the endpoint's contract end-to-end at the HTTP boundary.
 */
import request from "supertest";
import express from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetOwnContainerId,
  mockFindFwAgent,
  mockIsFwAgentHealthy,
  mockGetFwAgentConnState,
} = vi.hoisted(() => ({
  mockGetOwnContainerId: vi.fn(),
  mockFindFwAgent: vi.fn(),
  mockIsFwAgentHealthy: vi.fn(),
  mockGetFwAgentConnState: vi.fn(),
}));

vi.mock("../../lib/logger-factory", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../middleware/auth", () => ({
  requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  getCurrentUserId: () => "test-user-id",
}));

vi.mock("../../lib/prisma", () => ({ default: {} }));
vi.mock("../../lib/socket", () => ({ emitToChannel: vi.fn() }));

vi.mock("../../services/self-update", () => ({
  getOwnContainerId: mockGetOwnContainerId,
}));

// Keep the real `composeFwAgentStatus` (pure) and only stub the signals it
// composes — so the test proves the *route* turns a scraped `auth-failed`
// conn-state into an `authFailing` response, not just that a mock echoes it.
vi.mock("../../services/egress/fw-agent-sidecar", async (importActual) => {
  const actual = await importActual<typeof import("../../services/egress/fw-agent-sidecar")>();
  return {
    ...actual,
    findFwAgent: mockFindFwAgent,
    isFwAgentHealthy: mockIsFwAgentHealthy,
    getFwAgentConnState: mockGetFwAgentConnState,
  };
});

import egressFwAgentRouter from "../egress-fw-agent";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/egress-fw-agent", egressFwAgentRouter);
  return app;
}

beforeEach(() => {
  mockGetOwnContainerId.mockReset();
  mockFindFwAgent.mockReset();
  mockIsFwAgentHealthy.mockReset();
  mockGetFwAgentConnState.mockReset();
});

describe("GET /api/egress-fw-agent/status", () => {
  it("surfaces authFailing when the scraped /healthz reports auth-failed", async () => {
    mockGetOwnContainerId.mockReturnValue("server-abc");
    mockFindFwAgent.mockResolvedValue({ id: "fw-container-id-123456", state: "running" });
    // In-band heartbeat can't publish under an auth failure → healthy = false.
    mockIsFwAgentHealthy.mockReturnValue(false);
    // Out-of-band scrape says: reached, but creds rejected.
    mockGetFwAgentConnState.mockReturnValue("auth-failed");

    const res = await request(buildApp()).get("/api/egress-fw-agent/status");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.authFailing).toBe(true);
    expect(res.body.natsConnState).toBe("auth-failed");
    expect(res.body.containerRunning).toBe(true);
    // Distinct from "available" — a generic health check alone couldn't tell
    // this apart from "still starting".
    expect(res.body.available).toBe(false);
  });

  it("reports a healthy connected agent without authFailing", async () => {
    mockGetOwnContainerId.mockReturnValue("server-abc");
    mockFindFwAgent.mockResolvedValue({ id: "fw-container-id-123456", state: "running" });
    mockIsFwAgentHealthy.mockReturnValue(true);
    mockGetFwAgentConnState.mockReturnValue("connected");

    const res = await request(buildApp()).get("/api/egress-fw-agent/status");

    expect(res.status).toBe(200);
    expect(res.body.authFailing).toBe(false);
    expect(res.body.available).toBe(true);
    expect(res.body.natsConnState).toBe("connected");
  });
});
