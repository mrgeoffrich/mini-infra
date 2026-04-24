import { describe, it, expect } from "vitest";
import { toRouteDTO, toSharedFrontendDTO } from "../shared-frontend-repository";
import type {
  HAProxyFrontend,
  HAProxyRoute,
} from "../../../../generated/prisma/client";

/**
 * Mapper tests. The Prisma-touching helpers (findSharedFrontend, createRouteRecord, etc.)
 * are thin wrappers — covered by the route-operations integration-style tests that
 * stub the Prisma surface directly.
 */

describe("toSharedFrontendDTO", () => {
  it("projects only the fields the DTO exposes", () => {
    const record = {
      id: "fe_1",
      frontendType: "shared",
      containerName: null,
      containerId: null,
      containerPort: null,
      environmentId: "env_1",
      frontendName: "http_frontend_env_1",
      backendName: "",
      hostname: "",
      bindPort: 80,
      bindAddress: "*",
      useSSL: false,
      tlsCertificateId: null,
      sslBindPort: 443,
      isSharedFrontend: true,
      sharedFrontendId: null,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as HAProxyFrontend;

    const dto = toSharedFrontendDTO(record);

    expect(dto).toEqual({
      id: "fe_1",
      frontendName: "http_frontend_env_1",
      environmentId: "env_1",
      isSharedFrontend: true,
      bindPort: 80,
      bindAddress: "*",
      useSSL: false,
      tlsCertificateId: null,
    });
  });

  it("passes through tlsCertificateId and useSSL when SSL is configured", () => {
    const record = {
      id: "fe_2",
      frontendName: "https_frontend_env_1",
      environmentId: "env_1",
      isSharedFrontend: true,
      bindPort: 443,
      bindAddress: "*",
      useSSL: true,
      tlsCertificateId: "cert_123",
    } as unknown as HAProxyFrontend;

    const dto = toSharedFrontendDTO(record);

    expect(dto.useSSL).toBe(true);
    expect(dto.tlsCertificateId).toBe("cert_123");
  });
});

describe("toRouteDTO", () => {
  it("projects the route's public fields and drops internals like createdAt", () => {
    const record = {
      id: "route_1",
      sharedFrontendId: "fe_1",
      hostname: "api.example.com",
      aclName: "acl_api_example_com",
      backendName: "be_api",
      priority: 0,
      sourceType: "manual",
      manualFrontendId: null,
      useSSL: false,
      tlsCertificateId: null,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as HAProxyRoute;

    const dto = toRouteDTO(record);

    expect(dto).toEqual({
      id: "route_1",
      hostname: "api.example.com",
      aclName: "acl_api_example_com",
      backendName: "be_api",
      sourceType: "manual",
      useSSL: false,
    });
    expect(dto).not.toHaveProperty("createdAt");
    expect(dto).not.toHaveProperty("priority");
  });

  it("preserves the sourceType verbatim for stack-sourced routes", () => {
    const record = {
      id: "route_2",
      hostname: "app.example.com",
      aclName: "acl_app_example_com",
      backendName: "be_app",
      sourceType: "stack",
      useSSL: true,
    } as unknown as HAProxyRoute;

    expect(toRouteDTO(record).sourceType).toBe("stack");
  });
});
