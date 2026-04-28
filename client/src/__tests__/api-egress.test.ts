/**
 * Tests for the egress API client functions.
 * Each fetcher test verifies the happy path: correct URL construction,
 * correct credentials/headers, and correct return value parsing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listEgressPolicies,
  getEgressPolicy,
  listEgressRules,
  listEgressEvents,
  patchEgressPolicy,
  createEgressRule,
  patchEgressRule,
  deleteEgressRule,
} from "@/api/egress";
import type {
  EgressPolicyListResponse,
  EgressPolicyDetailResponse,
  EgressRuleListResponse,
  EgressEventListResponse,
} from "@/api/egress";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchOk(data: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
    statusText: "OK",
  } as Response);
}

function mockFetchError(status: number, statusText: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({ message: statusText }),
  } as Response);
}

// ---------------------------------------------------------------------------
// listEgressPolicies
// ---------------------------------------------------------------------------

describe("listEgressPolicies", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches all policies with no filters", async () => {
    const expected: EgressPolicyListResponse = {
      policies: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    };
    mockFetchOk(expected);

    const result = await listEgressPolicies();

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/egress/policies");
    expect(init.credentials).toBe("include");
    expect(result).toEqual(expected);
  });

  it("passes environmentId query param", async () => {
    mockFetchOk({ policies: [], total: 0, page: 1, limit: 50, totalPages: 0, hasNextPage: false, hasPreviousPage: false });
    await listEgressPolicies({ environmentId: "env-123" });

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("environmentId=env-123");
  });

  it("passes pagination params", async () => {
    mockFetchOk({ policies: [], total: 0, page: 2, limit: 10, totalPages: 0, hasNextPage: false, hasPreviousPage: false });
    await listEgressPolicies({ page: 2, limit: 10 });

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("page=2");
    expect(url).toContain("limit=10");
  });

  it("throws on non-OK response", async () => {
    mockFetchError(500, "Internal Server Error");
    await expect(listEgressPolicies()).rejects.toThrow(
      "Failed to fetch egress policies: Internal Server Error",
    );
  });
});

// ---------------------------------------------------------------------------
// getEgressPolicy
// ---------------------------------------------------------------------------

describe("getEgressPolicy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches a single policy by id", async () => {
    const expected: EgressPolicyDetailResponse = {
      id: "policy-1",
      stackId: "stack-1",
      stackNameSnapshot: "my-stack",
      environmentId: "env-1",
      environmentNameSnapshot: "production",
      mode: "detect",
      defaultAction: "allow",
      version: 3,
      appliedVersion: 3,
      archivedAt: null,
      archivedReason: null,
      rules: [],
    };
    mockFetchOk(expected);

    const result = await getEgressPolicy("policy-1");

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/egress/policies/policy-1");
    expect(init.credentials).toBe("include");
    expect(result).toEqual(expected);
  });

  it("throws on 404", async () => {
    mockFetchError(404, "Not Found");
    await expect(getEgressPolicy("bad-id")).rejects.toThrow(
      "Failed to fetch egress policy: Not Found",
    );
  });
});

// ---------------------------------------------------------------------------
// listEgressRules
// ---------------------------------------------------------------------------

describe("listEgressRules", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches rules for a policy", async () => {
    const expected: EgressRuleListResponse = {
      rules: [
        {
          id: "rule-1",
          policyId: "policy-1",
          pattern: "*.googleapis.com",
          action: "allow",
          source: "user",
          targets: [],
          hits: 42,
          lastHitAt: null,
        },
      ],
    };
    mockFetchOk(expected);

    const result = await listEgressRules("policy-1");

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/egress/policies/policy-1/rules");
    expect(result).toEqual(expected);
  });

  it("throws on non-OK response", async () => {
    mockFetchError(403, "Forbidden");
    await expect(listEgressRules("policy-1")).rejects.toThrow(
      "Failed to fetch egress rules: Forbidden",
    );
  });
});

// ---------------------------------------------------------------------------
// listEgressEvents
// ---------------------------------------------------------------------------

describe("listEgressEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches events with no filters", async () => {
    const expected: EgressEventListResponse = {
      events: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    };
    mockFetchOk(expected);

    const result = await listEgressEvents();

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/egress/events");
    expect(result).toEqual(expected);
  });

  it("passes all filter params", async () => {
    mockFetchOk({ events: [], total: 0, page: 1, limit: 50, totalPages: 0, hasNextPage: false, hasPreviousPage: false });
    await listEgressEvents({
      environmentId: "env-1",
      action: "blocked",
      since: "2024-01-01T00:00:00Z",
      page: 3,
      limit: 20,
    });

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("environmentId=env-1");
    expect(url).toContain("action=blocked");
    expect(url).toContain("since=2024-01-01T00%3A00%3A00Z");
    expect(url).toContain("page=3");
    expect(url).toContain("limit=20");
  });
});

// ---------------------------------------------------------------------------
// Mutation stubs
// ---------------------------------------------------------------------------

describe("patchEgressPolicy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends PATCH to the correct URL with body", async () => {
    mockFetchOk({ id: "policy-1", stackId: null, stackNameSnapshot: "", environmentId: null, environmentNameSnapshot: "", mode: "enforce", defaultAction: "allow", version: 2, appliedVersion: 1, archivedAt: null, archivedReason: null, rules: [] });
    await patchEgressPolicy("policy-1", { mode: "enforce" });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/egress/policies/policy-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ mode: "enforce" });
  });
});

describe("createEgressRule", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends POST to the correct URL with body", async () => {
    mockFetchOk({ id: "rule-1", policyId: "policy-1", pattern: "*.example.com", action: "allow", source: "user", targets: [], hits: 0, lastHitAt: null });
    await createEgressRule("policy-1", {
      pattern: "*.example.com",
      action: "allow",
    });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/egress/policies/policy-1/rules");
    expect(init.method).toBe("POST");
  });
});

describe("patchEgressRule", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends PATCH to rule endpoint", async () => {
    mockFetchOk({ id: "rule-1", policyId: "policy-1", pattern: "*.example.com", action: "block", source: "user", targets: [], hits: 0, lastHitAt: null });
    await patchEgressRule("rule-1", { action: "block" });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/egress/rules/rule-1");
    expect(init.method).toBe("PATCH");
  });
});

describe("deleteEgressRule", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends DELETE to rule endpoint", async () => {
    mockFetchOk(undefined);
    await deleteEgressRule("rule-1");

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/egress/rules/rule-1");
    expect(init.method).toBe("DELETE");
  });
});
