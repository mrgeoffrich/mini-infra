import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPrisma,
  mockListContainers,
  mockGetContainer,
  mockCreateContainer,
  mockGetDockerInstance,
  mockPullImageWithAutoAuth,
  mockGetOwnContainerId,
  mockFetcher,
} = vi.hoisted(() => ({
  mockPrisma: {
    systemSettings: {
      findMany: vi.fn(),
    },
  },
  mockListContainers: vi.fn(),
  mockGetContainer: vi.fn(),
  mockCreateContainer: vi.fn(),
  mockGetDockerInstance: vi.fn(),
  mockPullImageWithAutoAuth: vi.fn(),
  mockGetOwnContainerId: vi.fn(),
  mockFetcher: vi.fn(),
}));

vi.mock("../../../lib/prisma", () => ({
  default: mockPrisma,
}));

vi.mock("../../docker", () => ({
  default: {
    getInstance: () => ({
      getDockerInstance: mockGetDockerInstance,
    }),
  },
}));

vi.mock("../../docker-executor/registry-manager", () => ({
  RegistryManager: class {
    pullImageWithAutoAuth(image: string) {
      return mockPullImageWithAutoAuth(image);
    }
  },
}));
vi.mock("../../registry-credential", () => ({
  RegistryCredentialService: class {},
}));

vi.mock("../../self-update", () => ({
  getOwnContainerId: () => mockGetOwnContainerId(),
}));

vi.mock("../fw-agent-transport", async (orig) => {
  const actual = await (orig as () => Promise<typeof import("../fw-agent-transport")>)();
  return {
    ...actual,
    createUnixSocketFetcher: () => mockFetcher,
  };
});

import {
  ensureFwAgent,
  removeFwAgent,
  findFwAgent,
  getFwAgentConfig,
  isFwAgentHealthy,
  stopHealthChecks,
} from "../fw-agent-sidecar";

function makeContainer(overrides?: Partial<{ id: string; state: string }>) {
  return {
    Id: "abc123def456",
    State: "running",
    Labels: { "mini-infra.egress.fw-agent": "true" },
    ...overrides,
  };
}

