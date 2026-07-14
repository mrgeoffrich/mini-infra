import { describe, it, expect } from "vitest";
import type {
  DraftVersionInput,
  StackServiceDefinition,
} from "@mini-infra/types";
import { mergeCodeViewDraft } from "@/lib/application-draft";

/**
 * Guards the P0 item-4 data-loss fix: saving from the lossy YAML Code view must
 * NOT strip the sections the codec can't represent (top-level
 * inputs/vault/nats/requires + per-service addon/pool/binding fields). The
 * merge re-attaches them from the current draft while letting the YAML edit
 * fully own the fields it does represent.
 */

function svc(overrides: Partial<StackServiceDefinition>): StackServiceDefinition {
  return {
    serviceName: "web",
    serviceType: "StatelessWeb",
    dockerImage: "nginx",
    dockerTag: "1.25",
    containerConfig: {},
    dependsOn: [],
    order: 0,
    ...overrides,
  } as StackServiceDefinition;
}

// A "base" draft as produced by buildDraftFromVersion — carries every field.
const base: DraftVersionInput = {
  networks: [],
  volumes: [],
  services: [
    svc({
      serviceName: "web",
      addons: { "tailscale-ssh": { enabled: true } },
      poolConfig: { min: 1 } as never,
      natsRole: "publisher",
      vaultAppRoleRef: "web-approle",
    }),
  ],
  inputs: [
    { name: "API_KEY", sensitive: true, required: true, rotateOnUpgrade: false },
  ],
  vault: { policies: [], appRoles: [], kv: [] } as never,
  nats: { accounts: [] } as never,
  requires: [{ kind: "stack" }] as never,
};

// A "parsed" YAML edit — the codec only models the represented fields, so it
// drops inputs/vault/nats/requires and the per-service binding fields.
const parsedYaml: DraftVersionInput = {
  networks: [],
  volumes: [],
  services: [
    svc({ serviceName: "web", dockerTag: "1.26" }), // user bumped the tag
  ],
};

describe("mergeCodeViewDraft", () => {
  it("carries top-level inputs/vault/nats/requires through from the base draft", () => {
    const merged = mergeCodeViewDraft(base, parsedYaml);
    expect(merged.inputs).toEqual(base.inputs);
    expect(merged.vault).toEqual(base.vault);
    expect(merged.nats).toEqual(base.nats);
    expect(merged.requires).toEqual(base.requires);
  });

  it("preserves per-service unrepresented fields while applying the YAML edit", () => {
    const merged = mergeCodeViewDraft(base, parsedYaml);
    const web = merged.services.find((s) => s.serviceName === "web");
    expect(web).toBeDefined();
    // Represented field from YAML wins.
    expect(web?.dockerTag).toBe("1.26");
    // Unrepresented fields preserved from base.
    expect(web?.addons).toEqual({ "tailscale-ssh": { enabled: true } });
    expect(web?.natsRole).toBe("publisher");
    expect(web?.vaultAppRoleRef).toBe("web-approle");
    expect(web?.poolConfig).toEqual({ min: 1 });
  });

  it("deletes a service removed from the YAML", () => {
    const parsedWithoutWeb: DraftVersionInput = {
      networks: [],
      volumes: [],
      services: [svc({ serviceName: "sidecar" })],
    };
    const merged = mergeCodeViewDraft(base, parsedWithoutWeb);
    expect(merged.services.map((s) => s.serviceName)).toEqual(["sidecar"]);
  });

  it("does not resurrect preserved fields for a renamed (unmatched) service", () => {
    const parsedRenamed: DraftVersionInput = {
      networks: [],
      volumes: [],
      services: [svc({ serviceName: "web-renamed" })],
    };
    const merged = mergeCodeViewDraft(base, parsedRenamed);
    const renamed = merged.services.find((s) => s.serviceName === "web-renamed");
    expect(renamed?.addons).toBeUndefined();
    expect(renamed?.natsRole).toBeUndefined();
  });
});
