import { describe, it, expect, vi, beforeEach } from "vitest";
import { ManagedTunnelStore } from "../managed-tunnel-store";
import type { ConfigurationService } from "../../configuration-base";

/**
 * Lightweight in-memory ConfigurationService stand-in. The real class
 * talks to Prisma; these tests are purely about the keyed-storage shape
 * so we don't bring the DB in.
 */
function buildFakeConfig(): ConfigurationService {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as ConfigurationService;
}

describe("ManagedTunnelStore", () => {
  let config: ConfigurationService;
  let store: ManagedTunnelStore;

  beforeEach(() => {
    config = buildFakeConfig();
    store = new ManagedTunnelStore(config);
  });

  it("roundtrips a full record with token present", async () => {
    await store.write(
      "env-1",
      { tunnelId: "t-1", tunnelName: "prod", token: "secret" },
      "user-1",
    );

    const info = await store.read("env-1");
    expect(info).toEqual({
      tunnelId: "t-1",
      tunnelName: "prod",
      hasToken: true,
      createdAt: expect.any(String),
    });
    expect(new Date(info!.createdAt!).toString()).not.toBe("Invalid Date");
  });

  it("reports hasToken: false when no token was stored", async () => {
    await store.write(
      "env-2",
      { tunnelId: "t-2", tunnelName: "staging", token: null },
      "user-1",
    );

    const info = await store.read("env-2");
    expect(info?.hasToken).toBe(false);
  });

  it("returns null when the tunnel id key is absent", async () => {
    expect(await store.read("missing-env")).toBeNull();
  });

  it("uses the supplied createdAt when provided", async () => {
    await store.write(
      "env-3",
      {
        tunnelId: "t-3",
        tunnelName: "dev",
        token: "t",
        createdAt: "2026-04-14T00:00:00Z",
      },
      "user-1",
    );

    expect((await store.read("env-3"))?.createdAt).toBe(
      "2026-04-14T00:00:00Z",
    );
  });

  it("getTunnelId / getToken read through to the underlying keys", async () => {
    await store.write(
      "env-4",
      { tunnelId: "t-4", tunnelName: "ops", token: "tok-xyz" },
      "user-1",
    );

    expect(await store.getTunnelId("env-4")).toBe("t-4");
    expect(await store.getToken("env-4")).toBe("tok-xyz");
  });

  it("clear removes every suffix, tolerating missing keys", async () => {
    // Write only id + name so the token / created_at deletes must be
    // tolerant of missing keys.
    await config.set("managed_tunnel_id_env-5", "t-5", "user-1");
    await config.set("managed_tunnel_name_env-5", "partial", "user-1");

    await store.clear("env-5", "user-1");

    expect(await store.read("env-5")).toBeNull();
    expect(await config.get("managed_tunnel_name_env-5")).toBeNull();
  });

  it("listAll returns one entry per environment with an id suffix", async () => {
    await store.write(
      "env-A",
      { tunnelId: "ta", tunnelName: "a", token: "ta-tok" },
      "user-1",
    );
    await store.write(
      "env-B",
      { tunnelId: "tb", tunnelName: "b", token: null },
      "user-1",
    );

    // Simulate Prisma's findMany over the managed_tunnel_id_ rows.
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { key: "managed_tunnel_id_env-A" },
        { key: "managed_tunnel_id_env-B" },
      ]);

    const result = await store.listAll({ findMany }, "cloudflare");

    expect(findMany).toHaveBeenCalledWith({
      where: {
        category: "cloudflare",
        key: { startsWith: "managed_tunnel_id_" },
      },
    });
    expect([...result.keys()].sort()).toEqual(["env-A", "env-B"]);
    expect(result.get("env-A")?.hasToken).toBe(true);
    expect(result.get("env-B")?.hasToken).toBe(false);
  });
});
