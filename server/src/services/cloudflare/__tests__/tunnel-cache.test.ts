import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tunnelCache } from "../tunnel-cache";
import {
  CloudflareTunnelInfo,
  CloudflareTunnelConfig,
} from "@mini-infra/types";

const sampleTunnel: CloudflareTunnelInfo = {
  id: "t-1",
  name: "web",
  status: "healthy",
  createdAt: "2026-04-14T00:00:00Z",
  connections: [],
};

const sampleConfig: CloudflareTunnelConfig = {
  version: 1,
  config: { ingress: [{ service: "http_status:404" }] },
};

describe("tunnelCache", () => {
  beforeEach(() => {
    tunnelCache.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for a missing key", () => {
    expect(tunnelCache.getList()).toBeNull();
    expect(tunnelCache.getTunnel("none")).toBeNull();
    expect(tunnelCache.getConfig("none")).toBeNull();
  });

  it("roundtrips list / tunnel / config entries independently", () => {
    tunnelCache.setList([sampleTunnel]);
    tunnelCache.setTunnel("t-1", sampleTunnel);
    tunnelCache.setConfig("t-1", sampleConfig);

    expect(tunnelCache.getList()).toEqual([sampleTunnel]);
    expect(tunnelCache.getTunnel("t-1")).toEqual(sampleTunnel);
    expect(tunnelCache.getConfig("t-1")).toEqual(sampleConfig);
  });

  it("evicts an entry once the TTL has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T00:00:00Z"));

    tunnelCache.setTunnel("t-1", sampleTunnel);
    expect(tunnelCache.getTunnel("t-1")).toEqual(sampleTunnel);

    // TTL is 60s — advance just past it.
    vi.advanceTimersByTime(61_000);
    expect(tunnelCache.getTunnel("t-1")).toBeNull();
  });

  it("clear empties every cached category", () => {
    tunnelCache.setList([sampleTunnel]);
    tunnelCache.setTunnel("t-1", sampleTunnel);
    tunnelCache.setConfig("t-1", sampleConfig);

    tunnelCache.clear();

    expect(tunnelCache.getList()).toBeNull();
    expect(tunnelCache.getTunnel("t-1")).toBeNull();
    expect(tunnelCache.getConfig("t-1")).toBeNull();
  });
});