describe("fw-agent-sidecar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListContainers.mockResolvedValue([]);
    mockCreateContainer.mockResolvedValue({
      id: "newcontainer123",
      start: vi.fn().mockResolvedValue(undefined),
    });
    mockGetContainer.mockReturnValue({
      remove: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    });
    mockGetDockerInstance.mockResolvedValue({
      listContainers: mockListContainers,
      getContainer: mockGetContainer,
      createContainer: mockCreateContainer,
    });
    mockPullImageWithAutoAuth.mockResolvedValue(undefined);
    mockGetOwnContainerId.mockReturnValue("server-container-id");
    mockPrisma.systemSettings.findMany.mockResolvedValue([]);
    mockFetcher.mockResolvedValue({ status: 200, body: { status: "ok" } });
    delete process.env.EGRESS_FW_AGENT_IMAGE_TAG;
  });

  afterEach(() => {
    stopHealthChecks();
  });

  // -------------------------------------------------------------------------
  // getFwAgentConfig
  // -------------------------------------------------------------------------

  describe("getFwAgentConfig", () => {
    it("falls back to env var when no DB setting", async () => {
      process.env.EGRESS_FW_AGENT_IMAGE_TAG = "ghcr.io/test/fw-agent:latest";
      const cfg = await getFwAgentConfig();
      expect(cfg.image).toBe("ghcr.io/test/fw-agent:latest");
      expect(cfg.autoStart).toBe(true);
    });

    it("DB setting overrides env var", async () => {
      process.env.EGRESS_FW_AGENT_IMAGE_TAG = "ghcr.io/test/fw-agent:env";
      mockPrisma.systemSettings.findMany.mockResolvedValue([
        { key: "image", value: "ghcr.io/test/fw-agent:db" },
      ]);
      const cfg = await getFwAgentConfig();
      expect(cfg.image).toBe("ghcr.io/test/fw-agent:db");
    });

    it("autoStart defaults to true and respects 'false' string", async () => {
      mockPrisma.systemSettings.findMany.mockResolvedValue([
        { key: "auto_start", value: "false" },
      ]);
      const cfg = await getFwAgentConfig();
      expect(cfg.autoStart).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // findFwAgent
  // -------------------------------------------------------------------------

  describe("findFwAgent", () => {
    it("returns null when no labelled container exists", async () => {
      mockListContainers.mockResolvedValue([]);
      const result = await findFwAgent();
      expect(result).toBeNull();
      expect(mockListContainers).toHaveBeenCalledWith({
        all: true,
        filters: { label: ["mini-infra.egress.fw-agent=true"] },
      });
    });

    it("returns id+state when a container is found", async () => {
      mockListContainers.mockResolvedValue([makeContainer({ Id: "xyz", State: "exited" })]);
      const result = await findFwAgent();
      expect(result).toEqual({ id: "xyz", state: "exited" });
    });
  });

  // -------------------------------------------------------------------------
  // ensureFwAgent
  // -------------------------------------------------------------------------

  describe("ensureFwAgent", () => {
    it("returns null in dev mode (no own container)", async () => {
      mockGetOwnContainerId.mockReturnValue(null);
      process.env.EGRESS_FW_AGENT_IMAGE_TAG = "img:1";
      const result = await ensureFwAgent();
      expect(result).toBeNull();
    });

    it("returns null when image is not configured", async () => {
      const result = await ensureFwAgent();
      expect(result).toBeNull();
    });

    it("respects checkAutoStart=true with auto_start=false", async () => {
      process.env.EGRESS_FW_AGENT_IMAGE_TAG = "img:1";
      mockPrisma.systemSettings.findMany.mockResolvedValue([
        { key: "auto_start", value: "false" },
      ]);
      const result = await ensureFwAgent({ checkAutoStart: true });
      expect(result).toBeNull();
      expect(mockListContainers).not.toHaveBeenCalled();
    });

    it("reconnects to a running container without recreating", async () => {
      process.env.EGRESS_FW_AGENT_IMAGE_TAG = "img:1";
      mockListContainers.mockResolvedValue([makeContainer({ State: "running" })]);
      const result = await ensureFwAgent();
      expect(result).toEqual({ containerId: "abc123def456" });
      expect(mockCreateContainer).not.toHaveBeenCalled();
      expect(mockPullImageWithAutoAuth).not.toHaveBeenCalled();
    });

    it("creates a fresh container when none exists, with the host network spec", async () => {
      process.env.EGRESS_FW_AGENT_IMAGE_TAG = "img:1";
      mockListContainers.mockResolvedValue([]);

      const result = await ensureFwAgent();

      expect(result).toEqual({ containerId: "newcontainer123" });
      expect(mockPullImageWithAutoAuth).toHaveBeenCalledWith("img:1");
      expect(mockCreateContainer).toHaveBeenCalledOnce();

      const opts = mockCreateContainer.mock.calls[0][0];
      expect(opts.Image).toBe("img:1");
      expect(opts.name).toBe("mini-infra-egress-fw-agent");
      expect(opts.Labels["mini-infra.egress.fw-agent"]).toBe("true");
      expect(opts.Labels["mini-infra.managed"]).toBe("true");
      expect(opts.HostConfig.NetworkMode).toBe("host");
      expect(opts.HostConfig.CapAdd).toEqual(["NET_ADMIN", "NET_RAW"]);
      expect(opts.HostConfig.Binds).toContain(
        "/var/run/mini-infra:/var/run/mini-infra",
      );
      expect(opts.HostConfig.Binds).toContain("/lib/modules:/lib/modules:ro");
      expect(opts.HostConfig.RestartPolicy).toEqual({ Name: "unless-stopped" });
    });

    it("removes a stopped container before recreating", async () => {
      process.env.EGRESS_FW_AGENT_IMAGE_TAG = "img:1";
      mockListContainers.mockResolvedValue([makeContainer({ State: "exited", Id: "stopped123" })]);
      const remove = vi.fn().mockResolvedValue(undefined);
      mockGetContainer.mockReturnValue({ remove });

      const result = await ensureFwAgent();

      expect(remove).toHaveBeenCalledWith({ force: true });
      expect(mockCreateContainer).toHaveBeenCalledOnce();
      expect(result).toEqual({ containerId: "newcontainer123" });
    });

    it("propagates pull failures with an explanatory error", async () => {
      process.env.EGRESS_FW_AGENT_IMAGE_TAG = "img:1";
      mockPullImageWithAutoAuth.mockRejectedValue(new Error("registry 500"));
      mockListContainers.mockResolvedValue([]);

      await expect(ensureFwAgent()).rejects.toThrow(/Failed to pull egress fw-agent image "img:1"/);
      expect(mockCreateContainer).not.toHaveBeenCalled();
    });

    it("reports progress through the onProgress callback", async () => {
      process.env.EGRESS_FW_AGENT_IMAGE_TAG = "img:1";
      mockListContainers.mockResolvedValue([]);
      const onProgress = vi.fn();

      await ensureFwAgent({ onProgress });

      const stepNames = onProgress.mock.calls.map((c) => c[0].step);
      expect(stepNames).toEqual([
        "Pull fw-agent image",
        "Create container",
        "Start container",
        "Verify health",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // removeFwAgent
  // -------------------------------------------------------------------------

  describe("removeFwAgent", () => {
    it("is a no-op in dev mode", async () => {
      mockGetOwnContainerId.mockReturnValue(null);
      await removeFwAgent();
      expect(mockListContainers).not.toHaveBeenCalled();
      expect(isFwAgentHealthy()).toBe(false);
    });

    it("stops + removes a running container", async () => {
      mockListContainers.mockResolvedValue([makeContainer({ Id: "abc", State: "running" })]);
      const stop = vi.fn().mockResolvedValue(undefined);
      const remove = vi.fn().mockResolvedValue(undefined);
      mockGetContainer.mockReturnValue({ stop, remove });

      await removeFwAgent();

      expect(stop).toHaveBeenCalledWith({ t: 10 });
      expect(remove).toHaveBeenCalledOnce();
      expect(isFwAgentHealthy()).toBe(false);
    });

    it("removes a non-running container without calling stop", async () => {
      mockListContainers.mockResolvedValue([makeContainer({ State: "exited" })]);
      const stop = vi.fn();
      const remove = vi.fn().mockResolvedValue(undefined);
      mockGetContainer.mockReturnValue({ stop, remove });

      await removeFwAgent();

      expect(stop).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledOnce();
    });
  });
});
