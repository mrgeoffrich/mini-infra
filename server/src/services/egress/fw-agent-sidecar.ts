/**
 * Lifecycle for the egress-fw-agent host-singleton sidecar.
 *
 * The fw-agent enforces L3/L4 egress rules in the host network namespace via
 * iptables/ipset and emits NFLOG events. Because it lives in `network_mode:
 * host` and needs NET_ADMIN/NET_RAW, it must run as its own container — but
 * mini-infra-server now manages its lifecycle (find/create/start/remove) the
 * same way it manages the agent-sidecar, instead of relying on docker-compose.
 *
 * Communication with the agent stays over the shared Unix socket at
 * /var/run/mini-infra/fw.sock, so EnvFirewallManager is unchanged.
 */
import type Docker from "dockerode";
import { getLogger } from "../../lib/logger-factory";
import DockerService from "../docker";
import { RegistryManager } from "../docker-executor/registry-manager";
import { RegistryCredentialService } from "../registry-credential";
import prisma from "../../lib/prisma";
import { getOwnContainerId } from "../self-update";
import {
  createUnixSocketFetcher,
  getFwAgentSocketPath,
  type Fetcher,
} from "./fw-agent-transport";
import type { OperationStep } from "@mini-infra/types";

const logger = getLogger("stacks", "fw-agent-sidecar");

const FW_AGENT_LABEL = "mini-infra.egress.fw-agent";
const FW_AGENT_CONTAINER_NAME = "mini-infra-egress-fw-agent";
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const SETTINGS_CATEGORY = "egress-fw-agent";

// Module-level state
let healthCheckInterval: NodeJS.Timeout | null = null;
let agentHealthy = false;

// ---------------------------------------------------------------------------
// Public getters
// ---------------------------------------------------------------------------

export function isFwAgentHealthy(): boolean {
  return agentHealthy;
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

async function getSettings(): Promise<Map<string, string>> {
  const settings = await prisma.systemSettings.findMany({
    where: { category: SETTINGS_CATEGORY, isActive: true },
  });
  return new Map(settings.map((s) => [s.key, s.value]));
}

export async function getFwAgentConfig(): Promise<{
  image: string | null;
  autoStart: boolean;
}> {
  const settings = await getSettings();
  return {
    image: settings.get("image") || process.env.EGRESS_FW_AGENT_IMAGE_TAG || null,
    autoStart: settings.get("auto_start") !== "false",
  };
}

// ---------------------------------------------------------------------------
// Container discovery
// ---------------------------------------------------------------------------

export async function findFwAgent(): Promise<{
  id: string;
  state: string;
} | null> {
  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [`${FW_AGENT_LABEL}=true`],
      },
    });
    if (containers.length === 0) return null;
    const c = containers[0];
    return { id: c.Id, state: c.State };
  } catch (err) {
    logger.error({ err }, "Failed to find egress fw-agent");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Health checking — tickles the Unix admin socket
// ---------------------------------------------------------------------------

let cachedFetcher: Fetcher | null = null;
function getFetcher(): Fetcher {
  if (!cachedFetcher) {
    cachedFetcher = createUnixSocketFetcher(getFwAgentSocketPath(), HEALTH_CHECK_TIMEOUT_MS);
  }
  return cachedFetcher;
}

async function checkAgentHealth(): Promise<void> {
  try {
    const resp = await getFetcher()({ method: "GET", path: "/v1/health" });
    if (resp.status === 200) {
      agentHealthy = true;
      logger.debug("Egress fw-agent health check passed");
    } else {
      agentHealthy = false;
      logger.warn({ status: resp.status }, "Egress fw-agent health check non-200");
    }
  } catch (err) {
    agentHealthy = false;
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, "Egress fw-agent health check error");
  }
}

function startHealthChecks(): void {
  stopHealthChecks();
  void checkAgentHealth();
  healthCheckInterval = setInterval(() => void checkAgentHealth(), HEALTH_CHECK_INTERVAL_MS);
}

