/**
 * Tests for the P1 upgrade + write-path-unification client hooks:
 *   - useUpgradeAndApplyStack: chains POST /upgrade then POST /apply, and
 *     registers a stack-apply tracked task.
 *   - useDeployApplicationUpdate (tag change): unifies the write path through
 *     the TEMPLATE — publish a new version, then upgrade + apply — instead of
 *     writing the tag directly onto the stack service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { StackTemplateVersionInfo } from "@mini-infra/types";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  ApiRequestError: class extends Error {},
}));

const mockRegisterTask = vi.fn();
vi.mock("@/hooks/use-task-tracker", () => ({
  useTaskTracker: () => ({ registerTask: mockRegisterTask, getTask: vi.fn() }),
}));

vi.mock("@/hooks/use-socket", () => ({
  useSocket: () => ({ socket: {}, connected: true }),
  useSocketChannel: vi.fn(),
  useSocketEvent: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useUpgradeAndApplyStack } from "@/hooks/use-stacks";
import { useDeployApplicationUpdate } from "@/hooks/use-applications";

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper, queryClient };
}

function calledUrls(): string[] {
  return mockApiFetch.mock.calls.map((c) => String(c[0]));
}

describe("useUpgradeAndApplyStack", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upgrades then applies and registers a stack-apply task", async () => {
    mockApiFetch.mockResolvedValue({ started: true });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpgradeAndApplyStack(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ stackId: "s1", label: "Upgrading s1" });
    });

    const urls = calledUrls();
    const upgradeIdx = urls.findIndex((u) => u.endsWith("/stacks/s1/upgrade"));
    const applyIdx = urls.findIndex((u) => u.endsWith("/stacks/s1/apply"));
    expect(upgradeIdx).toBeGreaterThanOrEqual(0);
    expect(applyIdx).toBeGreaterThan(upgradeIdx);
    expect(mockRegisterTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1", type: "stack-apply" }),
    );
  });
});

describe("useDeployApplicationUpdate — tag change unifies through the template", () => {
  beforeEach(() => vi.clearAllMocks());

  const version: StackTemplateVersionInfo = {
    id: "v1",
    templateId: "tpl-1",
    version: 1,
    status: "published",
    notes: null,
    parameters: [],
    defaultParameterValues: {},
    networkTypeDefaults: {},
    networks: [],
    volumes: [],
    publishedAt: null,
    createdAt: new Date().toISOString(),
    createdById: null,
    services: [
      {
        id: "svc-1",
        versionId: "v1",
        serviceName: "web",
        serviceType: "StatelessWeb",
        dockerImage: "nginx",
        dockerTag: "1.0",
        containerConfig: {},
        initCommands: null,
        dependsOn: [],
        order: 0,
        routing: null,
        adoptedContainer: null,
        poolConfig: null,
        jobPoolConfig: null,
        vaultAppRoleId: null,
        vaultAppRoleRef: null,
        natsCredentialId: null,
        natsCredentialRef: null,
        natsRole: null,
        natsSigner: null,
        addons: null,
      },
    ],
    configFiles: [],
  } as unknown as StackTemplateVersionInfo;

  it("publishes a new version, then upgrades + applies (no direct stack-service write)", async () => {
    mockApiFetch.mockImplementation((url: string) => {
      // fetchApplication → GET /stack-templates/tpl-1 (bare, no sub-path)
      if (/\/stack-templates\/tpl-1$/.test(url)) {
        return Promise.resolve({
          success: true,
          data: { id: "tpl-1", name: "app", currentVersion: version },
        });
      }
      return Promise.resolve({ started: true });
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeployApplicationUpdate(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        stackId: "s1",
        templateId: "tpl-1",
        serviceName: "web",
        newTag: "2.0",
        currentTag: "1.0",
        stackStatus: "synced",
      });
    });

    const urls = calledUrls();
    // Went through the template: draft + publish, then upgrade + apply.
    expect(urls.some((u) => u.endsWith("/stack-templates/tpl-1/draft"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/stack-templates/tpl-1/publish"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/stacks/s1/upgrade"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/stacks/s1/apply"))).toBe(true);
    // Did NOT write the tag directly onto the stack service.
    expect(urls.some((u) => u.includes("/services/"))).toBe(false);

    // The published draft carries the new tag on the target service.
    const draftCall = mockApiFetch.mock.calls.find((c) =>
      String(c[0]).endsWith("/stack-templates/tpl-1/draft"),
    );
    const body = (draftCall?.[1] as { body?: { services?: Array<{ serviceName: string; dockerTag: string }> } })?.body;
    const web = body?.services?.find((s) => s.serviceName === "web");
    expect(web?.dockerTag).toBe("2.0");
  });
});
