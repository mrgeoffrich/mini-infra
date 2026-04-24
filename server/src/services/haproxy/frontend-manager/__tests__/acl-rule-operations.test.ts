import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addACL,
  addBackendSwitchingRule,
  addHostnameRouting,
  removeACLByName,
  removeBackendSwitchingRuleByAclName,
} from "../acl-rule-operations";
import type { HAProxyDataPlaneClient } from "../../haproxy-dataplane-client";

type MockClient = {
  addACL: ReturnType<typeof vi.fn>;
  addBackendSwitchingRule: ReturnType<typeof vi.fn>;
  getACLs: ReturnType<typeof vi.fn>;
  getBackendSwitchingRules: ReturnType<typeof vi.fn>;
  deleteACL: ReturnType<typeof vi.fn>;
  deleteBackendSwitchingRule: ReturnType<typeof vi.fn>;
};

function buildClient(): MockClient {
  return {
    addACL: vi.fn().mockResolvedValue(undefined),
    addBackendSwitchingRule: vi.fn().mockResolvedValue(undefined),
    getACLs: vi.fn().mockResolvedValue([]),
    getBackendSwitchingRules: vi.fn().mockResolvedValue([]),
    deleteACL: vi.fn().mockResolvedValue(undefined),
    deleteBackendSwitchingRule: vi.fn().mockResolvedValue(undefined),
  };
}

const asClient = (c: MockClient) => c as unknown as HAProxyDataPlaneClient;