export function stopHealthChecks(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Sidecar lifecycle
// ---------------------------------------------------------------------------

export type FwAgentProgressCallback = (
  step: OperationStep,
  completedCount: number,
  totalSteps: number,
) => void;

/** Step names used for progress reporting. */
export const FW_AGENT_STARTUP_STEPS = [
  "Pull fw-agent image",
  "Create container",
  "Start container",
  "Verify health",
] as const;

export async function ensureFwAgent(options?: {
  onProgress?: FwAgentProgressCallback;
  checkAutoStart?: boolean;
}): Promise<{ containerId: string } | null> {
  const ownContainerId = getOwnContainerId();
  if (!ownContainerId) {
    logger.info("Not running in Docker, egress fw-agent will not be managed");
    return null;
  }

  const config = await getFwAgentConfig();
  if (options?.checkAutoStart && !config.autoStart) {
    logger.info("Egress fw-agent auto-start is disabled");
    return null;
  }
  if (!config.image) {
    logger.warn("No egress fw-agent image configured (EGRESS_FW_AGENT_IMAGE_TAG not set)");
    return null;
  }

  const existing = await findFwAgent();
  if (existing) {
    if (existing.state === "running") {
      logger.info({ containerId: existing.id }, "Found running egress fw-agent, reconnecting");
      startHealthChecks();
      return { containerId: existing.id };
    }
    logger.info(
      { containerId: existing.id, state: existing.state },
      "Found stopped egress fw-agent, removing",
    );
    try {
      const docker = await DockerService.getInstance().getDockerInstance();
      await docker.getContainer(existing.id).remove({ force: true });
    } catch (err) {
      logger.warn({ err }, "Failed to remove stopped egress fw-agent");
    }
  }

  return createFwAgent(config, options?.onProgress);
}

async function createFwAgent(
  config: { image: string | null },
  onProgress?: FwAgentProgressCallback,
): Promise<{ containerId: string } | null> {
  if (!config.image) return null;

  const totalSteps = FW_AGENT_STARTUP_STEPS.length;
  let completedCount = 0;

  const reportStep = (
    step: string,
    status: "completed" | "failed" | "skipped",
    detail?: string,
  ) => {
    if (status === "completed") completedCount++;
    try {
      onProgress?.({ step, status, detail }, completedCount, totalSteps);
    } catch {
      /* never break caller */
    }
  };

  try {
    const docker = await DockerService.getInstance().getDockerInstance();

    logger.info({ image: config.image }, "Creating egress fw-agent container");

    // Step 1: Pull the image (auto-auth handles ghcr/local-registry creds)
    try {
      const registryManager = new RegistryManager(
        docker,
        new RegistryCredentialService(prisma),
      );
      await registryManager.pullImageWithAutoAuth(config.image);
      logger.info({ image: config.image }, "Egress fw-agent image pulled");
      reportStep("Pull fw-agent image", "completed", config.image);
    } catch (pullErr) {
      logger.error({ err: pullErr, image: config.image }, "Failed to pull egress fw-agent image");
      reportStep(
        "Pull fw-agent image",
        "failed",
        pullErr instanceof Error ? pullErr.message : String(pullErr),
      );
      throw new Error(
        `Failed to pull egress fw-agent image "${config.image}": ${pullErr instanceof Error ? pullErr.message : pullErr}`,
        { cause: pullErr },
      );
    }

    // Step 2: Create container
    const createOptions: Docker.ContainerCreateOptions = {
      Image: config.image,
      name: FW_AGENT_CONTAINER_NAME,
      Labels: {
        [FW_AGENT_LABEL]: "true",
        "mini-infra.managed": "true",
      },
      Env: [
        `LOG_LEVEL=${process.env.FW_AGENT_LOG_LEVEL || process.env.LOG_LEVEL || "info"}`,
      ],
      HostConfig: {
        NetworkMode: "host",
        CapAdd: ["NET_ADMIN", "NET_RAW"],
        Binds: [
          "/var/run/mini-infra:/var/run/mini-infra",
          "/lib/modules:/lib/modules:ro",
        ],
        RestartPolicy: { Name: "unless-stopped" },
      },
    };

    const fwAgent = await docker.createContainer(createOptions);
    reportStep("Create container", "completed");

    // Step 3: Start container
    await fwAgent.start();
    const fwAgentId = (fwAgent as unknown as { id: string }).id;
    logger.info({ fwAgentId }, "Egress fw-agent container started");
    reportStep("Start container", "completed", fwAgentId.slice(0, 12));

    // Step 4: Verify health (allow a brief startup window)
    startHealthChecks();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await checkAgentHealth();
    if (agentHealthy) {
      reportStep("Verify health", "completed");
    } else {
      reportStep(
        "Verify health",
        "completed",
        "Health check pending — agent is starting",
      );
    }

    return { containerId: fwAgentId };
  } catch (err) {
    logger.error({ err }, "Failed to create egress fw-agent container");
    throw err;
  }
}

export async function removeFwAgent(): Promise<void> {
  stopHealthChecks();

  if (!getOwnContainerId()) {
    agentHealthy = false;
    return;
  }

  const existing = await findFwAgent();
  if (!existing) {
    agentHealthy = false;
    return;
  }

  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    const container = docker.getContainer(existing.id);
    if (existing.state === "running") {
      logger.info({ containerId: existing.id }, "Stopping egress fw-agent");
      await container.stop({ t: 10 });
    }
    await container.remove();
    logger.info({ containerId: existing.id }, "Egress fw-agent removed");
  } catch (err) {
    logger.error({ err }, "Failed to remove egress fw-agent");
  }
  agentHealthy = false;
}

export async function restartFwAgent(options?: {
  onProgress?: FwAgentProgressCallback;
}): Promise<{ containerId: string } | null> {
  await removeFwAgent();
  return ensureFwAgent({ onProgress: options?.onProgress });
}
