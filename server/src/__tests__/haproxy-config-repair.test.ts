import { injectResolversIntoConfig } from "../services/haproxy/haproxy-config-repair";

// Mock logger — must export all logger factories since transitive imports resolve them
vi.mock("../lib/logger-factory", () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    createLogger: vi.fn(() => mockLogger),
    getLogger: vi.fn(() => mockLogger),
    clearLoggerCache: vi.fn(),
    createChildLogger: vi.fn(() => mockLogger),
    selfBackupLogger: vi.fn(() => mockLogger),
    serializeError: (e: unknown) => e,
    appLogger: vi.fn(() => mockLogger),
    httpLogger: vi.fn(() => mockLogger),
    prismaLogger: vi.fn(() => mockLogger),
    servicesLogger: vi.fn(() => mockLogger),
    dockerExecutorLogger: vi.fn(() => mockLogger),
    deploymentLogger: vi.fn(() => mockLogger),
    loadbalancerLogger: vi.fn(() => mockLogger),
    selfBackupLogger: vi.fn(() => mockLogger),
    tlsLogger: vi.fn(() => mockLogger),
    clearLoggerCache: vi.fn(),
    serializeError: vi.fn((e: any) => e),
  };
});

const SAMPLE_CONFIG = `global
    log stdout local0
    maxconn 4096
    master-worker

defaults
    mode http
    log global
    option httplog
    timeout connect 5000ms
    timeout client 50000ms
    timeout server 50000ms

userlist dataplaneapi
    user admin insecure-password adminpwd

program api
    command /usr/local/bin/dataplaneapi -f /usr/local/etc/haproxy/dataplaneapi.yml
    no option start-on-reload

frontend stats
    bind *:8404
    stats enable
`;

const ALREADY_FIXED_CONFIG = `global
    log stdout local0
    maxconn 4096

defaults
    mode http
    timeout connect 5000ms
    default-server init-addr last,libc,none resolvers docker

resolvers docker
    nameserver dns1 127.0.0.11:53
    resolve_retries 3
    timeout resolve 1s
    timeout retry 1s
    hold other 10s
    hold refused 10s
    hold nx 10s
    hold timeout 10s
    hold valid 10s
    hold obsolete 10s

userlist dataplaneapi
    user admin insecure-password adminpwd
`;

describe("injectResolversIntoConfig", () => {
  it("injects both resolvers and init-addr into a config missing them", () => {
    const result = injectResolversIntoConfig(SAMPLE_CONFIG);

    expect(result).not.toBeNull();
    expect(result).toContain("default-server init-addr last,libc,none resolvers docker");
    expect(result).toContain("resolvers docker");
    expect(result).toContain("nameserver dns1 127.0.0.11:53");
  });

  it("returns null for a config that already has both directives", () => {
    const result = injectResolversIntoConfig(ALREADY_FIXED_CONFIG);
    expect(result).toBeNull();
  });

  it("places init-addr inside the defaults section", () => {
    const result = injectResolversIntoConfig(SAMPLE_CONFIG)!;
    const lines = result.split("\n");

    // Find the defaults section
    const defaultsIndex = lines.findIndex((l) => l.startsWith("defaults"));
    // Find init-addr line
    const initAddrIndex = lines.findIndex((l) =>
      l.includes("init-addr"),
    );
    // Find the next top-level section after defaults
    const nextSectionIndex = lines.findIndex(
      (l, i) => i > defaultsIndex && /^(resolvers|userlist|program|frontend|backend)\s/.test(l),
    );

    expect(initAddrIndex).toBeGreaterThan(defaultsIndex);
    expect(initAddrIndex).toBeLessThan(nextSectionIndex);
  });

  it("places resolvers block before the first userlist/program/frontend/backend", () => {
    const result = injectResolversIntoConfig(SAMPLE_CONFIG)!;
    const lines = result.split("\n");

    const resolversIndex = lines.findIndex((l) =>
      l.startsWith("resolvers docker"),
    );
    const userlistIndex = lines.findIndex((l) =>
      l.startsWith("userlist"),
    );

    expect(resolversIndex).toBeGreaterThan(-1);
    expect(userlistIndex).toBeGreaterThan(-1);
    expect(resolversIndex).toBeLessThan(userlistIndex);
  });

  it("handles config with only resolvers missing", () => {
    const configWithInitAddr = SAMPLE_CONFIG.replace(
      "    timeout server 50000ms\n",
      "    timeout server 50000ms\n    default-server init-addr last,libc,none resolvers docker\n",
    );

    const result = injectResolversIntoConfig(configWithInitAddr);
    expect(result).not.toBeNull();
    expect(result).toContain("resolvers docker");
    expect(result).toContain("nameserver dns1 127.0.0.11:53");
  });

  it("handles config with only init-addr missing", () => {
    const configWithResolvers =
      SAMPLE_CONFIG.replace(
        "\nuserlist",
        "\nresolvers docker\n    nameserver dns1 127.0.0.11:53\n\nuserlist",
      );

    const result = injectResolversIntoConfig(configWithResolvers);
    expect(result).not.toBeNull();
    expect(result).toContain("init-addr last,libc,none");
  });
});
