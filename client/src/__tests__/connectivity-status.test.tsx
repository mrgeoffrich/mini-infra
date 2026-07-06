/**
 * Regression test for the GitHub connectivity page crash.
 *
 * A connectivity record whose `status` fell outside CONNECTIVITY_STATUS_TYPES
 * (production stored `"error"` with "Unsupported configuration category:
 * github-app") made `StatusBadge` index `statusConfig` to `undefined` and read
 * `.icon` off it — throwing "Cannot read properties of undefined (reading
 * 'icon')" and taking the whole page into the auth error boundary.
 *
 * The fix moved the vocabulary + a `toConnectivityStatus` normaliser into
 * @mini-infra/types, added an exhaustive `error` entry to the badge/dot config,
 * and made both primitives degrade any unknown status to a known one instead of
 * crashing. This test pins all three so the crash can't regress.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  CONNECTIVITY_STATUS_TYPES,
  toConnectivityStatus,
  type ConnectivityStatusType,
} from "@mini-infra/types";
import { StatusBadge, StatusDot } from "@/components/connectivity-status";

describe("toConnectivityStatus", () => {
  it("passes through every known vocabulary member unchanged", () => {
    for (const status of CONNECTIVITY_STATUS_TYPES) {
      expect(toConnectivityStatus(status)).toBe(status);
    }
  });

  it("carries 'error' as a first-class status", () => {
    expect(CONNECTIVITY_STATUS_TYPES).toContain("error");
  });

  it("degrades unknown / empty / null / undefined to 'error'", () => {
    expect(toConnectivityStatus("unknown")).toBe("error");
    expect(toConnectivityStatus("")).toBe("error");
    expect(toConnectivityStatus(null)).toBe("error");
    expect(toConnectivityStatus(undefined)).toBe("error");
  });
});

describe("StatusBadge / StatusDot with an off-vocabulary status", () => {
  it("renders the 'error' status (the exact prod value) without throwing", () => {
    expect(() => render(<StatusBadge status="error" />)).not.toThrow();
    expect(() => render(<StatusDot status="error" />)).not.toThrow();
  });

  it("degrades an unrecognised legacy DB value to a rendered badge instead of crashing", () => {
    // TypeScript wouldn't permit this, but the DB column is a free string and
    // can hold historic values — the primitives must not read `.icon` of undefined.
    const bogus = "totally-bogus" as ConnectivityStatusType;

    const { getByText } = render(<StatusBadge status={bogus} />);
    expect(getByText("Error")).toBeInTheDocument();

    expect(() => render(<StatusDot status={bogus} />)).not.toThrow();
  });
});
