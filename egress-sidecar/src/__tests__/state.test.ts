import { describe, it, expect, beforeEach } from "vitest";
import {
  getState,
  applyRules,
  applyContainerMap,
} from "../state";
import type { StackPolicy, ContainerMapEntry } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicy(
  mode: "detect" | "enforce" = "enforce",
  defaultAction: "allow" | "block" = "block",
): StackPolicy {
  return { mode, defaultAction, rules: [] };
}

// ---------------------------------------------------------------------------
// Rules snapshot replace
// ---------------------------------------------------------------------------

describe("applyRules", () => {
  it("atomically replaces all stack policies", () => {
    applyRules({
      version: 1,
      stackPolicies: {
        "stack-a": makePolicy("enforce", "block"),
        "stack-b": makePolicy("detect", "allow"),
      },
    });

    const state = getState();
    expect(state.rulesVersion).toBe(1);
    expect(state.stackPolicies.size).toBe(2);
    expect(state.stackPolicies.has("stack-a")).toBe(true);
    expect(state.stackPolicies.has("stack-b")).toBe(true);
  });

  it("replaces ALL policies on second call — old keys removed", () => {
    applyRules({
      version: 1,
      stackPolicies: { "stack-a": makePolicy() },
    });
    applyRules({
      version: 2,
      stackPolicies: { "stack-z": makePolicy("detect", "allow") },
    });

    const state = getState();
    expect(state.rulesVersion).toBe(2);
    expect(state.stackPolicies.has("stack-a")).toBe(false);
    expect(state.stackPolicies.has("stack-z")).toBe(true);
  });

  it("stores the version from the push payload", () => {
    applyRules({ version: 42, stackPolicies: {} });
    expect(getState().rulesVersion).toBe(42);
  });

  it("stores optional defaultUpstreamOverride", () => {
    applyRules({
      version: 1,
      stackPolicies: {},
      defaultUpstream: ["9.9.9.9", "149.112.112.112"],
    });
    expect(getState().defaultUpstreamOverride).toEqual([
      "9.9.9.9",
      "149.112.112.112",
    ]);
  });

  it("clears defaultUpstreamOverride when not provided", () => {
    applyRules({
      version: 1,
      stackPolicies: {},
      defaultUpstream: ["9.9.9.9"],
    });
    applyRules({ version: 2, stackPolicies: {} });
    expect(getState().defaultUpstreamOverride).toBeNull();
  });

  it("compiles a RuleTrie for each policy (trie is present)", () => {
    applyRules({
      version: 1,
      stackPolicies: {
        "stack-x": {
          mode: "enforce",
          defaultAction: "block",
          rules: [
            { id: "r1", pattern: "api.openai.com", action: "allow", targets: [] },
          ],
        },
      },
    });

    const compiled = getState().stackPolicies.get("stack-x");
    expect(compiled).toBeDefined();
    // The trie should match the rule we put in.
    const result = compiled!.trie.match("api.openai.com", null);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("r1");
  });

  it("accepts version numbers in any order (server is authoritative)", () => {
    applyRules({ version: 100, stackPolicies: {} });
    applyRules({ version: 5, stackPolicies: {} });
    // Should just accept — no version ordering enforcement in sidecar.
    expect(getState().rulesVersion).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Container map snapshot replace
// ---------------------------------------------------------------------------

describe("applyContainerMap", () => {
  it("atomically replaces the container map", () => {
    const entries: ContainerMapEntry[] = [
      { ip: "172.30.0.10", stackId: "stack-a", serviceName: "web" },
      { ip: "172.30.0.11", stackId: "stack-a", serviceName: "worker" },
    ];
    applyContainerMap({ version: 1, entries });

    const state = getState();
    expect(state.containerMapVersion).toBe(1);
    expect(state.containerMap.size).toBe(2);
    expect(state.containerMap.get("172.30.0.10")).toEqual({
      stackId: "stack-a",
      serviceName: "web",
      containerId: undefined,
    });
  });

  it("replaces ALL entries on second call — old IPs removed", () => {
    applyContainerMap({
      version: 1,
      entries: [
        { ip: "10.0.0.1", stackId: "s1", serviceName: "web" },
      ],
    });
    applyContainerMap({
      version: 2,
      entries: [
        { ip: "10.0.0.2", stackId: "s2", serviceName: "api" },
      ],
    });

    const state = getState();
    expect(state.containerMap.has("10.0.0.1")).toBe(false);
    expect(state.containerMap.has("10.0.0.2")).toBe(true);
    expect(state.containerMapVersion).toBe(2);
  });

  it("stores optional containerId", () => {
    applyContainerMap({
      version: 1,
      entries: [
        {
          ip: "192.168.1.5",
          stackId: "s1",
          serviceName: "web",
          containerId: "abc123",
        },
      ],
    });

    const entry = getState().containerMap.get("192.168.1.5");
    expect(entry?.containerId).toBe("abc123");
  });

  it("handles empty entries array", () => {
    applyContainerMap({ version: 99, entries: [] });

    const state = getState();
    expect(state.containerMapVersion).toBe(99);
    expect(state.containerMap.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent read during update (atomic swap)
// ---------------------------------------------------------------------------

describe("atomic state swap", () => {
  it("getState() always returns a consistent snapshot", () => {
    // Grab reference before update.
    const before = getState();

    applyRules({
      version: 999,
      stackPolicies: { "new-stack": makePolicy() },
    });

    // The old reference is unchanged.
    expect(before.rulesVersion).not.toBe(999);
    // The new state reflects the update.
    expect(getState().rulesVersion).toBe(999);
  });
});
