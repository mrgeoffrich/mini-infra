/**
 * Unit tests for the tri-state derivation shared by every connectivity
 * fan-out consumer (`useServiceConnectivityState`, `useServicesConnectivity`,
 * `useAllServicesStatus`, and the header's `ConnectivityIndicator`). See
 * docs/planning/not-shipped/frontend-backend-contract-plan.md Phase 7.
 *
 * Exercises the mapping table directly, independent of React/TanStack Query
 * plumbing: loading, erroring, or resolving with no rows yet must all map
 * to "unknown" — never "down" — and only a loaded row whose status isn't
 * "connected" counts as "down".
 */

import { describe, it, expect } from "vitest";
import { deriveConnectivityState } from "@/hooks/use-all-services-status";
import type { ConnectivityStatusInfo } from "@mini-infra/types";

function makeRow(
  status: ConnectivityStatusInfo["status"],
): ConnectivityStatusInfo {
  return {
    id: "row-1",
    service: "docker",
    status,
    responseTimeMs: 12,
    errorMessage: null,
    errorCode: null,
    lastSuccessfulAt: null,
    checkedAt: new Date().toISOString(),
    checkInitiatedBy: null,
    metadata: null,
  };
}

describe("deriveConnectivityState", () => {
  it("is unknown while the query is loading, even with no row yet", () => {
    expect(deriveConnectivityState(undefined, /* isLoading */ true, false)).toBe(
      "unknown",
    );
  });

  it("is unknown when the query errored", () => {
    expect(deriveConnectivityState(undefined, false, /* isError */ true)).toBe(
      "unknown",
    );
  });

  it("is unknown when the query settled with no rows yet (cold start)", () => {
    expect(deriveConnectivityState(undefined, false, false)).toBe("unknown");
  });

  it("is connected when the latest row says connected", () => {
    expect(deriveConnectivityState(makeRow("connected"), false, false)).toBe(
      "connected",
    );
  });

  it.each(["failed", "timeout", "unreachable"] as const)(
    "is down when the latest row says %s",
    (status) => {
      expect(deriveConnectivityState(makeRow(status), false, false)).toBe(
        "down",
      );
    },
  );

  it("precedence: isLoading wins over a row being present", () => {
    // Defensive check on the function's own precedence order — TanStack
    // Query's `isLoading` (pending + fetching, no data) wouldn't realistically
    // pair with a resolved row, but the mapping should still not read a
    // loading query as "connected" if it's ever called this way.
    expect(
      deriveConnectivityState(makeRow("connected"), true, false),
    ).toBe("unknown");
  });
});
