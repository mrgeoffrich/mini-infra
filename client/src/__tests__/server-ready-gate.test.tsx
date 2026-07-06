/**
 * Tests for the cold-start readiness gate (Phase 8 of
 * docs/planning/not-shipped/frontend-backend-contract-plan.md).
 *
 * Drives a mocked `apiFetch` through a failing `/health` probe and asserts:
 *   - while the probe keeps failing, the gate renders the "waiting for
 *     server" state — not children, not an auth error
 *   - once the probe succeeds, the gate renders children and stays that way
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

// vi.mock factories are hoisted above all imports, so the mock must be
// built via vi.hoisted() rather than referencing an outer-scope variable.
const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: mockApiFetch,
}));

import { ServerReadyGate } from "@/components/server-ready-gate";

describe("ServerReadyGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the waiting screen while /health fails, then renders children once it succeeds", async () => {
    // Simulate a down server: fetch() rejects with a raw TypeError, exactly
    // as it does on a real connection-refused failure (apiFetch re-throws
    // this as-is, it does NOT wrap it in an ApiRequestError).
    mockApiFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    render(
      <ServerReadyGate>
        <div>protected app content</div>
      </ServerReadyGate>,
    );

    // Let the first (immediate, no-delay) probe reject.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/waiting for server/i)).toBeInTheDocument();
    expect(
      screen.queryByText("protected app content"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/authentication error/i)).not.toBeInTheDocument();

    // Keep failing across a few backoff cycles — still waiting, never an
    // error state, and it should retry forever rather than giving up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText(/waiting for server/i)).toBeInTheDocument();
    expect(mockApiFetch.mock.calls.length).toBeGreaterThan(1);

    // Now the backend comes up — the next probe succeeds.
    mockApiFetch.mockResolvedValue({ status: "healthy" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.getByText("protected app content")).toBeInTheDocument();
    expect(screen.queryByText(/waiting for server/i)).not.toBeInTheDocument();

    // Further time passing must not re-block on a later /health hiccup —
    // the gate only guards the initial load.
    mockApiFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText("protected app content")).toBeInTheDocument();
  });

  it("renders children immediately when /health succeeds on the first probe", async () => {
    mockApiFetch.mockResolvedValue({ status: "healthy" });

    render(
      <ServerReadyGate>
        <div>protected app content</div>
      </ServerReadyGate>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("protected app content")).toBeInTheDocument();
    expect(screen.queryByText(/waiting for server/i)).not.toBeInTheDocument();
  });
});
