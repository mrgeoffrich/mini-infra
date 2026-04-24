import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncEnvironmentRoutes } from "../environment-route-synchronizer";
import type { HAProxyDataPlaneClient } from "../../haproxy-dataplane-client";
import type { PrismaClient } from "../../../../generated/prisma/client";

vi.mock("../shared-frontend-repository", () => ({
  findSharedFrontendsWithRoutes: vi.fn(),
}));

import { findSharedFrontendsWithRoutes } from "../shared-frontend-repository";

type ClientMock = {
  getACLs: ReturnType<typeof vi.fn>;
  getBackendSwitchingRules: ReturnType<typeof vi.fn>;
  deleteACL: ReturnType<typeof vi.fn>;
  deleteBackendSwitchingRule: ReturnType<typeof vi.fn>;
  addACL: ReturnType<typeof vi.fn>;
  addBackendSwitchingRule: ReturnType<typeof vi.fn>;
};

function buildClient(): ClientMock {
  return {
    getACLs: vi.fn().mockResolvedValue([]),
    getBackendSwitchingRules: vi.fn().mockResolvedValue([]),
    deleteACL: vi.fn().mockResolvedValue(undefined),
    deleteBackendSwitchingRule: vi.fn().mockResolvedValue(undefined),
    addACL: vi.fn().mockResolvedValue(undefined),
    addBackendSwitchingRule: vi.fn().mockResolvedValue(undefined),
  };
}

const asClient = (c: ClientMock) => c as unknown as HAProxyDataPlaneClient;
const asPrisma = () => ({}) as unknown as PrismaClient;

