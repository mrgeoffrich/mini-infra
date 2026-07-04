import { describe, it, expect } from "vitest";
import type {
  DockerNetwork,
  ManagedNetworkMembershipView,
  ManagedNetworkView,
  NetworkMembershipSource,
} from "@mini-infra/types";
import {
  computeAddableNetworks,
  computeConnectedNetworkRows,
} from "@/app/applications/[id]/_components/connected-networks-model";

function mkDockerNet(
  name: string,
  driver = "bridge",
  overrides: Partial<DockerNetwork> = {},
): DockerNetwork {
  return {
    id: `net-${name}`,
    name,
    driver,
    scope: "local",
    internal: false,
    attachable: true,
    ipam: {} as DockerNetwork["ipam"],
    containers: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    labels: {},
    options: {},
    ...overrides,
  };
}

function mkMembership(
  source: NetworkMembershipSource,
  overrides: Partial<ManagedNetworkMembershipView> = {},
): ManagedNetworkMembershipView {
  return {
    id: `m-${source}`,
    source,
    status: "connected",
    connectedContainers: [],
    ...overrides,
  };
}

function mkView(
  name: string,
  opts: {
    scope?: ManagedNetworkView["scope"];
    stackId?: string;
    source?: NetworkMembershipSource;
    memberships?: ManagedNetworkMembershipView[];
  } = {},
): ManagedNetworkView {
  const scope = opts.scope ?? "stack";
  const memberships =
    opts.memberships ??
    [mkMembership(opts.source ?? "template", { stackId: opts.stackId })];
  return {
    id: `mnv-${name}`,
    name,
    scope,
    stackId: opts.stackId,
    purpose: name,
    driver: "bridge",
    dbStatus: "active",
    existence: "present",
    enforceMemberships: false,
    driftStatus: "synced",
    driftItemCount: 0,
    memberships,
    unattributedContainers: [],
  };
}

describe("computeAddableNetworks", () => {
  it("excludes unusable, own, declared, and already-live networks", () => {
    const raw = [
      mkDockerNet("bridge", "bridge"), // default bridge — unusable
      mkDockerNet("host", "host"), // host driver — unusable
      mkDockerNet("none", "null"), // null driver — unusable
      mkDockerNet("weird", "null"), // null driver — unusable
      mkDockerNet("myapp-net"), // own stack network
      mkDockerNet("local-db"), // already declared
      mkDockerNet("shared"), // already live
      mkDockerNet("free-net"), // the only addable one
    ];

    const addable = computeAddableNetworks(
      raw,
      new Set(["myapp-net"]),
      ["local-db"],
      [mkView("shared", { scope: "stack" })],
    );

    expect(addable.map((n) => n.name)).toEqual(["free-net"]);
  });
});

describe("computeConnectedNetworkRows", () => {
  const stackId = "stack-1";

  it("categorizes attached / pending-add / pending-removal and removable flags", () => {
    const live: ManagedNetworkView[] = [
      // Own stack network — attached, not removable (template source).
      mkView("myapp-net", { scope: "stack", source: "template" }),
      // User-added, still declared — attached, removable.
      mkView("local-db", { scope: "stack", source: "user", stackId }),
      // User-added, dropped from declaration — pending-removal, not removable.
      mkView("old-db", { scope: "stack", source: "user", stackId }),
      // Shared infra network joined via egress — attached, not removable.
      mkView("egress", { scope: "environment", source: "egress", stackId }),
    ];
    const declared = ["myapp-net", "local-db", "new-net", "ghost-net"];
    const ownNames = new Set(["myapp-net"]);
    const rawNetworks = [mkDockerNet("new-net")]; // ghost-net intentionally absent

    const rows = computeConnectedNetworkRows({
      live,
      declared,
      ownNames,
      stackId,
      ownContainerNames: new Set<string>(),
      rawNetworks,
    });

    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    expect(byName["myapp-net"].state).toBe("attached");
    expect(byName["myapp-net"].removable).toBe(false);

    expect(byName["local-db"].state).toBe("attached");
    expect(byName["local-db"].removable).toBe(true);

    expect(byName["old-db"].state).toBe("pending-removal");
    expect(byName["old-db"].removable).toBe(false);

    expect(byName["egress"].state).toBe("attached");
    expect(byName["egress"].removable).toBe(false);

    // Declared-but-not-live networks become pending-add; own networks never do.
    expect(byName["new-net"].state).toBe("pending-add");
    expect(byName["new-net"].removable).toBe(true);
    expect(byName["new-net"].pendingExistence).toBe("present");

    expect(byName["ghost-net"].state).toBe("pending-add");
    expect(byName["ghost-net"].pendingExistence).toBe("absent");
  });

  it("does not flag a declared own network as pending-add", () => {
    const rows = computeConnectedNetworkRows({
      live: [],
      declared: ["myapp-net"],
      ownNames: new Set(["myapp-net"]),
      stackId,
      ownContainerNames: new Set<string>(),
      rawNetworks: [],
    });
    expect(rows).toHaveLength(0);
  });
});
