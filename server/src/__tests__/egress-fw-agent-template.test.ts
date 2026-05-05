/**
 * Validates the egress-fw-agent stack template (ALT-27).
 *
 * Pinches: schema valid as-loaded, host-network combination guards work
 * (catches a regression where someone re-adds a port or `joinNetworks` to
 * the template), KV bucket declaration on the role works.
 *
 * Pinned with the template *literal*, not the file on disk — a future
 * refactor of the disk layout shouldn't have to chase down this test.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { stackContainerConfigSchema } from "../services/stacks/schemas";
import { templateNatsRoleSchema } from "../services/stacks/stack-template-schemas";

describe("egress-fw-agent template", () => {
  it("template.json on disk parses (top-level shape)", () => {
    const file = path.resolve(__dirname, "../../templates/egress-fw-agent/template.json");
    const json = JSON.parse(fs.readFileSync(file, "utf-8"));

    expect(json.name).toBe("egress-fw-agent");
    expect(json.scope).toBe("host");
    expect(json.category).toBe("infrastructure");
    expect(json.builtinVersion).toBe(2);

    // The agent role declares the KV bucket Phase 2 needs.
    expect(json.nats.subjectPrefix).toBe("mini-infra.egress.fw");
    const role = json.nats.roles.find((r: { name: string }) => r.name === "agent");
    expect(role).toBeDefined();
    expect(role.kvBuckets).toEqual(["egress-fw-health"]);
    // `health` is NOT in publish — heartbeats go through KV (see kvBuckets)
    // not via a subject publish on `mini-infra.egress.fw.health`.
    expect(role.publish).toEqual(["rules.applied", "events"]);
    expect(role.subscribe).toEqual(["rules.apply"]);

    // Host networking + privileged caps are the whole reason this template
    // exists (vs being a regular bridge-mode stack).
    const svc = json.services[0];
    expect(svc.containerConfig.networkMode).toBe("host");
    expect(svc.containerConfig.capAdd).toEqual(["NET_ADMIN", "NET_RAW"]);
    expect(svc.natsRole).toBe("agent");
    expect(svc.containerConfig.dynamicEnv.NATS_URL).toEqual({ kind: "nats-url" });
    expect(svc.containerConfig.dynamicEnv.NATS_CREDS).toEqual({ kind: "nats-creds" });

    // Phase 2 acceptance: no Unix socket mount on the template.
    const mountTargets = (svc.containerConfig.mounts ?? []).map((m: { target: string }) => m.target);
    expect(mountTargets).not.toContain("/var/run/mini-infra");
  });

  it("the role validates against templateNatsRoleSchema", () => {
    const role = {
      name: "agent",
      publish: ["rules.applied", "events"],
      subscribe: ["rules.apply"],
      kvBuckets: ["egress-fw-health"],
      inboxAuto: "reply",
    };
    expect(() => templateNatsRoleSchema.parse(role)).not.toThrow();
  });

  it("the containerConfig validates against stackContainerConfigSchema", () => {
    const cfg = {
      networkMode: "host",
      capAdd: ["NET_ADMIN", "NET_RAW"],
      egressBypass: true,
      env: { LOG_LEVEL: "info" },
      dynamicEnv: {
        NATS_URL: { kind: "nats-url" },
        NATS_CREDS: { kind: "nats-creds" },
      },
      mounts: [{ source: "/lib/modules", target: "/lib/modules", type: "bind", readOnly: true }],
      labels: { "mini-infra.egress.fw-agent": "true" },
      restartPolicy: "unless-stopped",
      logConfig: { type: "json-file", maxSize: "10m", maxFile: "3" },
    };
    expect(() => stackContainerConfigSchema.parse(cfg)).not.toThrow();
  });
});

describe("networkMode=host validation guards", () => {
  it("rejects ports + host mode", () => {
    const result = stackContainerConfigSchema.safeParse({
      networkMode: "host",
      ports: [{ containerPort: 80, hostPort: 80, protocol: "tcp" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(" | ");
      expect(msg).toContain("host");
      expect(msg).toContain("ports");
    }
  });

  it("rejects joinNetworks + host mode", () => {
    const result = stackContainerConfigSchema.safeParse({
      networkMode: "host",
      joinNetworks: ["my-net"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects joinResourceNetworks + host mode", () => {
    const result = stackContainerConfigSchema.safeParse({
      networkMode: "host",
      joinResourceNetworks: ["nats"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts bridge mode with ports + joins (the common case)", () => {
    const result = stackContainerConfigSchema.safeParse({
      networkMode: "bridge",
      ports: [{ containerPort: 80, hostPort: 80, protocol: "tcp" }],
      joinResourceNetworks: ["nats"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts host mode with capAdd + bind mounts + egressBypass (the fw-agent case)", () => {
    const result = stackContainerConfigSchema.safeParse({
      networkMode: "host",
      egressBypass: true,
      capAdd: ["NET_ADMIN", "NET_RAW"],
      mounts: [{ source: "/lib/modules", target: "/lib/modules", type: "bind", readOnly: true }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects host mode without egressBypass=true", () => {
    const result = stackContainerConfigSchema.safeParse({
      networkMode: "host",
      capAdd: ["NET_ADMIN"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(" | ");
      expect(msg).toContain("egressBypass");
    }
  });
});

describe("templateNatsRoleSchema kvBuckets", () => {
  it("accepts a valid bucket name", () => {
    const result = templateNatsRoleSchema.safeParse({
      name: "agent",
      kvBuckets: ["egress-fw-health"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects bucket names with dots or wildcards", () => {
    expect(
      templateNatsRoleSchema.safeParse({ name: "r", kvBuckets: ["a.b"] }).success,
    ).toBe(false);
    expect(
      templateNatsRoleSchema.safeParse({ name: "r", kvBuckets: ["a.>"] }).success,
    ).toBe(false);
    expect(
      templateNatsRoleSchema.safeParse({ name: "r", kvBuckets: [""] }).success,
    ).toBe(false);
  });
});
