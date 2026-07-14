/**
 * Tests for the per-service Add-ons affordance in the stack-templates draft
 * editor (Phase 4, Part B) and the lossless save path it rides on (Part A).
 *
 * The shared `AttachAddonDialog` (its own catalog/connectivity gating is
 * covered by attach-addon-dialog.test.tsx) and the heavy `ServiceEditDrawer`
 * (react-hook-form + zod + every field tab) are both mocked so this suite can
 * focus on: which service the dialog scopes to, that attach/remove writes that
 * service's `addons`, and that touching a sibling never strips another
 * service's addons.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import type {
  StackServiceDefinition,
  StackTemplateServiceInfo,
} from "@mini-infra/types";

vi.mock(
  "@/components/stack-templates/service-drawer/service-edit-drawer",
  () => ({ ServiceEditDrawer: () => null }),
);

vi.mock("@/components/stacks/attach-addon-dialog", () => ({
  AttachAddonDialog: ({
    open,
    serviceName,
    attachedAddonIds,
    onAttach,
    onRemove,
  }: {
    open: boolean;
    serviceName: string;
    attachedAddonIds: string[];
    onAttach: (id: string, config: Record<string, unknown>) => void;
    onRemove: (id: string) => void;
  }) =>
    open
      ? React.createElement(
          "div",
          { "data-testid": "attach-addon-dialog" },
          React.createElement(
            "span",
            { "data-testid": "dialog-service-name" },
            serviceName,
          ),
          React.createElement(
            "span",
            { "data-testid": "dialog-attached-ids" },
            attachedAddonIds.join(","),
          ),
          React.createElement(
            "button",
            {
              type: "button",
              onClick: () =>
                onAttach("tailscale-ssh", { authKey: "tskey-x" }),
            },
            "mock-attach",
          ),
          React.createElement(
            "button",
            { type: "button", onClick: () => onRemove("tailscale-web") },
            "mock-remove",
          ),
        )
      : null,
}));

import { TemplateServicesSection } from "@/components/stack-templates/template-services-section";

function serviceInfo(
  overrides: Partial<StackTemplateServiceInfo> = {},
): StackTemplateServiceInfo {
  return {
    id: "svc",
    versionId: "ver-1",
    serviceName: "svc",
    serviceType: "Stateful",
    dockerImage: "nginx",
    dockerTag: "latest",
    containerConfig: {},
    initCommands: null,
    dependsOn: [],
    order: 1,
    routing: null,
    poolConfig: null,
    jobPoolConfig: null,
    addons: null,
    ...overrides,
  };
}

const serviceA = serviceInfo({ id: "svc-a", serviceName: "api", order: 1 });
const serviceB = serviceInfo({
  id: "svc-b",
  serviceName: "web",
  order: 2,
  addons: { "tailscale-web": { port: 443 } },
});

function renderSection(
  props: {
    services?: StackTemplateServiceInfo[];
    readOnly?: boolean;
    onServicesChange?: (services: StackServiceDefinition[]) => void;
  } = {},
) {
  const onServicesChange =
    props.onServicesChange ?? vi.fn<(s: StackServiceDefinition[]) => void>();
  const services = props.services ?? [serviceA, serviceB];
  render(
    React.createElement(TemplateServicesSection, {
      services,
      allServiceNames: services.map((s) => s.serviceName),
      readOnly: props.readOnly,
      onServicesChange,
    }),
  );
  return { onServicesChange };
}

describe("TemplateServicesSection — per-service add-ons", () => {
  it("shows an attached add-on badge on the service that declares it", () => {
    renderSection();
    expect(screen.getByText("from tailscale-web")).toBeTruthy();
  });

  it("scopes the dialog to the chosen service and writes its addons on attach", () => {
    const onServicesChange = vi.fn<(s: StackServiceDefinition[]) => void>();
    renderSection({ onServicesChange });

    fireEvent.click(screen.getByLabelText("Add-ons for web"));

    expect(screen.getByTestId("dialog-service-name").textContent).toBe("web");
    expect(screen.getByTestId("dialog-attached-ids").textContent).toBe(
      "tailscale-web",
    );

    fireEvent.click(screen.getByText("mock-attach"));

    expect(onServicesChange).toHaveBeenCalledTimes(1);
    const next = onServicesChange.mock.calls[0]![0];
    const web = next.find((s) => s.serviceName === "web")!;
    const api = next.find((s) => s.serviceName === "api")!;
    // New addon merged onto B; the existing one is preserved.
    expect(web.addons).toEqual({
      "tailscale-web": { port: 443 },
      "tailscale-ssh": { authKey: "tskey-x" },
    });
    // Sibling A is untouched.
    expect(api.addons).toBeUndefined();
  });

  it("removing the last add-on clears the block (undefined, not {})", () => {
    const onServicesChange = vi.fn<(s: StackServiceDefinition[]) => void>();
    renderSection({ onServicesChange });

    fireEvent.click(screen.getByLabelText("Add-ons for web"));
    fireEvent.click(screen.getByText("mock-remove"));

    const next = onServicesChange.mock.calls[0]![0];
    const web = next.find((s) => s.serviceName === "web")!;
    expect(web.addons).toBeUndefined();
  });

  it("deleting a sibling service preserves the other's addons (Part A regression)", () => {
    const onServicesChange = vi.fn<(s: StackServiceDefinition[]) => void>();
    renderSection({ onServicesChange });

    fireEvent.click(screen.getByLabelText("Delete api"));
    // Delete is now gated behind a confirm dialog (auto-save makes it instant).
    fireEvent.click(screen.getByRole("button", { name: "Delete service" }));

    const next = onServicesChange.mock.calls[0]![0];
    expect(next).toHaveLength(1);
    expect(next[0]!.serviceName).toBe("web");
    expect(next[0]!.addons).toEqual({ "tailscale-web": { port: 443 } });
  });

  it("hides the add-ons affordance when read-only but still shows the badge", () => {
    renderSection({ services: [serviceB], readOnly: true });
    expect(screen.getByText("from tailscale-web")).toBeTruthy();
    expect(screen.queryByLabelText("Add-ons for web")).toBeNull();
  });
});
