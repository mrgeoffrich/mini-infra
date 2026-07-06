import { describe, it, expect } from "vitest";
import type { StackTemplateVersionInfo } from "@mini-infra/types";
import { buildDraftFromVersion } from "@/lib/application-draft";

function makeVersion(): StackTemplateVersionInfo {
  return {
    id: "ver-1",
    templateId: "tmpl-1",
    version: 3,
    status: "published",
    notes: "release notes",
    parameters: [],
    defaultParameterValues: {},
    // The read model returns `null` (not absent) for unset optional fields —
    // the create/draft schema rejects null, so these must be stripped.
    networkTypeDefaults: null as unknown as StackTemplateVersionInfo["networkTypeDefaults"],
    resourceInputs: [{ type: "docker-network", purpose: "applications" }],
    resourceOutputs: [{ type: "docker-network", purpose: "shared" }],
    networks: [{ name: "myapp-net" }],
    volumes: [{ name: "data" }],
    publishedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdById: "user-1",
    inputs: null as unknown as StackTemplateVersionInfo["inputs"],
    vault: null as unknown as StackTemplateVersionInfo["vault"],
    nats: null as unknown as StackTemplateVersionInfo["nats"],
    requires: null as unknown as StackTemplateVersionInfo["requires"],
    services: [
      {
        id: "svc-1",
        versionId: "ver-1",
        serviceName: "web",
        serviceType: "StatelessWeb",
        dockerImage: "nginx",
        dockerTag: "latest",
        containerConfig: { joinNetworks: ["local-db"], env: { FOO: "bar" } },
        initCommands: null,
        dependsOn: [],
        order: 0,
        routing: null,
        // Real-world read-model nulls on unset optional service fields.
        poolConfig: null,
        jobPoolConfig: null,
        addons: null,
        natsCredentialRef: null,
        natsRole: null,
        natsSigner: null,
        vaultAppRoleRef: "my-approle",
      },
    ],
    configFiles: [
      {
        id: "cf-1",
        versionId: "ver-1",
        serviceName: "web",
        fileName: "nginx.conf",
        volumeName: "conf",
        mountPath: "/etc/nginx/nginx.conf",
        content: "server {}",
        permissions: null,
        owner: null,
      },
    ],
  };
}

describe("buildDraftFromVersion", () => {
  it("preserves every version-level field so a republish is lossless", () => {
    const version = makeVersion();
    const draft = buildDraftFromVersion(version);

    expect(draft.resourceInputs).toEqual([
      { type: "docker-network", purpose: "applications" },
    ]);
    expect(draft.resourceOutputs).toEqual([
      { type: "docker-network", purpose: "shared" },
    ]);
    expect(draft.networks).toEqual([{ name: "myapp-net" }]);
    expect(draft.volumes).toEqual([{ name: "data" }]);
    expect(draft.notes).toBe("release notes");
  });

  it("strips read-model nulls so the draft schema's .optional() fields accept it", () => {
    const draft = buildDraftFromVersion(makeVersion());

    // Deep scan: no property anywhere may be null (the draft schema rejects it).
    const findNullPath = (value: unknown, path = "$"): string | null => {
      if (value === null) return path;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const hit = findNullPath(value[i], `${path}[${i}]`);
          if (hit) return hit;
        }
        return null;
      }
      if (typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          const hit = findNullPath(v, `${path}.${k}`);
          if (hit) return hit;
        }
      }
      return null;
    };

    expect(findNullPath(draft)).toBeNull();
    // Nulled optionals become absent, not null.
    expect(draft.vault).toBeUndefined();
    expect(draft.services[0].jobPoolConfig).toBeUndefined();
    expect(draft.services[0].natsRole).toBeUndefined();
    // Non-null values are preserved through the strip.
    expect(draft.services[0].vaultAppRoleRef).toBe("my-approle");
    expect(draft.resourceInputs).toEqual([
      { type: "docker-network", purpose: "applications" },
    ]);
  });

  it("maps service fields and keeps joinNetworks + symbolic refs", () => {
    const draft = buildDraftFromVersion(makeVersion());
    const svc = draft.services[0];

    expect(svc.serviceName).toBe("web");
    expect(svc.containerConfig.joinNetworks).toEqual(["local-db"]);
    expect(svc.containerConfig.env).toEqual({ FOO: "bar" });
    expect(svc.vaultAppRoleRef).toBe("my-approle");
    // null on optional-non-nullable fields is normalized to undefined.
    expect(svc.routing).toBeUndefined();
    expect(svc.initCommands).toBeUndefined();
  });

  it("drops DB-only config-file fields and normalizes null permissions/owner", () => {
    const draft = buildDraftFromVersion(makeVersion());
    const cf = draft.configFiles?.[0];

    expect(cf).toBeDefined();
    expect(cf).not.toHaveProperty("id");
    expect(cf).not.toHaveProperty("versionId");
    expect(cf?.permissions).toBeUndefined();
    expect(cf?.owner).toBeUndefined();
  });

  it("mutating joinNetworks (as the card does) does not disturb other fields", () => {
    const version = makeVersion();
    const draft = buildDraftFromVersion(version);

    // Simulate the Connected Networks card appending a network.
    draft.services[0] = {
      ...draft.services[0],
      containerConfig: {
        ...draft.services[0].containerConfig,
        joinNetworks: ["local-db", "extra-net"],
      },
    };

    expect(draft.services[0].containerConfig.joinNetworks).toEqual([
      "local-db",
      "extra-net",
    ]);
    // resourceInputs and env survive the targeted mutation.
    expect(draft.resourceInputs).toEqual([
      { type: "docker-network", purpose: "applications" },
    ]);
    expect(draft.services[0].containerConfig.env).toEqual({ FOO: "bar" });
  });
});
