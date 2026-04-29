import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mockDocker, mockCache, mockLogger, mockDockerConfigService, mockPrisma, MockDockerConstructor } = vi.hoisted(() => {
  const _mockDocker = {
    ping: vi.fn(),
    listContainers: vi.fn(),
    getContainer: vi.fn(),
    getEvents: vi.fn(),
  };
  const _MockDockerConstructor = vi.fn().mockImplementation(function () { return _mockDocker; });
  return {
    mockDocker: _mockDocker,
    MockDockerConstructor: _MockDockerConstructor,
    mockCache: {
      get: vi.fn(),
      set: vi.fn(),
      flushAll: vi.fn(),
      keys: vi.fn().mockReturnValue([]),
      getStats: vi
        .fn()
        .mockReturnValue({ hits: 0, misses: 0, keys: 0, ksize: 0, vsize: 0 }),
    },
    mockLogger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    mockDockerConfigService: {
      get: vi.fn(),
      recordConnectivityStatus: vi.fn(),
    },
    mockPrisma: {},
  };
});

vi.mock("dockerode", () => ({
  default: MockDockerConstructor,
}));

vi.mock("node-cache", () => ({
  default: vi.fn().mockImplementation(function () { return mockCache; }),
}));

vi.mock("../../lib/logger-factory", () => ({
  getLogger: vi.fn(function () { return mockLogger; }),
  clearLoggerCache: vi.fn(),
  createChildLogger: vi.fn(function () { return mockLogger; }),
  selfBackupLogger: vi.fn(function () { return mockLogger; }),
  serializeError: (e: unknown) => e,
  appLogger: vi.fn(function () { return mockLogger; }),
  servicesLogger: vi.fn(function () { return mockLogger; }),
  httpLogger: vi.fn(function () { return mockLogger; }),
  prismaLogger: vi.fn(function () { return mockLogger; }),
  default: vi.fn(function () { return mockLogger; }),
}));

vi.mock("../../lib/config-new", () => ({
  dockerConfig: {
    containerCacheTtl: 3000,
    containerPollInterval: 5000,
  },
}));

vi.mock("../docker-config", () => ({
  DockerConfigService: vi
    .fn()
    .mockImplementation(function () { return mockDockerConfigService; }),
}));

vi.mock("../../lib/prisma", () => ({ default: mockPrisma }));

import DockerService from "../docker";

describe("DockerService.onConnect", () => {
  let dockerService: DockerService;

  beforeEach(() => {
    vi.clearAllMocks();
    (DockerService as unknown as { instance?: DockerService }).instance = undefined;
    mockDocker.getEvents.mockImplementation((_options, callback: (err: Error | null, stream: { on: () => void } | null) => void) => {
      callback(null, { on: vi.fn() });
    });
    MockDockerConstructor.mockClear();
    mockDockerConfigService.get.mockImplementation((key: string) => {
      if (key === "host") {
        return Promise.resolve("/var/run/docker.sock");
      }
      if (key === "apiVersion") return Promise.resolve("1.41");
      return Promise.resolve(null);
    });
    mockDockerConfigService.recordConnectivityStatus.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if ((dockerService as unknown as { reconnectInterval?: NodeJS.Timeout })?.reconnectInterval) {
      clearInterval((dockerService as unknown as { reconnectInterval: NodeJS.Timeout }).reconnectInterval);
    }
  });

  it("fires onConnect callbacks on the disconnected → connected transition", async () => {
    mockDocker.ping.mockResolvedValue(true);

    dockerService = DockerService.getInstance();
    const callback = vi.fn();
    dockerService.onConnect(callback);

    await dockerService.initialize();

    expect(dockerService.isConnected()).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not fire onConnect when ping succeeds while already connected", async () => {
    mockDocker.ping.mockResolvedValue(true);

    dockerService = DockerService.getInstance();
    const callback = vi.fn();
    dockerService.onConnect(callback);

    // First connect: disconnected → connected, callback fires once.
    await dockerService.initialize();
    expect(callback).toHaveBeenCalledTimes(1);

    // refreshConnection's connect call: already connected, so no transition.
    await dockerService.refreshConnection();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("fires onConnect again after a disconnected → connected reconnect cycle", async () => {
    dockerService = DockerService.getInstance();
    const callback = vi.fn();
    dockerService.onConnect(callback);

    // First boot: connect succeeds → callback fires.
    mockDocker.ping.mockResolvedValueOnce(true);
    await dockerService.initialize();
    expect(callback).toHaveBeenCalledTimes(1);

    // Drop the connection (simulating a Docker daemon disconnect).
    (dockerService as unknown as { connected: boolean }).connected = false;

    // Reconnect: false → true transition fires the callback again.
    mockDocker.ping.mockResolvedValueOnce(true);
    await dockerService.refreshConnection();
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("fires onConnect on the cold-boot reconnect path (initial connect failed, later succeeded)", async () => {
    dockerService = DockerService.getInstance();
    const callback = vi.fn();
    dockerService.onConnect(callback);

    // Cold boot: ping fails — server stays in degraded mode, no callback.
    mockDocker.ping.mockRejectedValueOnce(new Error("Docker host not reachable"));
    await dockerService.initialize();
    expect(dockerService.isConnected()).toBe(false);
    expect(callback).not.toHaveBeenCalled();

    // Seeder posts host setting → refreshConnection → ping succeeds.
    // false → true transition fires the callback.
    mockDocker.ping.mockResolvedValueOnce(true);
    await dockerService.refreshConnection();
    expect(dockerService.isConnected()).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not let a throwing callback break the connect path", async () => {
    mockDocker.ping.mockResolvedValue(true);

    dockerService = DockerService.getInstance();
    const throwing = vi.fn().mockRejectedValue(new Error("boom"));
    const ok = vi.fn();
    dockerService.onConnect(throwing);
    dockerService.onConnect(ok);

    await dockerService.initialize();

    expect(dockerService.isConnected()).toBe(true);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      { error: expect.any(Error) },
      "Docker onConnect callback failed",
    );
  });
});
