import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StackContainerConfig } from "@mini-infra/types";

// Mock the heavy collaborator so the unit test isolates the injector. The
// real CloudflareService pulls in prisma + the Cloudflare API clients; we only
// care that the injector reads the token via getManagedTunnelToken and maps it.
// `new CloudflareService()` must be constructible, so the mock is a class.
const { getManagedTunnelToken } = vi.hoisted(() => ({
  getManagedTunnelToken: vi.fn(),
}));
vi.mock("../cloudflare-service", () => ({
  CloudflareService: class {
    getManagedTunnelToken = getManagedTunnelToken;
  },
}));

import { CloudflareTunnelTokenInjector } from "../cloudflare-tunnel-token-injector";

const prisma =
  {} as ConstructorParameters<typeof CloudflareTunnelTokenInjector>[0];

const cfg = (dynamicEnv?: Record<string, unknown>): StackContainerConfig =>
  ({ dynamicEnv } as unknown as StackContainerConfig);

describe("CloudflareTunnelTokenInjector", () => {
  beforeEach(() => {
    getManagedTunnelToken.mockReset();
  });

  it("returns null when the service declares no dynamicEnv", async () => {
    const injector = new CloudflareTunnelTokenInjector(prisma);
    expect(await injector.resolve("env-1", cfg(undefined))).toBeNull();
    expect(getManagedTunnelToken).not.toHaveBeenCalled();
  });

  it("returns null when no cloudflare-tunnel-token entry is present", async () => {
    const injector = new CloudflareTunnelTokenInjector(prisma);
    const res = await injector.resolve(
      "env-1",
      cfg({ OTHER: { kind: "nats-url" } }),
    );
    expect(res).toBeNull();
    expect(getManagedTunnelToken).not.toHaveBeenCalled();
  });

  it("maps the resolved token onto every declared env key", async () => {
    getManagedTunnelToken.mockResolvedValue("tok-abc");
    const injector = new CloudflareTunnelTokenInjector(prisma);
    const res = await injector.resolve(
      "env-1",
      cfg({
        TUNNEL_TOKEN: { kind: "cloudflare-tunnel-token" },
        ALT: { kind: "cloudflare-tunnel-token" },
      }),
    );
    expect(res).toEqual({ TUNNEL_TOKEN: "tok-abc", ALT: "tok-abc" });
    expect(getManagedTunnelToken).toHaveBeenCalledWith("env-1");
  });

  it("throws (fail-closed) when the stack has no environment", async () => {
    const injector = new CloudflareTunnelTokenInjector(prisma);
    await expect(
      injector.resolve(
        null,
        cfg({ TUNNEL_TOKEN: { kind: "cloudflare-tunnel-token" } }),
      ),
    ).rejects.toThrow(/environment-scoped/);
    expect(getManagedTunnelToken).not.toHaveBeenCalled();
  });

  it("throws (fail-closed) when no managed tunnel token exists for the environment", async () => {
    getManagedTunnelToken.mockResolvedValue(null);
    const injector = new CloudflareTunnelTokenInjector(prisma);
    await expect(
      injector.resolve(
        "env-1",
        cfg({ TUNNEL_TOKEN: { kind: "cloudflare-tunnel-token" } }),
      ),
    ).rejects.toThrow(/create the managed tunnel/);
  });
});
