import { describe, it, expect } from "vitest";
import type { DockerContainerInfo } from "@mini-infra/types";
import {
  checkStackRuntime,
  groupContainersByStack,
  describeRuntimeIssues,
  STACK_ID_LABEL,
  SERVICE_LABEL,
  DEFINITION_HASH_LABEL,
} from "../stack-runtime-check";

function container(opts: {
  stackId?: string;
  service?: string;
  hash?: string;
  status?: string;
  name?: string;
}): DockerContainerInfo {
  const labels: Record<string, string> = {};
  if (opts.stackId) labels[STACK_ID_LABEL] = opts.stackId;
  if (opts.service) labels[SERVICE_LABEL] = opts.service;
  if (opts.hash) labels[DEFINITION_HASH_LABEL] = opts.hash;

  return {
    id: `c-${opts.service ?? "x"}-${opts.status ?? "running"}`,
    name: opts.name ?? `stk-${opts.service}`,
    status: (opts.status ?? "running") as DockerContainerInfo["status"],
    image: "nginx",
    imageTag: "latest",
    ports: [],
    volumes: [],
    createdAt: new Date(0),
    labels,
  };
}

const HASHES = { api: "sha256:aaa", worker: "sha256:bbb" };

describe("checkStackRuntime", () => {
  it("is healthy when every service runs with the hash we applied", () => {
    const check = checkStackRuntime({ id: "s1", lastAppliedHashes: HASHES }, [
      container({ stackId: "s1", service: "api", hash: "sha256:aaa" }),
      container({ stackId: "s1", service: "worker", hash: "sha256:bbb" }),
    ]);

    expect(check).toEqual({ healthy: true, issues: [] });
  });

  it("flags a service that started then crashed — the whole point of 3.1", () => {
    // This is the case that left the stack `synced` with a dead app: the apply
    // path only watches for ~5s after start, so a later crash was invisible.
    const check = checkStackRuntime({ id: "s1", lastAppliedHashes: HASHES }, [
      container({ stackId: "s1", service: "api", hash: "sha256:aaa", status: "exited" }),
      container({ stackId: "s1", service: "worker", hash: "sha256:bbb" }),
    ]);

    expect(check?.healthy).toBe(false);
    expect(check?.issues).toEqual([{ kind: "not-running", serviceName: "api", status: "exited" }]);
  });

  it("flags a service whose container is gone entirely", () => {
    const check = checkStackRuntime({ id: "s1", lastAppliedHashes: HASHES }, [
      container({ stackId: "s1", service: "api", hash: "sha256:aaa" }),
    ]);

    expect(check?.healthy).toBe(false);
    expect(check?.issues).toEqual([{ kind: "missing", serviceName: "worker" }]);
  });

  it("flags a container replaced out of band — the whole point of 3.2", () => {
    const check = checkStackRuntime({ id: "s1", lastAppliedHashes: HASHES }, [
      container({ stackId: "s1", service: "api", hash: "sha256:SOMETHING-ELSE" }),
      container({ stackId: "s1", service: "worker", hash: "sha256:bbb" }),
    ]);

    expect(check?.healthy).toBe(false);
    expect(check?.issues).toEqual([{ kind: "hash-mismatch", serviceName: "api" }]);
  });

  it("returns no opinion when the stack has no stored hashes", () => {
    // Applied before the column existed. We have nothing trustworthy to diff
    // against, so the monitor must leave the status alone rather than assume
    // health (or, worse, assume drift and mark the whole fleet).
    expect(checkStackRuntime({ id: "s1", lastAppliedHashes: null }, [])).toBeNull();
    expect(checkStackRuntime({ id: "s1", lastAppliedHashes: {} }, [])).toBeNull();
    expect(checkStackRuntime({ id: "s1", lastAppliedHashes: "nonsense" }, [])).toBeNull();
  });

  it("prefers the running container when a blue-green deploy leaves two", () => {
    // Mid-deploy a service can have a draining blue and a live green. Picking
    // the stopped one would report a healthy stack as dead.
    const check = checkStackRuntime({ id: "s1", lastAppliedHashes: { api: "sha256:aaa" } }, [
      container({ stackId: "s1", service: "api", hash: "sha256:aaa", status: "exited", name: "blue" }),
      container({ stackId: "s1", service: "api", hash: "sha256:aaa", status: "running", name: "green" }),
    ]);

    expect(check?.healthy).toBe(true);
  });

  it("ignores a container with no definition-hash label rather than crying drift", () => {
    // Prefer false negatives: the full plan remains the authority.
    const check = checkStackRuntime({ id: "s1", lastAppliedHashes: { api: "sha256:aaa" } }, [
      container({ stackId: "s1", service: "api" }),
    ]);

    expect(check?.healthy).toBe(true);
  });
});

describe("groupContainersByStack", () => {
  it("groups by the stack-id label and drops unmanaged containers", () => {
    const grouped = groupContainersByStack([
      container({ stackId: "s1", service: "api" }),
      container({ stackId: "s1", service: "worker" }),
      container({ stackId: "s2", service: "db" }),
      container({ service: "some-random-container" }), // unmanaged — no stack label
    ]);

    expect(grouped.get("s1")).toHaveLength(2);
    expect(grouped.get("s2")).toHaveLength(1);
    expect(grouped.size).toBe(2);
  });
});

describe("describeRuntimeIssues", () => {
  it("reads as an operator-facing sentence", () => {
    expect(
      describeRuntimeIssues([
        { kind: "not-running", serviceName: "api", status: "exited" },
        { kind: "missing", serviceName: "worker" },
        { kind: "hash-mismatch", serviceName: "cache" },
      ]),
    ).toBe(
      "service 'api' is exited; service 'worker' has no container; " +
        "service 'cache' does not match the applied definition",
    );
  });
});
