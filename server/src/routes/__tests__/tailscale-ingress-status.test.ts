import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Mock the route's collaborators so the test exercises only the ingress
// handler's logic (hostname resolution, device matching, URL construction).
const { mockPrisma, mockTailscale } = vi.hoisted(() => ({
  mockPrisma: { stack: { findFirst: vi.fn() } },
  mockTailscale: {
    getClientId: vi.fn(),
    getTailnetDomain: vi.fn(),
    listDevices: vi.fn(),
  },
}));

vi.mock("../../middleware/auth", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../lib/prisma", () => ({ default: mockPrisma }));
vi.mock("../../services/tailscale/tailscale-service", () => ({
  TailscaleService: class {
    getClientId = mockTailscale.getClientId;
    getTailnetDomain = mockTailscale.getTailnetDomain;
    listDevices = mockTailscale.listDevices;
  },
}));

import request from "supertest";
import express from "express";
import router from "../tailscale-connectivity";

const app = express();
app.use(express.json());
app.use("/api/connectivity", router);

const device = (over: Partial<{ hostname: string; name: string; online: boolean }>) => ({
  id: "node-1",
  hostname: over.hostname ?? "mini-infra",
  name: over.name ?? "mini-infra.tail-abc.ts.net",
  online: over.online ?? true,
  lastSeen: "2026-07-07T00:00:00.000Z",
  tags: ["tag:mini-infra-managed"],
});

describe("GET /api/connectivity/tailscale/ingress", () => {
  // Fake only Date (not setTimeout) so the route's 10s response cache can be
  // stepped past between tests without deadlocking supertest's real timers.
  let clock = 1_000_000_000;

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    clock += 60_000; // jump past the 10s ingress cache TTL
    vi.setSystemTime(clock);
  });

  it("returns a clean unconfigured shape without hitting the tailnet API", async () => {
    mockPrisma.stack.findFirst.mockResolvedValue(null);
    mockTailscale.getClientId.mockResolvedValue(null);

    const res = await request(app).get("/api/connectivity/tailscale/ingress");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      configured: false,
      hostname: "mini-infra",
      tailnetDomain: null,
      ingressUrl: null,
      deviceOnline: false,
      deviceName: null,
    });
    expect(mockTailscale.listDevices).not.toHaveBeenCalled();
  });

  it("resolves the ingress URL from the matched device's MagicDNS name when online", async () => {
    mockPrisma.stack.findFirst.mockResolvedValue(null);
    mockTailscale.getClientId.mockResolvedValue("client-id");
    mockTailscale.getTailnetDomain.mockResolvedValue("tail-abc.ts.net");
    mockTailscale.listDevices.mockResolvedValue([
      device({ hostname: "mini-infra", name: "mini-infra.tail-abc.ts.net", online: true }),
    ]);

    const res = await request(app).get("/api/connectivity/tailscale/ingress");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      hostname: "mini-infra",
      tailnetDomain: "tail-abc.ts.net",
      ingressUrl: "https://mini-infra.tail-abc.ts.net",
      deviceOnline: true,
      deviceName: "mini-infra.tail-abc.ts.net",
    });
  });

  it("falls back to host.tailnet URL and offline when no device is registered yet", async () => {
    mockPrisma.stack.findFirst.mockResolvedValue(null);
    mockTailscale.getClientId.mockResolvedValue("client-id");
    mockTailscale.getTailnetDomain.mockResolvedValue("tail-abc.ts.net");
    mockTailscale.listDevices.mockResolvedValue([]);

    const res = await request(app).get("/api/connectivity/tailscale/ingress");

    expect(res.body).toMatchObject({
      configured: true,
      ingressUrl: "https://mini-infra.tail-abc.ts.net",
      deviceOnline: false,
      deviceName: null,
    });
  });

  it("uses the hostname the stack was actually deployed with", async () => {
    mockPrisma.stack.findFirst.mockResolvedValue({ parameterValues: { hostname: "control" } });
    mockTailscale.getClientId.mockResolvedValue("client-id");
    mockTailscale.getTailnetDomain.mockResolvedValue("tail-abc.ts.net");
    mockTailscale.listDevices.mockResolvedValue([
      device({ hostname: "control", name: "control.tail-abc.ts.net", online: true }),
      device({ hostname: "mini-infra", name: "mini-infra.tail-abc.ts.net", online: true }),
    ]);

    const res = await request(app).get("/api/connectivity/tailscale/ingress");

    expect(res.body).toMatchObject({
      hostname: "control",
      ingressUrl: "https://control.tail-abc.ts.net",
      deviceOnline: true,
    });
  });

  it("reports configured-but-unresolved (not a 500) when the tailnet query fails", async () => {
    mockPrisma.stack.findFirst.mockResolvedValue(null);
    mockTailscale.getClientId.mockResolvedValue("client-id");
    mockTailscale.getTailnetDomain.mockRejectedValue(new Error("tailnet unreachable"));
    mockTailscale.listDevices.mockRejectedValue(new Error("tailnet unreachable"));

    const res = await request(app).get("/api/connectivity/tailscale/ingress");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      tailnetDomain: null,
      ingressUrl: null,
      deviceOnline: false,
    });
  });
});