describe("syncEnvironmentRoutes", () => {
  let client: ClientMock;

  beforeEach(() => {
    client = buildClient();
    vi.mocked(findSharedFrontendsWithRoutes).mockReset();
  });

  it("returns zero synced and no errors when no shared frontends exist", async () => {
    vi.mocked(findSharedFrontendsWithRoutes).mockResolvedValue([]);

    const result = await syncEnvironmentRoutes("env_1", asClient(client), asPrisma());

    expect(result).toEqual({ synced: 0, errors: [] });
    expect(client.getACLs).not.toHaveBeenCalled();
  });

  it("removes orphaned ACLs that are not in the expected route set", async () => {
    vi.mocked(findSharedFrontendsWithRoutes).mockResolvedValue([
      {
        frontendName: "http_frontend_env_1",
        routes: [
          { aclName: "acl_keep", hostname: "keep.example.com", backendName: "be_keep" },
        ],
      },
    ] as never);

    client.getACLs.mockResolvedValue([
      { acl_name: "acl_keep" },
      { acl_name: "acl_orphan" },
    ]);
    client.getBackendSwitchingRules.mockResolvedValue([]);

    const result = await syncEnvironmentRoutes("env_1", asClient(client), asPrisma());

    expect(client.deleteACL).toHaveBeenCalledWith("http_frontend_env_1", 1);
    expect(result.errors).toEqual([]);
  });

  it("removes orphaned backend switching rules whose cond_test is not expected", async () => {
    vi.mocked(findSharedFrontendsWithRoutes).mockResolvedValue([
      {
        frontendName: "http_frontend_env_1",
        routes: [
          { aclName: "acl_keep", hostname: "keep.example.com", backendName: "be_keep" },
        ],
      },
    ] as never);

    client.getACLs.mockResolvedValue([{ acl_name: "acl_keep" }]);
    client.getBackendSwitchingRules.mockResolvedValue([
      { cond_test: "acl_keep" },
      { cond_test: "acl_orphan_rule" },
    ]);

    await syncEnvironmentRoutes("env_1", asClient(client), asPrisma());

    expect(client.deleteBackendSwitchingRule).toHaveBeenCalledWith(
      "http_frontend_env_1",
      1
    );
  });

  it("adds routes that are in the DB but missing from HAProxy", async () => {
    vi.mocked(findSharedFrontendsWithRoutes).mockResolvedValue([
      {
        frontendName: "http_frontend_env_1",
        routes: [
          { aclName: "acl_missing", hostname: "missing.example.com", backendName: "be_missing" },
        ],
      },
    ] as never);

    client.getACLs.mockResolvedValue([]);
    client.getBackendSwitchingRules.mockResolvedValue([]);

    const result = await syncEnvironmentRoutes("env_1", asClient(client), asPrisma());

    expect(client.addACL).toHaveBeenCalledWith(
      "http_frontend_env_1",
      "acl_missing_example_com",
      "hdr(host)",
      "-i missing.example.com"
    );
    expect(client.addBackendSwitchingRule).toHaveBeenCalledWith(
      "http_frontend_env_1",
      "be_missing",
      "acl_missing_example_com",
      "if"
    );
    expect(result.synced).toBe(1);
  });

  it("does not re-add a route whose ACL and rule already exist in HAProxy", async () => {
    vi.mocked(findSharedFrontendsWithRoutes).mockResolvedValue([
      {
        frontendName: "http_frontend_env_1",
        routes: [
          { aclName: "acl_present", hostname: "present.example.com", backendName: "be_present" },
        ],
      },
    ] as never);

    client.getACLs.mockResolvedValue([{ acl_name: "acl_present" }]);
    client.getBackendSwitchingRules.mockResolvedValue([{ cond_test: "acl_present" }]);

    const result = await syncEnvironmentRoutes("env_1", asClient(client), asPrisma());

    expect(client.addACL).not.toHaveBeenCalled();
    expect(client.addBackendSwitchingRule).not.toHaveBeenCalled();
    expect(result.synced).toBe(0);
  });

  it("accumulates errors for individual route failures without throwing", async () => {
    vi.mocked(findSharedFrontendsWithRoutes).mockResolvedValue([
      {
        frontendName: "http_frontend_env_1",
        routes: [
          { aclName: "acl_ok", hostname: "ok.example.com", backendName: "be_ok" },
          { aclName: "acl_bad", hostname: "bad.example.com", backendName: "be_bad" },
        ],
      },
    ] as never);

    client.getACLs.mockResolvedValue([]);
    client.getBackendSwitchingRules.mockResolvedValue([]);
    client.addACL.mockImplementation(async (_fe, aclName) => {
      if (aclName === "acl_bad_example_com") throw new Error("nope");
    });

    const result = await syncEnvironmentRoutes("env_1", asClient(client), asPrisma());

    expect(result.synced).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("bad.example.com");
  });

  it("throws with the cause preserved when the frontend lookup fails", async () => {
    const boom = new Error("db down");
    vi.mocked(findSharedFrontendsWithRoutes).mockRejectedValue(boom);

    await expect(
      syncEnvironmentRoutes("env_1", asClient(client), asPrisma())
    ).rejects.toMatchObject({
      message: expect.stringContaining("Failed to sync environment routes"),
      cause: boom,
    });
  });

  it("reuses the prefetched ACL list when deleting orphans (no extra round trip)", async () => {
    vi.mocked(findSharedFrontendsWithRoutes).mockResolvedValue([
      {
        frontendName: "http_frontend_env_1",
        routes: [],
      },
    ] as never);

    client.getACLs.mockResolvedValue([{ acl_name: "acl_orphan" }]);
    client.getBackendSwitchingRules.mockResolvedValue([]);

    await syncEnvironmentRoutes("env_1", asClient(client), asPrisma());

    // getACLs is only called once — removeACLByName uses the prefetched list
    expect(client.getACLs).toHaveBeenCalledTimes(1);
    expect(client.deleteACL).toHaveBeenCalledWith("http_frontend_env_1", 0);
  });

  it("iterates over multiple shared frontends independently", async () => {
    vi.mocked(findSharedFrontendsWithRoutes).mockResolvedValue([
      {
        frontendName: "http_frontend_env_1",
        routes: [
          { aclName: "acl_a", hostname: "a.example.com", backendName: "be_a" },
        ],
      },
      {
        frontendName: "https_frontend_env_1",
        routes: [
          { aclName: "acl_b", hostname: "b.example.com", backendName: "be_b" },
        ],
      },
    ] as never);

    client.getACLs.mockResolvedValue([]);
    client.getBackendSwitchingRules.mockResolvedValue([]);

    const result = await syncEnvironmentRoutes("env_1", asClient(client), asPrisma());

    expect(client.getACLs).toHaveBeenCalledWith("http_frontend_env_1");
    expect(client.getACLs).toHaveBeenCalledWith("https_frontend_env_1");
    expect(result.synced).toBe(2);
  });
});
