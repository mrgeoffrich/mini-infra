/**
 * Unit test: a template referencing an unknown predicate name fails at
 * file-load (Zod parse) time, surfacing a clear error mentioning the
 * typo and the set of known predicate names. This is the load-time
 * gate that keeps `syncBuiltinStacks` honest — typos in production
 * templates are caught before any apply runs.
 */
import { describe, it, expect } from "vitest";
import {
  loadTemplateFromObject,
  TemplateFileError,
} from "../../template-file-loader";

const baseTemplate = {
  name: "predicate-load-test",
  displayName: "Predicate Load Test",
  builtinVersion: 1,
  scope: "host" as const,
  networks: [],
  volumes: [],
  services: [
    {
      serviceName: "web",
      serviceType: "Stateful" as const,
      dockerImage: "nginx",
      dockerTag: "latest",
      containerConfig: {},
      dependsOn: [],
      order: 0,
    },
  ],
};

describe("template file-loader — predicate registry validation", () => {
  it("accepts a known predicate name", () => {
    const tpl = loadTemplateFromObject({
      ...baseTemplate,
      requires: [{ kind: "predicate", name: "vault-bootstrapped" }],
    });
    expect(tpl.requires).toEqual([{ kind: "predicate", name: "vault-bootstrapped" }]);
  });

  it("rejects an unknown predicate name with a clear error", () => {
    expect(() =>
      loadTemplateFromObject({
        ...baseTemplate,
        requires: [{ kind: "predicate", name: "vault-boostraped" }], // typo
      }),
    ).toThrow(TemplateFileError);

    try {
      loadTemplateFromObject({
        ...baseTemplate,
        requires: [{ kind: "predicate", name: "vault-boostraped" }],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateFileError);
      const msg = (e as Error).message;
      expect(msg).toContain("Unknown predicate");
      expect(msg).toContain("vault-boostraped");
      expect(msg).toContain("'vault-bootstrapped'"); // listed as known
    }
  });

  it("accepts a stack-kind requirement", () => {
    const tpl = loadTemplateFromObject({
      ...baseTemplate,
      requires: [
        {
          kind: "stack",
          templateName: "vault",
          minState: "synced",
          scopeMatch: "host",
        },
      ],
    });
    expect(tpl.requires).toHaveLength(1);
  });

  it("rejects a stack-kind requirement with an invalid minState", () => {
    expect(() =>
      loadTemplateFromObject({
        ...baseTemplate,
        requires: [
          {
            kind: "stack",
            templateName: "vault",
            minState: "error", // not in the enum
            scopeMatch: "host",
          },
        ],
      }),
    ).toThrow(/validation failed/i);
  });

  it("rejects a stack-kind requirement with an invalid scopeMatch", () => {
    expect(() =>
      loadTemplateFromObject({
        ...baseTemplate,
        requires: [
          {
            kind: "stack",
            templateName: "vault",
            minState: "synced",
            scopeMatch: "global", // not in the enum
          },
        ],
      }),
    ).toThrow(/validation failed/i);
  });

  it("treats omitted requires as undefined", () => {
    const tpl = loadTemplateFromObject(baseTemplate);
    expect(tpl.requires).toBeUndefined();
  });

  it("accepts an explicit empty requires array", () => {
    const tpl = loadTemplateFromObject({ ...baseTemplate, requires: [] });
    expect(tpl.requires).toEqual([]);
  });
});
