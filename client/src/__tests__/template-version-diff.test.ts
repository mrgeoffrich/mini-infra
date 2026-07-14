/**
 * Unit tests for computeTemplateVersionDiff (P2 template-version UX): the
 * client-side diff that powers the template detail "compare with previous" view
 * and the publish dialog's "what changed" summary.
 */
import { describe, it, expect } from "vitest";
import { computeTemplateVersionDiff } from "@/lib/template-version-diff";
import type {
  StackTemplateServiceInfo,
  StackTemplateVersionInfo,
} from "@mini-infra/types";

function makeService(
  overrides: Partial<StackTemplateServiceInfo> & { serviceName: string },
): StackTemplateServiceInfo {
  return {
    id: `svc-${overrides.serviceName}`,
    versionId: "v",
    serviceType: "Stateful",
    dockerImage: "nginx",
    dockerTag: "1.0",
    containerConfig: {},
    initCommands: null,
    dependsOn: [],
    order: 0,
    routing: null,
    ...overrides,
  } as StackTemplateServiceInfo;
}

function makeVersion(
  version: number,
  services: StackTemplateServiceInfo[],
  overrides: Partial<StackTemplateVersionInfo> = {},
): StackTemplateVersionInfo {
  return {
    id: `ver-${version}`,
    templateId: "tpl",
    version,
    status: "published",
    notes: null,
    parameters: [],
    defaultParameterValues: {},
    networks: [],
    volumes: [],
    publishedAt: null,
    createdAt: new Date().toISOString(),
    createdById: null,
    services,
    ...overrides,
  } as StackTemplateVersionInfo;
}

describe("computeTemplateVersionDiff", () => {
  it("detects added, removed, and changed services", () => {
    const from = makeVersion(1, [
      makeService({ serviceName: "web", dockerTag: "1.0" }),
      makeService({ serviceName: "old", dockerTag: "1.0" }),
    ]);
    const to = makeVersion(2, [
      makeService({ serviceName: "web", dockerTag: "2.0" }), // changed
      makeService({ serviceName: "worker", dockerTag: "1.0" }), // added
      // "old" removed
    ]);

    const diff = computeTemplateVersionDiff(from, to);
    expect(diff.hasChanges).toBe(true);
    expect(diff.servicesAdded).toEqual(["worker"]);
    expect(diff.servicesRemoved).toEqual(["old"]);
    expect(diff.servicesChanged.map((c) => c.serviceName)).toEqual(["web"]);

    const webChange = diff.servicesChanged[0]!;
    const tagField = webChange.fields.find((f) => f.field === "dockerTag");
    expect(tagField?.old).toBe(JSON.stringify("1.0"));
    expect(tagField?.new).toBe(JSON.stringify("2.0"));
  });

  it("detects template-level (meta) changes", () => {
    const from = makeVersion(1, [makeService({ serviceName: "web" })], {
      parameters: [{ name: "replicas", type: "number", default: 1, required: false }],
    });
    const to = makeVersion(2, [makeService({ serviceName: "web" })], {
      parameters: [{ name: "replicas", type: "number", default: 3, required: false }],
    });

    const diff = computeTemplateVersionDiff(from, to);
    expect(diff.hasChanges).toBe(true);
    expect(diff.servicesChanged).toHaveLength(0);
    expect(diff.meta.map((m) => m.field)).toContain("parameters");
  });

  it("reports no changes for identical versions (key order independent)", () => {
    const from = makeVersion(1, [
      makeService({
        serviceName: "web",
        containerConfig: { env: { A: "1", B: "2" } } as never,
      }),
    ]);
    const to = makeVersion(2, [
      makeService({
        serviceName: "web",
        // Same content, different key order — must not read as a change.
        containerConfig: { env: { B: "2", A: "1" } } as never,
      }),
    ]);

    const diff = computeTemplateVersionDiff(from, to);
    expect(diff.hasChanges).toBe(false);
    expect(diff.servicesChanged).toHaveLength(0);
    expect(diff.meta).toHaveLength(0);
  });

  it("returns an empty diff when either side is missing", () => {
    const v = makeVersion(1, [makeService({ serviceName: "web" })]);
    expect(computeTemplateVersionDiff(null, v).hasChanges).toBe(false);
    expect(computeTemplateVersionDiff(v, undefined).hasChanges).toBe(false);
  });
});
