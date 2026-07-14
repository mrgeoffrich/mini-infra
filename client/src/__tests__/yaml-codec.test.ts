import { describe, it, expect } from "vitest";
import type { StackTemplateVersionInfo } from "@mini-infra/types";
import {
  serializeVersionToYaml,
  parseYamlToDraft,
} from "@/components/stack-templates/code-view/yaml-codec";
import { buildDraftFromVersion } from "@/lib/application-draft";

/**
 * The Code view's codec must be LOSSLESS (P4 4.3).
 *
 * It used to drop the top-level `inputs`/`vault`/`nats`/`requires` sections and
 * every per-service binding (`addons`, `poolConfig`, `natsRole`, the vault/nats
 * refs). A merge-shim re-attached them after every save, which meant the Code
 * view showed you *most* of a template, saved *some* of your edits, and could
 * never express a deletion — anything you removed came straight back.
 *
 * These tests replace the old `application-draft-merge` suite, whose entire
 * premise (that the codec is lossy and a merge compensates) is now false. The
 * property they assert is strictly stronger: serialize → parse returns the same
 * document, so the YAML genuinely IS the template.
 */

/** A version exercising every section the codec used to drop. */
const version = {
  id: "v1",
  templateId: "t1",
  version: 1,
  status: "draft",
  notes: "everything, everywhere",
  parameters: [{ name: "replicas", type: "number", required: false }],
  defaultParameterValues: { replicas: 2 },
  networkTypeDefaults: {},
  resourceOutputs: [],
  resourceInputs: [],
  networks: [{ name: "app", driver: "bridge" }],
  volumes: [{ name: "data" }],
  publishedAt: null,
  createdAt: "2026-07-15T00:00:00.000Z",
  createdById: null,
  services: [
    {
      id: "s1",
      versionId: "v1",
      serviceName: "web",
      serviceType: "StatelessWeb",
      dockerImage: "nginx",
      dockerTag: "1.25",
      containerConfig: { healthcheck: { interval: 30000 } },
      dependsOn: [],
      order: 0,
      // The per-service bindings the codec silently dropped.
      addons: { "tailscale-ssh": { enabled: true } },
      natsRole: "publisher",
      vaultAppRoleRef: "web-approle",
    },
  ],
  configFiles: [],
  inputs: [{ name: "apiKey", sensitive: true, required: true, rotateOnUpgrade: true }],
  requires: [
    { kind: "predicate", name: "vault-bootstrapped" },
    { kind: "stack", templateName: "vault", minState: "synced", scopeMatch: "host" },
  ],
  vault: {
    policies: [{ name: "web", body: "path \"kv/*\" { capabilities = [\"read\"] }", scope: "stack" }],
  },
  nats: {
    subjectPrefix: "app.web",
    roles: [
      {
        name: "publisher",
        publish: ["events.>"],
        streams: [
          {
            name: "events",
            subjects: ["events.>"],
            // A NULLABLE JetStream limit. `null` here means "no limit" and is a
            // different thing from an absent key, which means "use the default".
            maxBytes: null,
          },
        ],
      },
    ],
  },
} as unknown as StackTemplateVersionInfo;

describe("yaml codec — losslessness", () => {
  it("round-trips every section, including the ones it used to drop", () => {
    const parsed = parseYamlToDraft(serializeVersionToYaml(version));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // The four top-level sections the codec never emitted.
    expect(parsed.value.inputs).toEqual(version.inputs);
    expect(parsed.value.requires).toEqual(version.requires);
    expect(parsed.value.vault).toEqual(version.vault);
    expect(parsed.value.nats).toEqual(version.nats);

    // ...and the per-service bindings it dropped from every service.
    const web = parsed.value.services[0];
    expect(web.addons).toEqual({ "tailscale-ssh": { enabled: true } });
    expect(web.natsRole).toBe("publisher");
    expect(web.vaultAppRoleRef).toBe("web-approle");
  });

  it("preserves an explicit null on a nullable NATS limit", () => {
    // buildDraftFromVersion strips nulls (the read model returns null for absent
    // optionals, which the draft Zod rejects) — but the NATS schema is `.nullable()`
    // here, so a null is a real value. Stripping it would quietly rewrite the
    // author's "no limit" into "use the default".
    const yaml = serializeVersionToYaml(version);
    expect(yaml).toContain("maxBytes: null");

    const parsed = parseYamlToDraft(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const stream = (parsed.value.nats as never as { roles: { streams: { maxBytes: unknown }[] }[] })
      .roles[0].streams[0];
    expect(stream.maxBytes).toBeNull();
  });

  it("keeps buildDraftFromVersion and the codec in agreement", () => {
    // Both must produce the same document, or the Code view and the graphical
    // editor would save different things from the same template.
    const fromCodec = parseYamlToDraft(serializeVersionToYaml(version));
    const fromBuilder = buildDraftFromVersion(version);
    expect(fromCodec.ok).toBe(true);
    if (!fromCodec.ok) return;

    expect(fromCodec.value.inputs).toEqual(fromBuilder.inputs);
    expect(fromCodec.value.vault).toEqual(fromBuilder.vault);
    expect(fromCodec.value.nats).toEqual(fromBuilder.nats);
    expect(fromCodec.value.requires).toEqual(fromBuilder.requires);
    expect(fromCodec.value.services).toEqual(fromBuilder.services);
  });

  it("lets the YAML delete a section", () => {
    // The whole point of dropping the merge-shim. Previously a section removed
    // in the editor was re-attached from the current version on save, so a
    // deletion was impossible to express.
    const yaml = serializeVersionToYaml(version);
    const withoutVault = yaml
      .split("\n")
      .filter((_, i, lines) => {
        // crude but sufficient: drop the `vault:` block
        const start = lines.findIndex((l) => l.startsWith("vault:"));
        const end = lines.findIndex((l, j) => j > start && /^\S/.test(l));
        return start === -1 || i < start || (end !== -1 && i >= end);
      })
      .join("\n");

    const parsed = parseYamlToDraft(withoutVault);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.vault).toBeUndefined();
  });
});
