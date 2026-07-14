import { describe, it, expect } from "vitest";
import * as yaml from "js-yaml";
import {
  mapComposeToTemplate,
  parseComposeDuration,
  splitImageRef,
  type ComposeImportResult,
} from "@mini-infra/types";

/**
 * The parsing is trivial; the *mapping* is the work. Compose is a much larger
 * surface than a stack template, so these pin the two things that matter:
 * translations that must be exactly right (ports, durations, image refs), and
 * the promise that nothing is dropped in silence.
 */
function importYaml(text: string): ComposeImportResult {
  return mapComposeToTemplate(yaml.load(text));
}

const issueAt = (r: ComposeImportResult, path: string) =>
  r.issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`));

describe("splitImageRef", () => {
  it.each([
    ["nginx", { image: "nginx", tag: "latest" }],
    ["nginx:1.25", { image: "nginx", tag: "1.25" }],
    ["ghcr.io/org/app:v2", { image: "ghcr.io/org/app", tag: "v2" }],
    // The colon is ambiguous — a registry port is not a tag.
    ["localhost:5000/app", { image: "localhost:5000/app", tag: "latest" }],
    ["localhost:5000/app:1.2", { image: "localhost:5000/app", tag: "1.2" }],
    // Digest-pinned: the digest is the identity, so it must survive.
    [
      "app@sha256:abc123",
      { image: "app", tag: "sha256:abc123" },
    ],
  ])("splits %s", (ref, expected) => {
    expect(splitImageRef(ref as string)).toEqual(expected);
  });
});

describe("parseComposeDuration", () => {
  it.each([
    ["30s", 30_000],
    ["1m30s", 90_000],
    ["500ms", 500],
    ["2h", 7_200_000],
    ["10", 10_000], // bare string = seconds, per Compose
    [10, 10_000], // bare number = seconds
  ])("parses %s to %ims", (input, expected) => {
    expect(parseComposeDuration(input)).toBe(expected);
  });

  it("returns null for nonsense", () => {
    expect(parseComposeDuration("banana")).toBeNull();
  });
});

describe("mapComposeToTemplate", () => {
  it("maps a straightforward file end to end", () => {
    const r = importYaml(`
services:
  web:
    image: nginx:1.25
    ports:
      - "8080:80"
    environment:
      LOG_LEVEL: debug
    restart: unless-stopped
    volumes:
      - assets:/usr/share/nginx/html
volumes:
  assets:
`);

    expect(r.ok).toBe(true);
    const web = r.draft!.services[0];
    expect(web.serviceName).toBe("web");
    // Compose's single `image:` string is a split pair here.
    expect(web.dockerImage).toBe("nginx");
    expect(web.dockerTag).toBe("1.25");
    // "8080:80" is a structured object, not a string.
    expect(web.containerConfig.ports).toEqual([
      { containerPort: 80, hostPort: 8080, protocol: "tcp", exposeOnHost: true },
    ]);
    expect(web.containerConfig.env).toEqual({ LOG_LEVEL: "debug" });
    expect(web.containerConfig.restartPolicy).toBe("unless-stopped");
    expect(web.containerConfig.mounts).toEqual([
      { source: "assets", target: "/usr/share/nginx/html", type: "volume", readOnly: false },
    ]);
    expect(r.draft!.volumes).toEqual([{ name: "assets" }]);
  });

  it("always imports as Stateful — Compose cannot express routing", () => {
    // StatelessWeb *requires* routing. Guessing it from a published port would
    // fabricate HAProxy config the file never asked for.
    const r = importYaml(`
services:
  web:
    image: nginx
    ports: ["80:80"]
`);
    expect(r.draft!.services[0].serviceType).toBe("Stateful");
  });

  it("converts healthcheck durations to milliseconds, not seconds", () => {
    // The stored unit is ms (see healthcheckToDocker). Getting this wrong is
    // exactly the bug P3 fixed: a 30s interval stored as 30 became 30,000s.
    const r = importYaml(`
services:
  api:
    image: api:1
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/health"]
      interval: 30s
      timeout: 5s
      start_period: 1m
      retries: 4
`);
    expect(r.draft!.services[0].containerConfig.healthcheck).toEqual({
      test: ["CMD", "curl", "-f", "http://localhost/health"],
      interval: 30_000,
      timeout: 5_000,
      startPeriod: 60_000,
      retries: 4,
    });
  });

  it("raises a sub-second healthcheck interval to 1s and says so", () => {
    // The boot-time backfill treats anything under 1000 as a legacy *seconds*
    // value and multiplies by 1000, so a genuine 500ms interval would silently
    // become 500s on the next restart.
    const r = importYaml(`
services:
  api:
    image: api:1
    healthcheck:
      test: ["CMD", "true"]
      interval: 500ms
`);
    expect(r.draft!.services[0].containerConfig.healthcheck!.interval).toBe(1000);
    expect(issueAt(r, "services.api.healthcheck.interval")[0].level).toBe("lossy");
  });

  it("derives `order` from depends_on", () => {
    // `order` is required and Compose has no equivalent — it comes from the
    // dependency graph, so a service starts after what it depends on.
    const r = importYaml(`
