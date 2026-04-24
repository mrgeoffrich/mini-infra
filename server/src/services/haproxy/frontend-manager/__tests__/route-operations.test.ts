import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the certificate deployer module BEFORE importing route-operations,
// since the SSL deployer transitively imports it.
vi.mock("../../haproxy-certificate-deployer", () => ({
  haproxyCertificateDeployer: {
    fetchAndDeployCertificate: vi.fn().mockResolvedValue("cert.pem"),
    removeCertificateIfUnused: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  addRouteToSharedFrontend,
  removeRouteFromSharedFrontend,
  updateFrontendBackend,
  updateRoute,
} from "../route-operations";
import { haproxyCertificateDeployer } from "../../haproxy-certificate-deployer";
import type { HAProxyDataPlaneClient } from "../../haproxy-dataplane-client";
import type { PrismaClient } from "../../../../generated/prisma/client";

type ClientMock = {
  addACL: ReturnType<typeof vi.fn>;
  addBackendSwitchingRule: ReturnType<typeof vi.fn>;
  getACLs: ReturnType<typeof vi.fn>;
  getBackendSwitchingRules: ReturnType<typeof vi.fn>;
  deleteACL: ReturnType<typeof vi.fn>;
  deleteBackendSwitchingRule: ReturnType<typeof vi.fn>;
  updateBackendSwitchingRule: ReturnType<typeof vi.fn>;
  addFrontendBind: ReturnType<typeof vi.fn>;
};

function buildClient(): ClientMock {
  return {
    addACL: vi.fn().mockResolvedValue(undefined),
    addBackendSwitchingRule: vi.fn().mockResolvedValue(undefined),
    getACLs: vi.fn().mockResolvedValue([]),
    getBackendSwitchingRules: vi.fn().mockResolvedValue([]),
    deleteACL: vi.fn().mockResolvedValue(undefined),
    deleteBackendSwitchingRule: vi.fn().mockResolvedValue(undefined),
    updateBackendSwitchingRule: vi.fn().mockResolvedValue(undefined),
    addFrontendBind: vi.fn().mockResolvedValue(undefined),
  };
}

type PrismaMock = {
  hAProxyFrontend: {
    findUnique: ReturnType<typeof vi.fn>;
  };
  hAProxyRoute: {
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

function buildPrisma(): PrismaMock {
  return {
    hAProxyFrontend: {
      findUnique: vi.fn(),
    },
    hAProxyRoute: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
}

const asClient = (c: ClientMock) => c as unknown as HAProxyDataPlaneClient;
const asPrisma = (p: PrismaMock) => p as unknown as PrismaClient;

describe("route-operations", () => {
  let client: ClientMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    client = buildClient();
    prisma = buildPrisma();
    vi.mocked(haproxyCertificateDeployer.fetchAndDeployCertificate).mockClear();
  });

  describe("updateFrontendBackend", () => {
    it("updates the switching rule in place when a matching rule exists", async () => {
      client.getBackendSwitchingRules.mockResolvedValue([
        { cond_test: "acl_other", name: "be_other", cond: "if" },
        { cond_test: "acl_api_example_com", name: "be_old", cond: "if" },
      ]);

      await updateFrontendBackend(
        "fe_app",
        "api.example.com",
        "be_new",
        asClient(client)
      );

      expect(client.updateBackendSwitchingRule).toHaveBeenCalledWith("fe_app", 1, {
        name: "be_new",
        cond: "if",
        cond_test: "acl_api_example_com",
      });
    });

    it("falls back to addHostnameRouting when no matching rule exists", async () => {
      client.getBackendSwitchingRules.mockResolvedValue([
        { cond_test: "acl_other", name: "be_other", cond: "if" },
      ]);

      await updateFrontendBackend(
        "fe_app",
        "api.example.com",
        "be_new",
        asClient(client)
      );

      expect(client.updateBackendSwitchingRule).not.toHaveBeenCalled();
      expect(client.addACL).toHaveBeenCalled();
      expect(client.addBackendSwitchingRule).toHaveBeenCalled();
    });
  });

  describe("addRouteToSharedFrontend", () => {
    const sharedFrontend = {
      id: "fe_1",
      frontendName: "http_frontend_env_1",
      isSharedFrontend: true,
    };

    beforeEach(() => {
      prisma.hAProxyFrontend.findUnique.mockResolvedValue(sharedFrontend);
      prisma.hAProxyRoute.findFirst.mockResolvedValue(null);
      prisma.hAProxyRoute.create.mockResolvedValue({
        id: "route_1",
        hostname: "api.example.com",
        aclName: "acl_api_example_com",
        backendName: "be_api",
        sourceType: "manual",
        useSSL: false,
      });
    });

    it("throws when the shared frontend is missing", async () => {
      prisma.hAProxyFrontend.findUnique.mockResolvedValue(null);

      await expect(
        addRouteToSharedFrontend(
          "missing",
          "api.example.com",
          "be_api",
          "manual",
          "src_1",
          asClient(client),
          asPrisma(prisma)
        )
      ).rejects.toThrow(/Shared frontend not found/);
    });

    it("throws when the frontend record is not a shared frontend", async () => {
      prisma.hAProxyFrontend.findUnique.mockResolvedValue({
        ...sharedFrontend,
        isSharedFrontend: false,
      });

      await expect(
        addRouteToSharedFrontend(
          "fe_1",
          "api.example.com",
          "be_api",
          "manual",
          "src_1",
          asClient(client),
          asPrisma(prisma)
        )
      ).rejects.toThrow(/is not a shared frontend/);
    });

    it("returns the existing DTO without re-creating HAProxy state when the hostname is already routed", async () => {
      prisma.hAProxyRoute.findFirst.mockResolvedValue({
        id: "existing_route",
        hostname: "api.example.com",
        aclName: "acl_api_example_com",
        backendName: "be_api",
        sourceType: "manual",
        useSSL: false,
      });

      const result = await addRouteToSharedFrontend(
        "fe_1",
        "api.example.com",
        "be_api",
        "manual",
        "src_1",
        asClient(client),
        asPrisma(prisma)
      );

      expect(result.id).toBe("existing_route");
      expect(client.addACL).not.toHaveBeenCalled();
      expect(client.addBackendSwitchingRule).not.toHaveBeenCalled();
      expect(prisma.hAProxyRoute.create).not.toHaveBeenCalled();
    });

    it("adds hostname routing and persists a new route row on the happy path", async () => {
      const result = await addRouteToSharedFrontend(
        "fe_1",
        "api.example.com",
        "be_api",
        "manual",
        "src_1",
        asClient(client),
        asPrisma(prisma)
      );

      expect(client.addACL).toHaveBeenCalled();
      expect(client.addBackendSwitchingRule).toHaveBeenCalled();
      expect(prisma.hAProxyRoute.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sharedFrontendId: "fe_1",
          hostname: "api.example.com",
          aclName: "acl_api_example_com",
          backendName: "be_api",
          sourceType: "manual",
          manualFrontendId: "src_1",
          useSSL: false,
          tlsCertificateId: null,
          status: "active",
        }),
      });
      expect(result.id).toBe("route_1");
    });

    it("uploads the certificate for SNI when SSL options are provided", async () => {
      await addRouteToSharedFrontend(
        "fe_1",
        "api.example.com",
        "be_api",
        "manual",
        "src_1",
        asClient(client),
        asPrisma(prisma),
        { useSSL: true, tlsCertificateId: "cert_123" }
      );

      expect(
        haproxyCertificateDeployer.fetchAndDeployCertificate
      ).toHaveBeenCalledWith(
        "cert_123",
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ gracefulNotFound: true })
      );
    });

    it("leaves manualFrontendId null for stack-sourced routes", async () => {
      await addRouteToSharedFrontend(
        "fe_1",
        "api.example.com",
        "be_api",
        "stack",
        "src_1",
        asClient(client),
        asPrisma(prisma)
      );

      expect(prisma.hAProxyRoute.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sourceType: "stack",
          manualFrontendId: null,
        }),
      });
    });
  });

  describe("removeRouteFromSharedFrontend", () => {
    it("throws when the shared frontend is not found", async () => {
      prisma.hAProxyFrontend.findUnique.mockResolvedValue(null);

      await expect(
        removeRouteFromSharedFrontend(
          "missing",
          "api.example.com",
          asClient(client),
          asPrisma(prisma)
        )
      ).rejects.toThrow(/Shared frontend not found/);
    });

    it("removes ACL + switching rule from HAProxy and deletes the route row", async () => {
      prisma.hAProxyFrontend.findUnique.mockResolvedValue({
        id: "fe_1",
        frontendName: "http_frontend_env_1",
      });
      prisma.hAProxyRoute.findFirst.mockResolvedValue({ id: "route_1" });
      client.getACLs.mockResolvedValue([{ acl_name: "acl_api_example_com" }]);
      client.getBackendSwitchingRules.mockResolvedValue([
        { cond_test: "acl_api_example_com" },
      ]);

      await removeRouteFromSharedFrontend(
        "fe_1",
        "api.example.com",
        asClient(client),
        asPrisma(prisma)
      );

      expect(client.deleteBackendSwitchingRule).toHaveBeenCalledWith(
        "http_frontend_env_1",
        0
      );
      expect(client.deleteACL).toHaveBeenCalledWith("http_frontend_env_1", 0);
      expect(prisma.hAProxyRoute.delete).toHaveBeenCalledWith({
        where: { id: "route_1" },
      });
    });

    it("continues when the DB route is missing but HAProxy state is still present", async () => {
      prisma.hAProxyFrontend.findUnique.mockResolvedValue({
        id: "fe_1",
        frontendName: "http_frontend_env_1",
      });
      prisma.hAProxyRoute.findFirst.mockResolvedValue(null);
      client.getACLs.mockResolvedValue([{ acl_name: "acl_api_example_com" }]);
      client.getBackendSwitchingRules.mockResolvedValue([
        { cond_test: "acl_api_example_com" },
      ]);

      await removeRouteFromSharedFrontend(
        "fe_1",
        "api.example.com",
        asClient(client),
        asPrisma(prisma)
      );

      expect(client.deleteACL).toHaveBeenCalled();
      expect(prisma.hAProxyRoute.delete).not.toHaveBeenCalled();
    });
  });

  describe("updateRoute", () => {
    const existingRoute = {
      id: "route_1",
      hostname: "api.example.com",
      aclName: "acl_api_example_com",
      backendName: "be_api",
      useSSL: false,
      tlsCertificateId: null,
      priority: 0,
      status: "active",
      sharedFrontend: { frontendName: "http_frontend_env_1" },
    };

    beforeEach(() => {
      prisma.hAProxyRoute.findUnique.mockResolvedValue(existingRoute);
      prisma.hAProxyRoute.update.mockImplementation(({ data }) =>
        Promise.resolve({
          ...existingRoute,
          ...data,
        })
      );
    });

    it("throws when the route is not found", async () => {
      prisma.hAProxyRoute.findUnique.mockResolvedValue(null);

      await expect(
        updateRoute("missing", { hostname: "x" }, asClient(client), asPrisma(prisma))
      ).rejects.toThrow(/Route not found/);
    });

    it("recreates ACL + rule under the new name when hostname changes", async () => {
      client.getACLs.mockResolvedValue([{ acl_name: "acl_api_example_com" }]);
      client.getBackendSwitchingRules.mockResolvedValue([
        { cond_test: "acl_api_example_com" },
      ]);

      await updateRoute(
        "route_1",
        { hostname: "v2.example.com" },
        asClient(client),
        asPrisma(prisma)
      );

      expect(client.deleteBackendSwitchingRule).toHaveBeenCalled();
      expect(client.deleteACL).toHaveBeenCalled();
      expect(client.addACL).toHaveBeenCalledWith(
        "http_frontend_env_1",
        "acl_v2_example_com",
        "hdr(host)",
        "-i v2.example.com"
      );
      expect(prisma.hAProxyRoute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "route_1" },
          data: expect.objectContaining({
            hostname: "v2.example.com",
            aclName: "acl_v2_example_com",
          }),
        })
      );
    });

    it("updates only the switching rule in place when only the backend changes", async () => {
      client.getBackendSwitchingRules.mockResolvedValue([
        { cond_test: "acl_api_example_com" },
      ]);

      await updateRoute(
        "route_1",
        { backendName: "be_new" },
        asClient(client),
        asPrisma(prisma)
      );

      expect(client.updateBackendSwitchingRule).toHaveBeenCalledWith(
        "http_frontend_env_1",
        0,
        { name: "be_new", cond: "if", cond_test: "acl_api_example_com" }
      );
      expect(client.deleteACL).not.toHaveBeenCalled();
    });

    it("only touches the DB when nothing routing-related changes (metadata-only update)", async () => {
      await updateRoute(
        "route_1",
        { status: "disabled", priority: 5 },
        asClient(client),
        asPrisma(prisma)
      );

      expect(client.updateBackendSwitchingRule).not.toHaveBeenCalled();
      expect(client.deleteACL).not.toHaveBeenCalled();
      expect(prisma.hAProxyRoute.update).toHaveBeenCalled();
    });

    it("allows clearing the tls certificate id by passing null", async () => {
      prisma.hAProxyRoute.findUnique.mockResolvedValue({
        ...existingRoute,
        tlsCertificateId: "cert_123",
      });

      await updateRoute(
        "route_1",
        { tlsCertificateId: null },
        asClient(client),
        asPrisma(prisma)
      );

      expect(prisma.hAProxyRoute.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tlsCertificateId: null }),
        })
      );
    });
  });
});
