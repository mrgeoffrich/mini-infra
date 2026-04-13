import { describe, it, expect, vi, beforeEach } from "vitest";
import { CloudflareTunnelApi } from "../cloudflare-tunnel-api";
import { CloudflareApiRunner } from "../cloudflare-api-runner";
import { CloudflareTunnelConfig } from "@mini-infra/types";

/**
 * These tests focus on the pure ingress-rule manipulation inside
 * addHostname/removeHostname. The runner methods ({@link CloudflareApiRunner}
 * are mocked to return a well-known tunnel config so we can verify the
 * resulting ingress array is shaped correctly and the right error paths
 * fire.
 */
describe("CloudflareTunnelApi", () => {
  let tunnelApi: CloudflareTunnelApi;
  let updateTunnelConfigSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The runner isn't exercised here — every method we test goes through
    // the two internal helpers we spy on below.
    const runner = {} as CloudflareApiRunner;
    tunnelApi = new CloudflareTunnelApi(runner);
    updateTunnelConfigSpy = vi
      .spyOn(tunnelApi, "updateTunnelConfig")
      .mockImplementation(async (_tunnelId, config) => ({
        version: 2,
        config,
      }) as CloudflareTunnelConfig);
  });

  function stubCurrentConfig(
    ingress: CloudflareTunnelConfig["config"]["ingress"],
  ) {
    vi.spyOn(tunnelApi, "getTunnelConfig").mockResolvedValue({
      version: 1,
      config: { ingress },
    } as CloudflareTunnelConfig);
  }

  describe("addHostname", () => {
    it("throws when the current tunnel config cannot be fetched", async () => {
      vi.spyOn(tunnelApi, "getTunnelConfig").mockResolvedValue(null);

      await expect(
        tunnelApi.addHostname("tunnel-1", "app.example.com", "http://a:80"),
      ).rejects.toThrow("Unable to retrieve current tunnel configuration");
    });

    it("inserts a new rule before the catch-all rule", async () => {
      stubCurrentConfig([
        { hostname: "old.example.com", service: "http://b:80" },
        { service: "http_status:404" }, // catch-all
      ]);

      await tunnelApi.addHostname(
        "tunnel-1",
        "new.example.com",
        "http://c:80",
      );

      const updatedIngress = updateTunnelConfigSpy.mock.calls[0][1].ingress;
      expect(updatedIngress).toEqual([
        { hostname: "old.example.com", service: "http://b:80" },
        { hostname: "new.example.com", service: "http://c:80" },
        { service: "http_status:404" },
      ]);
    });

    it("appends to the end when no catch-all rule exists", async () => {
      stubCurrentConfig([
        { hostname: "old.example.com", service: "http://b:80" },
      ]);

      await tunnelApi.addHostname(
        "tunnel-1",
        "new.example.com",
        "http://c:80",
      );

      expect(updateTunnelConfigSpy.mock.calls[0][1].ingress).toEqual([
        { hostname: "old.example.com", service: "http://b:80" },
        { hostname: "new.example.com", service: "http://c:80" },
      ]);
    });

    it("rejects duplicates that share the same hostname + path", async () => {
      stubCurrentConfig([
        { hostname: "app.example.com", service: "http://a:80", path: "/api" },
        { service: "http_status:404" },
      ]);

      await expect(
        tunnelApi.addHostname(
          "tunnel-1",
          "app.example.com",
          "http://a:80",
          "/api",
        ),
      ).rejects.toThrow("already exists");
      expect(updateTunnelConfigSpy).not.toHaveBeenCalled();
    });

    it("allows the same hostname when the path differs", async () => {
      stubCurrentConfig([
        { hostname: "app.example.com", service: "http://a:80", path: "/api" },
        { service: "http_status:404" },
      ]);

      await tunnelApi.addHostname(
        "tunnel-1",
        "app.example.com",
        "http://a:80",
        "/admin",
      );

      const rules = updateTunnelConfigSpy.mock.calls[0][1].ingress;
      expect(rules).toHaveLength(3);
      expect(rules[1]).toEqual({
        hostname: "app.example.com",
        service: "http://a:80",
        path: "/admin",
      });
    });

    it("attaches originRequest when provided", async () => {
      stubCurrentConfig([{ service: "http_status:404" }]);

      await tunnelApi.addHostname(
        "tunnel-1",
        "app.example.com",
        "http://a:80",
        undefined,
        { httpHostHeader: "app.internal" },
      );

      expect(updateTunnelConfigSpy.mock.calls[0][1].ingress[0]).toEqual({
        hostname: "app.example.com",
        service: "http://a:80",
        originRequest: { httpHostHeader: "app.internal" },
      });
    });
  });

  describe("removeHostname", () => {
    it("throws when the hostname is not in the ingress list", async () => {
      stubCurrentConfig([
        { hostname: "other.example.com", service: "http://b:80" },
        { service: "http_status:404" },
      ]);

      await expect(
        tunnelApi.removeHostname("tunnel-1", "missing.example.com"),
      ).rejects.toThrow("not found");
      expect(updateTunnelConfigSpy).not.toHaveBeenCalled();
    });

    it("removes the rule matching hostname + no path", async () => {
      stubCurrentConfig([
        { hostname: "keep.example.com", service: "http://a:80" },
        { hostname: "drop.example.com", service: "http://b:80" },
        { service: "http_status:404" },
      ]);

      await tunnelApi.removeHostname("tunnel-1", "drop.example.com");

      expect(updateTunnelConfigSpy.mock.calls[0][1].ingress).toEqual([
        { hostname: "keep.example.com", service: "http://a:80" },
        { service: "http_status:404" },
      ]);
    });

    it("only removes the rule matching the supplied path", async () => {
      stubCurrentConfig([
        { hostname: "app.example.com", service: "http://a:80", path: "/api" },
        {
          hostname: "app.example.com",
          service: "http://a:80",
          path: "/admin",
        },
        { service: "http_status:404" },
      ]);

      await tunnelApi.removeHostname("tunnel-1", "app.example.com", "/admin");

      const remaining = updateTunnelConfigSpy.mock.calls[0][1].ingress;
      expect(remaining).toHaveLength(2);
      expect(remaining).toContainEqual({
        hostname: "app.example.com",
        service: "http://a:80",
        path: "/api",
      });
    });

    it("requires a pathless rule when path is not supplied", async () => {
      // Only a path-scoped rule is present; removing without specifying a path
      // must not match it, since that would silently drop the path variant.
      stubCurrentConfig([
        { hostname: "app.example.com", service: "http://a:80", path: "/api" },
        { service: "http_status:404" },
      ]);

      await expect(
        tunnelApi.removeHostname("tunnel-1", "app.example.com"),
      ).rejects.toThrow("not found");
    });
  });

});
