/**
 * Tests for the shared "attach add-on" surface (Phase 3 of the
 * addon-authoring-ui plan).
 *
 * Two layers:
 *   1. The pure gating + config-mapping helpers (`addon-applicability.ts`) —
 *      the load-bearing logic both the Overview card and the Phase-4
 *      Services-tab row share, so it's tested in isolation.
 *   2. The `AttachAddonDialog` component — that applicability gating disables
 *      the right rows with the right reasons, and that a filled config form
 *      maps into the config object handed to `onAttach`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React from "react";
import type { AddonCatalogEntry } from "@mini-infra/types";
import {
  buildAddonConfig,
  getAddonAvailability,
  initialFormState,
} from "@/components/stacks/addon-applicability";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const webAddon: AddonCatalogEntry = {
  id: "tailscale-web",
  description: "Expose the target over HTTPS on the tailnet.",
  kind: "tailscale",
  mode: "sidecar",
  appliesTo: ["Stateful", "StatelessWeb", "Pool"],
  requiresConnectedService: "tailscale",
  configFields: [
    {
      name: "port",
      label: "Target Port",
      type: "number",
      required: true,
      min: 1,
      max: 65535,
    },
    {
      name: "extraTags",
      label: "Extra Tags",
      type: "string[]",
      required: false,
      pattern: "^tag:[a-z0-9-]+$",
    },
  ],
};

const poolOnlyAddon: AddonCatalogEntry = {
  id: "pool-only",
  description: "Only attaches to pool services.",
  mode: "sidecar",
  appliesTo: ["Pool"],
  configFields: [],
};

// ---------------------------------------------------------------------------
// Pure helpers — applicability gating
// ---------------------------------------------------------------------------

describe("getAddonAvailability", () => {
  it("disables an addon whose appliesTo excludes the target service type", () => {
    const result = getAddonAvailability(poolOnlyAddon, "Stateful", {
      tailscale: "up",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("Stateful");
    // Applicability is unfixable — no settings link.
    expect(result.fix).toBeUndefined();
  });

  it("disables an addon whose required connected service is down, with a fix link", () => {
    const result = getAddonAvailability(webAddon, "Stateful", {
      tailscale: "down",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("Requires Tailscale — not connected");
    expect(result.fix?.to).toBe("/connectivity-tailscale");
  });

  it("allows an applicable addon whose prerequisite is up", () => {
    const result = getAddonAvailability(webAddon, "StatelessWeb", {
      tailscale: "up",
    });
    expect(result.available).toBe(true);
  });

  it("allows an applicable addon whose prerequisite status is unknown (server re-validates)", () => {
    const result = getAddonAvailability(webAddon, "StatelessWeb", {
      tailscale: "unknown",
    });
    expect(result.available).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — config-form → config mapping
// ---------------------------------------------------------------------------

describe("buildAddonConfig", () => {
  it("errors when a required field is blank", () => {
    const state = initialFormState(webAddon.configFields); // port -> ""
    const result = buildAddonConfig(webAddon.configFields, state);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.port).toContain("required");
  });

  it("coerces a numeric field and omits an empty optional list", () => {
    const state = { port: "8080", extraTags: [] as string[] };
    const result = buildAddonConfig(webAddon.configFields, state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual({ port: 8080 });
      // Empty optional string[] is omitted, not written as [].
      expect("extraTags" in result.config).toBe(false);
    }
  });

  it("enforces numeric min/max advisory bounds", () => {
    const result = buildAddonConfig(webAddon.configFields, {
      port: "70000",
      extraTags: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.port).toContain("at most");
  });

  it("includes a validated string[] and rejects a pattern mismatch", () => {
    const ok = buildAddonConfig(webAddon.configFields, {
      port: "443",
      extraTags: ["tag:dev-team"],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config).toEqual({ port: 443, extraTags: ["tag:dev-team"] });

    const bad = buildAddonConfig(webAddon.configFields, {
      port: "443",
      extraTags: ["NOT-A-TAG"],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.extraTags).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Component — AttachAddonDialog
// ---------------------------------------------------------------------------

const mockCatalog = vi.fn<() => { addons: AddonCatalogEntry[] }>();
// `useServiceConnectivity` returns `{ data: <ConnectivityStatusListResponse> }`;
// the dialog reads `data.data[0].status`. This mock supplies that inner value.
const mockConnectivity = vi.fn<() => { data: Array<{ status: string }> }>();

vi.mock("@/hooks/use-addon-catalog", () => ({
  useAddonCatalog: vi.fn(() => ({
    data: mockCatalog(),
    isLoading: false,
    isError: false,
  })),
}));

vi.mock("@/hooks/use-settings-validation", () => ({
  useServiceConnectivity: vi.fn(() => ({ data: mockConnectivity() })),
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) =>
    React.createElement("a", { href: to }, children),
}));

import { AttachAddonDialog } from "@/components/stacks/attach-addon-dialog";

function renderDialog(
  props: Partial<React.ComponentProps<typeof AttachAddonDialog>> = {},
) {
  const defaults: React.ComponentProps<typeof AttachAddonDialog> = {
    open: true,
    onOpenChange: vi.fn(),
    serviceName: "web",
    serviceType: "Stateful",
    attachedAddonIds: [],
    onAttach: vi.fn(),
    onRemove: vi.fn(),
  };
  return render(
    React.createElement(AttachAddonDialog, { ...defaults, ...props }),
  );
}

describe("AttachAddonDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCatalog.mockReturnValue({ addons: [webAddon, poolOnlyAddon] });
    mockConnectivity.mockReturnValue({ data: [{ status: "connected" }] });
  });

  it("disables an addon that does not apply to the service type and shows the reason", () => {
    renderDialog({ serviceType: "Stateful" });
    const row = screen.getByTestId("addon-row-pool-only");
    expect(within(row).getByText(/Not available for Stateful services/)).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Configure" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("disables an addon whose required service is down and links to settings", () => {
    mockConnectivity.mockReturnValue({ data: [{ status: "failed" }] });
    renderDialog({ serviceType: "Stateful" });
    const row = screen.getByTestId("addon-row-tailscale-web");
    expect(
      within(row).getByText(/Requires Tailscale .* not connected/),
    ).toBeTruthy();
    const link = within(row).getByRole("link", { name: "Connectivity settings" });
    expect(link.getAttribute("href")).toBe("/connectivity-tailscale");
  });

  it("maps the config form into the addon config passed to onAttach", () => {
    const onAttach = vi.fn();
    const onOpenChange = vi.fn();
    renderDialog({ serviceType: "Stateful", onAttach, onOpenChange });

    const row = screen.getByTestId("addon-row-tailscale-web");
    fireEvent.click(within(row).getByRole("button", { name: "Configure" }));

    fireEvent.change(screen.getByLabelText(/Target Port/), {
      target: { value: "8080" },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Attach" }));

    expect(onAttach).toHaveBeenCalledWith("tailscale-web", { port: 8080 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("blocks attach and shows a field error when a required field is blank", () => {
    const onAttach = vi.fn();
    renderDialog({ serviceType: "Stateful", onAttach });

    const row = screen.getByTestId("addon-row-tailscale-web");
    fireEvent.click(within(row).getByRole("button", { name: "Configure" }));
    fireEvent.click(within(row).getByRole("button", { name: "Attach" }));

    expect(within(row).getByText(/Target Port is required/)).toBeTruthy();
    expect(onAttach).not.toHaveBeenCalled();
  });
});