services:
  web:
    image: nginx
    depends_on: [api]
  api:
    image: api:1
    depends_on: [db]
  db:
    image: postgres:16
`);
    const order = r.draft!.services.map((s) => s.serviceName);
    expect(order).toEqual(["db", "api", "web"]);
    expect(r.draft!.services.map((s) => s.order)).toEqual([0, 1, 2]);
  });

  it("reports a depends_on cycle instead of failing the import", () => {
    const r = importYaml(`
services:
  a:
    image: a:1
    depends_on: [b]
  b:
    image: b:1
    depends_on: [a]
`);
    expect(r.ok).toBe(true);
    expect(r.issues.some((i) => i.message.includes("cycle"))).toBe(true);
  });

  describe("nothing is dropped silently", () => {
    it("reports build: rather than importing a service with no image", () => {
      const r = importYaml(`
services:
  app:
    build: .
`);
      expect(r.ok).toBe(false);
      expect(issueAt(r, "services.app.image")[0].message).toContain("pre-built images");
    });

    it("reports every unsupported service key it recognises", () => {
      const r = importYaml(`
services:
  app:
    image: app:1
    env_file: .env
    secrets: [db_password]
    deploy:
      replicas: 3
    privileged: true
    container_name: my-app
`);
      const paths = r.issues.map((i) => i.path);
      expect(paths).toContain("services.app.env_file");
      expect(paths).toContain("services.app.secrets");
      expect(paths).toContain("services.app.deploy");
      expect(paths).toContain("services.app.privileged");
      expect(paths).toContain("services.app.container_name");
      // Recognised and reported — never quietly carried through.
      for (const p of paths) {
        expect(r.issues.find((i) => i.path === p)!.level).not.toBe("defaulted");
      }
    });

    it("reports host-env interpolation, which it cannot honour", () => {
      // `- FOO` means "read FOO from the host at `docker compose up` time".
      // There is no host here, so inventing an empty value would be a lie.
      const r = importYaml(`
services:
  app:
    image: app:1
    environment:
      - EXPLICIT=yes
      - FROM_HOST
`);
      expect(r.draft!.services[0].containerConfig.env).toEqual({ EXPLICIT: "yes" });
      expect(issueAt(r, "services.app.environment.FROM_HOST")[0].level).toBe("unsupported");
    });

    it("warns that a host-IP port binding becomes wider than Compose made it", () => {
      const r = importYaml(`
services:
  app:
    image: app:1
    ports: ["127.0.0.1:8001:8001"]
`);
      // Still imported, but the exposure changed — that's security-relevant.
      expect(r.draft!.services[0].containerConfig.ports).toEqual([
        { containerPort: 8001, hostPort: 8001, protocol: "tcp", exposeOnHost: true },
      ]);
      expect(issueAt(r, "services.app.ports")[0].message).toContain("more widely reachable");
    });

    it("skips a relative bind mount, which has no meaning on the managed host", () => {
      const r = importYaml(`
services:
  app:
    image: app:1
    volumes:
      - ./src:/app/src
`);
      expect(r.draft!.services[0].containerConfig.mounts).toBeUndefined();
      expect(issueAt(r, "services.app.volumes")[0].level).toBe("unsupported");
    });

    it("skips port ranges rather than guessing", () => {
      const r = importYaml(`
services:
  app:
    image: app:1
    ports: ["9090-9091:8080-8081"]
`);
      expect(r.draft!.services[0].containerConfig.ports).toBeUndefined();
      expect(issueAt(r, "services.app.ports")[0].message).toContain("Port range");
    });

    it("declares a volume the file forgot to declare", () => {
      const r = importYaml(`
services:
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
`);
      expect(r.draft!.volumes).toEqual([{ name: "pgdata" }]);
      expect(issueAt(r, "volumes.pgdata")[0].level).toBe("defaulted");
    });

    it("reports an untagged image as defaulted to :latest", () => {
      const r = importYaml(`
services:
  app:
    image: app
`);
      expect(r.draft!.services[0].dockerTag).toBe("latest");
      expect(issueAt(r, "services.app.image")[0].level).toBe("defaulted");
    });
  });

  it("runs a string command through a shell, matching Compose", () => {
    // Compose's string form is shell form. Splitting on spaces would mangle
    // quoting and operators; Docker itself wraps it in /bin/sh -c.
    const r = importYaml(`
services:
  app:
    image: app:1
    command: "sh -c 'echo hi && sleep 1'"
`);
    expect(r.draft!.services[0].containerConfig.command).toEqual([
      "/bin/sh",
      "-c",
      "sh -c 'echo hi && sleep 1'",
    ]);
  });

  it("keeps a list command as an exec form", () => {
    const r = importYaml(`
services:
  app:
    image: app:1
    command: ["npm", "start"]
`);
    expect(r.draft!.services[0].containerConfig.command).toEqual(["npm", "start"]);
  });

  it("rejects a file with no services", () => {
    expect(importYaml("volumes:\n  data:\n").ok).toBe(false);
  });

  it("rejects a non-Compose document", () => {
    expect(mapComposeToTemplate("just a string").ok).toBe(false);
    expect(mapComposeToTemplate(null).ok).toBe(false);
  });
});
