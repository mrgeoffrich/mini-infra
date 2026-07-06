/**
 * Unit tests for the /healthz scrape parsing (Phase 3). Pins the JSON contract
 * with the Go `natsbus.HealthReport` producer and the null-on-any-failure
 * guarantee the callers rely on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Keep the Docker/self-update deps inert — these tests only exercise the pure
// fetch-and-parse path via a stubbed global fetch.
vi.mock("../../docker", () => ({ default: { getInstance: () => ({}) } }));
vi.mock("../../self-update", () => ({ getOwnContainerId: () => null }));
vi.mock("../../../lib/logger-factory", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { scrapeAgentHealth } from "../agent-health-scraper";

const realFetch = globalThis.fetch;

function stubFetch(impl: typeof globalThis.fetch) {
  globalThis.fetch = impl as typeof globalThis.fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("scrapeAgentHealth", () => {
  it("parses a valid auth-failed report and requests /healthz", async () => {
    const seen: string[] = [];
    stubFetch(async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({ status: "auth-failed", lastHeartbeatAgeMs: 42000 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const report = await scrapeAgentHealth("http://172.17.0.1:9750");
    expect(seen).toEqual(["http://172.17.0.1:9750/healthz"]);
    expect(report).toEqual({ status: "auth-failed", lastHeartbeatAgeMs: 42000 });
  });

  it("returns null on a non-2xx response", async () => {
    stubFetch(async () => new Response("nope", { status: 503 }));
    expect(await scrapeAgentHealth("http://host:9750")).toBeNull();
  });

  it("returns null on an unknown status value", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ status: "bogus", lastHeartbeatAgeMs: 1 }), {
          status: 200,
        }),
    );
    expect(await scrapeAgentHealth("http://host:9750")).toBeNull();
  });

  it("returns null (never throws) when fetch rejects", async () => {
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(scrapeAgentHealth("http://host:9750")).resolves.toBeNull();
  });

  it("defaults a missing lastHeartbeatAgeMs to -1", async () => {
    stubFetch(
      async () => new Response(JSON.stringify({ status: "connected" }), { status: 200 }),
    );
    expect(await scrapeAgentHealth("http://host:9750")).toEqual({
      status: "connected",
      lastHeartbeatAgeMs: -1,
    });
  });
});
