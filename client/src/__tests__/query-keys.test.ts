/**
 * Tests for the shared TanStack Query key factory (`queryKeys`).
 *
 * These pin the exact runtime shape of the `containers` group so a future
 * edit can't silently restructure it and break the cross-hook invalidation
 * that other call sites (e.g. `use-container-actions.ts`,
 * `use-connect-container.ts`, `task-type-registry.ts`) rely on by hand-
 * invalidating the bare `["containers"]` prefix.
 */

import { describe, it, expect } from "vitest";
import { queryKeys } from "@mini-infra/types";
import type { ContainerQueryParams } from "@mini-infra/types";

describe("queryKeys.containers", () => {
  it("all deep-equals the bare containers key", () => {
    expect(queryKeys.containers.all).toEqual(["containers"]);
  });

  it("list(params) deep-equals the historical inline key shape", () => {
    const params: ContainerQueryParams = { status: "running", page: 1, limit: 50 };
    expect(queryKeys.containers.list(params)).toEqual(["containers", params]);
  });

  it("list() with an empty params object still nests under the containers prefix", () => {
    expect(queryKeys.containers.list({})).toEqual(["containers", {}]);
  });

  it("list(params) key matches the all key by prefix (TanStack default invalidation)", () => {
    const listKey = queryKeys.containers.list({ status: "running" });
    const allKey = queryKeys.containers.all;
    expect(listKey.slice(0, allKey.length)).toEqual(allKey);
  });
});
