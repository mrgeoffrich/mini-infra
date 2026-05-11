/**
 * Tests for the ConnectCard's claude-shell row.
 *
 * Verifies:
 *   - the claude-shell SSH endpoint renders a row with the SSH URL and an
 *     addon badge that names `claude-shell`;
 *   - clicking the copy button writes the SSH command to the clipboard;
 *   - the card omits itself entirely when no endpoints are returned (so the
 *     row only appears when the addon is attached).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type {
  TailscaleAddonEndpointsResponse,
  TailscaleDevicesResponse,
} from "@mini-infra/types";

// ---------------------------------------------------------------------------
// Hook mocks — the card composes three hooks; mock each at the module
// boundary so the test renders synchronously with the data shape we want.
// ---------------------------------------------------------------------------

const mockEndpoints = vi.fn<() => TailscaleAddonEndpointsResponse>();
const mockDevices = vi.fn<() => TailscaleDevicesResponse>();

vi.mock("@/hooks/use-stack-addon-endpoints", () => ({
  useStackAddonEndpoints: vi.fn(() => ({
    data: mockEndpoints(),
    isLoading: false,
  })),
}));

vi.mock("@/hooks/use-tailscale-devices", () => ({
  useTailscaleDevices: vi.fn(() => ({
    data: mockDevices(),
    isLoading: false,
  })),
  indexDevicesByHostname: vi.fn((devices) => {
    const map = new Map();
    for (const d of devices ?? []) map.set(d.hostname, d);
    return map;
  }),
}));

vi.mock("@/hooks/use-settings-validation", () => ({
  useServiceConnectivity: vi.fn(() => ({
    data: { data: [{ status: "connected" }] },
  })),
}));

// react-router-dom Link only — keep the rest of the module out of the bundle.
vi.mock("react-router-dom", () => ({
  Link: ({ children }: { children: React.ReactNode }) =>
    React.createElement("a", null, children),
}));

import { ConnectCard } from "@/app/applications/[id]/_components/connect-card";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderConnectCard(props: Partial<React.ComponentProps<typeof ConnectCard>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const merged: React.ComponentProps<typeof ConnectCard> = {
    stackId: "stack-1",
    stackName: "dev-stack",
    envName: "prod",
    ...props,
  };
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(ConnectCard, merged),
    ),
  );
}

function mockClipboard() {
  // jsdom doesn't ship navigator.clipboard — provide a stub the row can call.
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    writable: true,
    configurable: true,
  });
  return writeText;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConnectCard — claude-shell row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDevices.mockReturnValue({
      tailnet: "tailnet-1234.ts.net",
      devices: [],
      lastUpdatedAt: new Date().toISOString(),
    });
  });

  it("renders the SSH row with the URL and the claude-shell addon badge", () => {
    mockEndpoints.mockReturnValue({
      endpoints: [
        {
          targetService: "shell",
          syntheticServiceName: "shell",
          addonIds: ["claude-shell"],
          kind: "ssh",
          hostname: "dev-stack-shell-prod",
          url: "ssh root@dev-stack-shell-prod.tailnet-1234.ts.net",
        },
      ],
    });

    renderConnectCard();

    // The Connect card body renders.
    expect(screen.getByText("Connect")).toBeTruthy();
    // The SSH command renders in monospace.
    expect(
      screen.getByText("ssh root@dev-stack-shell-prod.tailnet-1234.ts.net"),
    ).toBeTruthy();
    // The addon badge names `claude-shell` (and not `tailscale`).
    expect(screen.getByText("from claude-shell")).toBeTruthy();
    // The row is tagged with the target service so a future operator can
    // find the right row via DOM scanning.
    expect(
      document.querySelector('[data-tour="connect-endpoint-shell-ssh"]'),
    ).toBeTruthy();
  });

  it("copies the SSH command to the clipboard when the copy button is clicked", async () => {
    const writeText = mockClipboard();
    mockEndpoints.mockReturnValue({
      endpoints: [
        {
          targetService: "shell",
          syntheticServiceName: "shell",
          addonIds: ["claude-shell"],
          kind: "ssh",
          hostname: "dev-stack-shell-prod",
          url: "ssh root@dev-stack-shell-prod.tailnet-1234.ts.net",
        },
      ],
    });

    renderConnectCard();

    const copyButton = screen.getByLabelText("Copy to clipboard");
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "ssh root@dev-stack-shell-prod.tailnet-1234.ts.net",
      );
    });
  });

  it("does not render the card when the endpoints list is empty", () => {
    // No `claude-shell` endpoint emitted → no row, no card.
    mockEndpoints.mockReturnValue({ endpoints: [] });

    const { container } = renderConnectCard();
    expect(container.firstChild).toBeNull();
  });

  it("uses the tailscale badge when only sidecar-mode endpoints are attached", () => {
    // Guard the badge-derivation: a target with only tailscale-ssh should
    // still render under the `tailscale` label, not `claude-shell`.
    mockEndpoints.mockReturnValue({
      endpoints: [
        {
          targetService: "web",
          syntheticServiceName: "web-tailscale",
          addonIds: ["tailscale-ssh"],
          kind: "ssh",
          hostname: "stack-web-prod",
          url: "ssh root@stack-web-prod.tailnet-1234.ts.net",
        },
      ],
    });

    renderConnectCard();
    expect(screen.getByText("from tailscale")).toBeTruthy();
    expect(screen.queryByText("from claude-shell")).toBeNull();
  });
});