describe("acl-rule-operations", () => {
  let client: MockClient;

  beforeEach(() => {
    client = buildClient();
  });

  describe("addACL", () => {
    it("splits the criterion into fetch method and value before calling the client", async () => {
      await addACL("fe_app", "acl_host", "hdr(host) -i example.com", asClient(client));

      expect(client.addACL).toHaveBeenCalledWith(
        "fe_app",
        "acl_host",
        "hdr(host)",
        "-i example.com"
      );
    });

    it("throws when the criterion has no space separator", async () => {
      await expect(
        addACL("fe_app", "acl_host", "no-space", asClient(client))
      ).rejects.toThrow("Invalid ACL criterion format");
      expect(client.addACL).not.toHaveBeenCalled();
    });

    it("swallows 409 responses as already-exists", async () => {
      client.addACL.mockRejectedValue({ response: { status: 409 } });

      await expect(
        addACL("fe_app", "acl_host", "hdr(host) -i x.com", asClient(client))
      ).resolves.toBeUndefined();
    });

    it("swallows errors whose message contains 'already exists'", async () => {
      client.addACL.mockRejectedValue(new Error("ACL already exists"));

      await expect(
        addACL("fe_app", "acl_host", "hdr(host) -i x.com", asClient(client))
      ).resolves.toBeUndefined();
    });

    it("rethrows other errors wrapped with cause", async () => {
      const boom = new Error("boom");
      client.addACL.mockRejectedValue(boom);

      await expect(
        addACL("fe_app", "acl_host", "hdr(host) -i x.com", asClient(client))
      ).rejects.toMatchObject({
        message: expect.stringContaining("Failed to add ACL"),
        cause: boom,
      });
    });
  });

  describe("addBackendSwitchingRule", () => {
    it("sends the rule with the 'if' condition", async () => {
      await addBackendSwitchingRule("fe_app", "acl_host", "be_api", asClient(client));

      expect(client.addBackendSwitchingRule).toHaveBeenCalledWith(
        "fe_app",
        "be_api",
        "acl_host",
        "if"
      );
    });

    it("swallows 409 already-exists errors", async () => {
      client.addBackendSwitchingRule.mockRejectedValue({ response: { status: 409 } });

      await expect(
        addBackendSwitchingRule("fe_app", "acl_host", "be_api", asClient(client))
      ).resolves.toBeUndefined();
    });

    it("rethrows other errors wrapped with cause", async () => {
      const boom = new Error("network down");
      client.addBackendSwitchingRule.mockRejectedValue(boom);

      await expect(
        addBackendSwitchingRule("fe_app", "acl_host", "be_api", asClient(client))
      ).rejects.toMatchObject({
        message: expect.stringContaining("Failed to add backend switching rule"),
        cause: boom,
      });
    });
  });

  describe("addHostnameRouting", () => {
    it("adds an ACL keyed off the hostname and then a switching rule", async () => {
      await addHostnameRouting("fe_app", "api.example.com", "be_api", asClient(client));

      expect(client.addACL).toHaveBeenCalledWith(
        "fe_app",
        "acl_api_example_com",
        "hdr(host)",
        "-i api.example.com"
      );
      expect(client.addBackendSwitchingRule).toHaveBeenCalledWith(
        "fe_app",
        "be_api",
        "acl_api_example_com",
        "if"
      );
    });

    it("orders ACL creation before the switching rule", async () => {
      const calls: string[] = [];
      client.addACL.mockImplementation(async () => {
        calls.push("acl");
      });
      client.addBackendSwitchingRule.mockImplementation(async () => {
        calls.push("rule");
      });

      await addHostnameRouting("fe_app", "api.example.com", "be_api", asClient(client));

      expect(calls).toEqual(["acl", "rule"]);
    });
  });

  describe("removeACLByName", () => {
    it("fetches the ACL list when no prefetched list is provided", async () => {
      client.getACLs.mockResolvedValue([
        { acl_name: "acl_other" },
        { acl_name: "acl_target" },
      ]);

      const removed = await removeACLByName("fe_app", "acl_target", asClient(client));

      expect(client.getACLs).toHaveBeenCalledWith("fe_app");
      expect(client.deleteACL).toHaveBeenCalledWith("fe_app", 1);
      expect(removed).toBe(true);
    });

    it("skips the fetch when a prefetched list is provided", async () => {
      const prefetched = [{ acl_name: "acl_target" }];

      await removeACLByName("fe_app", "acl_target", asClient(client), prefetched);

      expect(client.getACLs).not.toHaveBeenCalled();
      expect(client.deleteACL).toHaveBeenCalledWith("fe_app", 0);
    });

    it("returns false and does not delete when the ACL is not present", async () => {
      client.getACLs.mockResolvedValue([{ acl_name: "acl_other" }]);

      const removed = await removeACLByName("fe_app", "acl_missing", asClient(client));

      expect(removed).toBe(false);
      expect(client.deleteACL).not.toHaveBeenCalled();
    });
  });

  describe("removeBackendSwitchingRuleByAclName", () => {
    it("fetches the rule list when no prefetched list is provided", async () => {
      client.getBackendSwitchingRules.mockResolvedValue([
        { cond_test: "acl_a" },
        { cond_test: "acl_target" },
      ]);

      const removed = await removeBackendSwitchingRuleByAclName(
        "fe_app",
        "acl_target",
        asClient(client)
      );

      expect(client.getBackendSwitchingRules).toHaveBeenCalledWith("fe_app");
      expect(client.deleteBackendSwitchingRule).toHaveBeenCalledWith("fe_app", 1);
      expect(removed).toBe(true);
    });

    it("skips the fetch when a prefetched list is provided", async () => {
      const prefetched = [{ cond_test: "acl_target" }];

      await removeBackendSwitchingRuleByAclName(
        "fe_app",
        "acl_target",
        asClient(client),
        prefetched
      );

      expect(client.getBackendSwitchingRules).not.toHaveBeenCalled();
      expect(client.deleteBackendSwitchingRule).toHaveBeenCalledWith("fe_app", 0);
    });

    it("returns false when no matching rule is found", async () => {
      client.getBackendSwitchingRules.mockResolvedValue([{ cond_test: "acl_other" }]);

      const removed = await removeBackendSwitchingRuleByAclName(
        "fe_app",
        "acl_missing",
        asClient(client)
      );

      expect(removed).toBe(false);
      expect(client.deleteBackendSwitchingRule).not.toHaveBeenCalled();
    });
  });
});
