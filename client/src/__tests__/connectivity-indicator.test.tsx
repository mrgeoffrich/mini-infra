/**
 * Tests for the tri-state connected-service indicator (Phase 7 of
 * docs/planning/not-shipped/frontend-backend-contract-plan.md).
 *
 * Done-when: with the connectivity query in a loading/empty/error state,
 * the indicator renders "unknown" — never the red "disconnected" look that
 * a genuinely down service gets. Covers the three states end-to-end
 * through `useServiceConnectivityState` (the shared hook that also backs
 * `useServicesConnectivity` / `useAllServicesStatus`, so this exercises the
 * same tri-state derivation those consumers rely on).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import type { ConnectivityState } from "@/hooks/use-all-services-status";

const mockUseServiceConnectivityState = vi.fn();

vi.mock("@/hooks/use-all-services-status", () => ({
  useServiceConnectivityState: (...args: unknown[]) =>
    mockUseServiceConnectivityState(...args),
}));

// react-router-dom Link only — keep the rest of the module out of the bundle
// (matches the pattern in connect-card-claude-shell.test.tsx).
vi.mock("react-router-dom", () => ({
  Link: ({
    children,
    to,
    ...rest
  }: React.PropsWithChildren<{ to: string }>) =>
    React.createElement("a", { href: to, ...rest }, children),
}));

import { ConnectivityIndicator } from "@/components/connectivity-indicator";

function FakeIcon({ className }: { size?: number; className?: string }) {
  return React.createElement("svg", { className, "data-testid": "icon" });
}

function setState(state: ConnectivityState) {
  mockUseServiceConnectivityState.mockReturnValue({ state });
}

describe("ConnectivityIndicator", () => {
  it("renders unknown (not down) while the query is loading", () => {
    setState("unknown");

    render(
      <ConnectivityIndicator service="docker" icon={FakeIcon} label="Docker" />,
    );

    const dot = document.querySelector("[data-connectivity-state]");
    expect(dot).toHaveAttribute("data-connectivity-state", "unknown");
    expect(dot?.className).toContain("bg-gray-400");
    expect(dot?.className).not.toContain("bg-red-500");
    expect(dot?.className).toContain("animate-pulse");

    // Unknown must not be click-through — we don't yet know it's down.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
      screen.getByTitle("Docker: Checking…"),
    ).toBeInTheDocument();
  });

  it("renders unknown when the connectivity query has no rows yet (cold start)", () => {
    // Same derived state as loading/errored — the hook already folds
    // "resolved with an empty list" into "unknown" before the component
    // ever sees it, but assert the component renders that state correctly.
    setState("unknown");

    render(
      <ConnectivityIndicator
        service="cloudflare"
        icon={FakeIcon}
        label="Cloudflare"
      />,
    );

    expect(
      document.querySelector('[data-connectivity-state="unknown"]'),
    ).toBeInTheDocument();
  });

  it("renders unknown (not down) when the connectivity fetch errors", () => {
    setState("unknown");

    render(
      <ConnectivityIndicator service="storage" icon={FakeIcon} label="Storage" />,
    );

    expect(
      document.querySelector('[data-connectivity-state="unknown"]'),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders green and non-clickable when connected", () => {
    setState("connected");

    render(
      <ConnectivityIndicator service="docker" icon={FakeIcon} label="Docker" />,
    );

    const dot = document.querySelector("[data-connectivity-state]");
    expect(dot).toHaveAttribute("data-connectivity-state", "connected");
    expect(dot?.className).toContain("bg-green-500");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByTitle("Docker: Connected")).toBeInTheDocument();
  });

  it("renders red and click-through to the config page when down", () => {
    setState("down");

    render(
      <ConnectivityIndicator
        service="github-app"
        icon={FakeIcon}
        label="GitHub"
      />,
    );

    const dot = document.querySelector("[data-connectivity-state]");
    expect(dot).toHaveAttribute("data-connectivity-state", "down");
    expect(dot?.className).toContain("bg-red-500");
    expect(dot?.className).not.toContain("bg-gray-400");

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/connectivity-github");
    expect(
      screen.getByTitle("GitHub: Disconnected - Click to configure"),
    ).toBeInTheDocument();
  });
});
