import { describe, it, expect } from "vitest";
import {
  buildTemplateExportDocument,
  mapTemplateImportDocument,
  TEMPLATE_EXPORT_FORMAT,
  REDACTED_SECRET_PLACEHOLDER,
  DEFAULT_NATS_SUBJECT_PREFIX_TEMPLATE,
  type StackTemplateVersionInfo,
  type StackTemplateServiceInfo,
  type TemplateExportEnvelope,
} from "@mini-infra/types";

/**
 * The build/map functions are the pure core of export/import. These pin the two
 * things that must be exactly right — secrets are redacted (and reported), and
 * the source-instance caveats (scope coercion, NATS-prefix allowlist) are raised
 * — plus the promise, shared with the Compose importer, that nothing is dropped
 * in silence.
 */

const service: StackTemplateServiceInfo = {
  id: "svc1",
  versionId: "v1",
  serviceName: "web",
  serviceType: "Stateful",
  dockerImage: "nginx",
  dockerTag: "1.25",
  containerConfig: { joinNetworks: ["app-net"] },
  initCommands: null,
  dependsOn: [],
  order: 0,
  routing: null,
};

function makeVersion(
  overrides: Partial<StackTemplateVersionInfo> = {},
): StackTemplateVersionInfo {
  return {
    id: "v1",
    templateId: "t1",
    version: 3,
    status: "published",
    notes: "release notes",
    parameters: [],
    defaultParameterValues: {},
    networks: [{ name: "app-net" }],
    volumes: [{ name: "data" }],
    publishedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdById: null,
    services: [service],
    ...overrides,
  };
}

const envelope: TemplateExportEnvelope = {
  name: "my-app",
  displayName: "My App",
  description: "does things",
  category: "web",
  scope: "environment",
  networkType: "internet",
};

describe("buildTemplateExportDocument", () => {
  it("wraps the version body in an envelope with the current format tag", () => {
    const { document } = buildTemplateExportDocument({
      template: envelope,
      version: makeVersion(),
    });

    expect(document.format).toBe(TEMPLATE_EXPORT_FORMAT);
    expect(document.template).toEqual(envelope);
    expect(document.sourceVersion).toBe(3);
    expect(document.version.services?.[0]?.serviceName).toBe("web");
    expect(document.version.networks).toEqual([{ name: "app-net" }]);
    // exportedAt is stamped by the caller; omitted here → absent (deterministic).
    expect(document.exportedAt).toBeUndefined();
  });

  it("stamps exportedAt when provided", () => {
    const { document } = buildTemplateExportDocument({
      template: envelope,
      version: makeVersion(),
      exportedAt: "2026-07-15T00:00:00.000Z",
    });
    expect(document.exportedAt).toBe("2026-07-15T00:00:00.000Z");
  });

  it("redacts literal vault secrets and reports each one, but keeps fromInput refs", () => {
    const { document, issues } = buildTemplateExportDocument({
      template: envelope,
      version: makeVersion({
        vault: {
          kv: [
            {
              path: "app/db",
              fields: {
                PASSWORD: { value: "hunter2" },
                USERNAME: { fromInput: "dbUser" },
              },
            },
          ],
        },
      }),
    });

    const kv = document.version.vault?.kv?.[0];
    expect(kv?.fields.PASSWORD).toEqual({ value: REDACTED_SECRET_PLACEHOLDER });
    // A fromInput reference carries no secret and must survive untouched.
    expect(kv?.fields.USERNAME).toEqual({ fromInput: "dbUser" });

    const redaction = issues.find((i) => i.path.includes("PASSWORD"));
    expect(redaction?.level).toBe("lossy");
    expect(issues.some((i) => i.path.includes("USERNAME"))).toBe(false);
  });

  it("does not touch a version without a vault section", () => {
    const { issues } = buildTemplateExportDocument({
      template: envelope,
      version: makeVersion(),
    });
    expect(issues).toHaveLength(0);
  });
});

describe("mapTemplateImportDocument", () => {
  function exportThenDoc(version: StackTemplateVersionInfo, env = envelope) {
    return buildTemplateExportDocument({ template: env, version }).document;
  }

  it("maps a well-formed document into a create request", () => {
    const result = mapTemplateImportDocument(exportThenDoc(makeVersion()));

    expect(result.ok).toBe(true);
    expect(result.request?.name).toBe("my-app");
    expect(result.request?.displayName).toBe("My App");
    expect(result.request?.scope).toBe("environment");
    expect(result.request?.description).toBe("does things");
    expect(result.request?.category).toBe("web");
    expect(result.request?.services?.[0]?.serviceName).toBe("web");
    expect(result.request?.networks).toEqual([{ name: "app-net" }]);
    expect(result.request?.volumes).toEqual([{ name: "data" }]);
    // No `source` on the request — createUserTemplate forces "user".
    expect((result.request as Record<string, unknown>).source).toBeUndefined();
  });

  it("rejects a non-export object with a blocking format error", () => {
    const result = mapTemplateImportDocument({ hello: "world" });
    expect(result.ok).toBe(false);
    expect(result.request).toBeNull();
    expect(result.issues.some((i) => i.level === "error" && i.path === "format")).toBe(true);
  });

  it("rejects an unknown format version", () => {
    const doc = exportThenDoc(makeVersion());
    const result = mapTemplateImportDocument({ ...doc, format: "mini-infra.stack-template/v99" });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === "format")).toBe(true);
  });

  it("blocks a document missing its template name", () => {
    const doc = exportThenDoc(makeVersion());
    const result = mapTemplateImportDocument({
      ...doc,
      template: { ...doc.template, name: "" },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === "template.name")).toBe(true);
  });

  it("coerces scope 'any' to environment and reports it", () => {
    const doc = exportThenDoc(makeVersion());
    const result = mapTemplateImportDocument({
      ...doc,
      template: { ...doc.template, scope: "any" },
    });
    expect(result.ok).toBe(true);
    expect(result.request?.scope).toBe("environment");
    expect(result.issues.some((i) => i.level === "defaulted" && i.path === "template.scope")).toBe(true);
  });

  it("warns about a custom NATS subject prefix (allowlist is keyed by template id)", () => {
    const doc = exportThenDoc(
      makeVersion({ nats: { subjectPrefix: "events.custom" } }),
    );
    const result = mapTemplateImportDocument(doc);
    expect(result.ok).toBe(true);
    const warn = result.issues.find((i) => i.path === "version.nats.subjectPrefix");
    expect(warn?.level).toBe("lossy");
  });

  it("does NOT warn for the default subject prefix", () => {
    const doc = exportThenDoc(
      makeVersion({ nats: { subjectPrefix: DEFAULT_NATS_SUBJECT_PREFIX_TEMPLATE } }),
    );
    const result = mapTemplateImportDocument(doc);
    expect(result.issues.some((i) => i.path === "version.nats.subjectPrefix")).toBe(false);
  });

  it("flags redacted secrets left in the file so the user refills them", () => {
    const doc = exportThenDoc(
      makeVersion({
        vault: { kv: [{ path: "app/db", fields: { PASSWORD: { value: "hunter2" } } }] },
      }),
    );
    // The export already replaced the value with the placeholder; import detects it.
    const result = mapTemplateImportDocument(doc);
    expect(result.ok).toBe(true);
    const notice = result.issues.find(
      (i) => i.level === "lossy" && i.path.includes("PASSWORD"),
    );
    expect(notice).toBeTruthy();
  });
});
