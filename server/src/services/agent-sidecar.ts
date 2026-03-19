import crypto from "crypto";
import { servicesLogger } from "../lib/logger-factory";
import DockerService from "./docker";
import { getOwnContainerId } from "./self-update";
import prisma from "../lib/prisma";
import appConfig, { agentConfig } from "../lib/config-new";
import { getEffectiveModel } from "./agent-settings-service";

const logger = servicesLogger();

const AGENT_SIDECAR_LABEL = "mini-infra.agent-sidecar";
const AGENT_SIDECAR_CONTAINER_NAME = "mini-infra-agent-sidecar";
const SIDECAR_PORT = 3100;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const SETTINGS_CATEGORY = "agent-sidecar";

// Module-level state
let sidecarUrl: string | null = null;
let internalToken: string | null = null;
let healthCheckInterval: NodeJS.Timeout | null = null;
let sidecarHealthy = false;

// ---------------------------------------------------------------------------
// Public getters
// ---------------------------------------------------------------------------

export function getAgentSidecarUrl(): string | null {
  return sidecarUrl;
}

export function getInternalToken(): string | null {
  return internalToken;
}

export function isAgentSidecarHealthy(): boolean {
  return sidecarHealthy;
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

export async function getAgentSidecarConfig() {
  const settings = await getSettings();
  return {
    image: settings.get("image") || process.env.AGENT_SIDECAR_IMAGE_TAG || null,
    model: await getEffectiveModel(),
    thinking: agentConfig.thinking,
    effort: agentConfig.effort,
    timeoutMs: parseInt(settings.get("timeout_ms") || "300000", 10),
    autoStart: settings.get("auto_start") !== "false",
  };
}

// ---------------------------------------------------------------------------
// Container discovery
// ---------------------------------------------------------------------------

export async function findAgentSidecar(): Promise<{
  id: string;
  state: string;
} | null> {
  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [`${AGENT_SIDECAR_LABEL}=true`],
      },
    });

    if (containers.length === 0) return null;

    const c = containers[0];
    return { id: c.Id, state: c.State };
  } catch (err) {
    logger.error({ err }, "Failed to find agent sidecar");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Health checking
// ---------------------------------------------------------------------------

async function checkSidecarHealth(): Promise<void> {
  if (!sidecarUrl) {
    sidecarHealthy = false;
    return;
  }

  try {
    const response = await fetch(`${sidecarUrl}/health`, {
      headers: internalToken
        ? { Authorization: `Bearer ${internalToken}` }
        : {},
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });

    if (response.ok) {
      sidecarHealthy = true;
      logger.debug("Agent sidecar health check passed");
    } else {
      sidecarHealthy = false;
      logger.warn(
        { status: response.status },
        "Agent sidecar health check failed",
      );
    }
  } catch (err) {
    sidecarHealthy = false;
    logger.warn({ err }, "Agent sidecar health check error");
  }
}

function startHealthChecks(): void {
  stopHealthChecks();
  // Immediate check
  checkSidecarHealth();
  healthCheckInterval = setInterval(checkSidecarHealth, HEALTH_CHECK_INTERVAL_MS);
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

export type SidecarProgressCallback = (
  step: { step: string; status: "completed" | "failed" | "skipped"; detail?: string },
  completedCount: number,
  totalSteps: number,
) => void;

export async function ensureAgentSidecar(options?: {
  onProgress?: SidecarProgressCallback;
  checkAutoStart?: boolean;
}): Promise<{
  containerId: string;
  url: string;
} | null> {
  const containerId = getOwnContainerId();
  if (!containerId) {
    // Dev mode: connect to locally-running sidecar process
    const devUrl = process.env.AGENT_SIDECAR_DEV_URL;
    if (!devUrl) {
      logger.info("Not running in Docker and AGENT_SIDECAR_DEV_URL not set, agent sidecar disabled");
      return null;
    }

    sidecarUrl = devUrl;
    internalToken = null;
    startHealthChecks();
    logger.info({ sidecarUrl }, "Dev mode: connected to local agent sidecar process");
    return { containerId: "dev-local", url: sidecarUrl };
  }

  const config = await getAgentSidecarConfig();

  // Respect autoStart setting when called at startup
  if (options?.checkAutoStart && !config.autoStart) {
    logger.info("Agent sidecar auto-start is disabled");
    return null;
  }

  if (!config.image) {
    logger.warn(
      "No agent sidecar image configured (AGENT_SIDECAR_IMAGE_TAG not set)",
    );
    return null;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn(
      "ANTHROPIC_API_KEY not set, agent sidecar will not function",
    );
  }

  // Check for existing sidecar
  const existing = await findAgentSidecar();
  if (existing) {
    if (existing.state === "running") {
      logger.info(
        { containerId: existing.id },
        "Found running agent sidecar, reconnecting",
      );

      // Reconnect: recover URL and generate new token
      const docker = await DockerService.getInstance().getDockerInstance();
      const container = docker.getContainer(existing.id);
      const info = await container.inspect();
      const containerName = info.Name.replace(/^\//, "");

      sidecarUrl = `http://${containerName}:${SIDECAR_PORT}`;
      const tokenPrefix = "SIDECAR_AUTH_TOKEN=";
      const tokenEnv = info.Config.Env?.find((e: string) => e.startsWith(tokenPrefix));
      internalToken = tokenEnv ? tokenEnv.slice(tokenPrefix.length) : null;

      startHealthChecks();
      return { containerId: existing.id, url: sidecarUrl };
    }

    // Stopped sidecar — remove and recreate
    logger.info(
      { containerId: existing.id, state: existing.state },
      "Found stopped agent sidecar, removing",
    );
    try {
      const docker = await DockerService.getInstance().getDockerInstance();
      const container = docker.getContainer(existing.id);
      await container.remove({ force: true });
    } catch (err) {
      logger.warn({ err }, "Failed to remove stopped agent sidecar");
    }
  }

  // Create new sidecar
  return createAgentSidecar(config, options?.onProgress);
}

/** Step names used for progress reporting */
export const SIDECAR_STARTUP_STEPS = [
  "Pull sidecar image",
  "Create container",
  "Start container",
  "Verify health",
] as const;

async function createAgentSidecar(
  config: {
    image: string | null;
    model: string;
    thinking: string;
    effort: string;
    timeoutMs: number;
  },
  onProgress?: SidecarProgressCallback,
): Promise<{ containerId: string; url: string } | null> {
  if (!config.image) return null;

  const totalSteps = SIDECAR_STARTUP_STEPS.length;
  let completedCount = 0;

  const reportStep = (
    step: string,
    status: "completed" | "failed" | "skipped",
    detail?: string,
  ) => {
    if (status === "completed") completedCount++;
    try {
      onProgress?.({ step, status, detail }, completedCount, totalSteps);
    } catch { /* never break caller */ }
  };

  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    const ownContainerId = getOwnContainerId();
    if (!ownContainerId) return null;

    const ownContainer = docker.getContainer(ownContainerId);
    const ownInfo = await ownContainer.inspect();
    const containerName = ownInfo.Name.replace(/^\//, "");

    // Find user-defined network for Docker DNS
    const ownNetworks = Object.keys(
      ownInfo.NetworkSettings?.Networks ?? {},
    );
    const sidecarNetwork =
      ownNetworks.find(
        (n) => n !== "host" && n !== "none" && n !== "bridge",
      ) ?? ownNetworks[0];

    // Generate auth token
    internalToken = crypto.randomBytes(32).toString("hex");

    logger.info(
      {
        image: config.image,
        containerName,
        sidecarNetwork,
        model: config.model,
      },
      "Creating agent sidecar container",
    );

    // Step 1: Pull the sidecar image
    try {
      await new Promise<void>((resolve, reject) => {
        docker.pull(config.image!, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (progressErr: Error | null) => {
            if (progressErr) return reject(progressErr);
            resolve();
          });
        });
      });
      logger.info({ image: config.image }, "Agent sidecar image pulled");
      reportStep("Pull sidecar image", "completed", config.image);
    } catch (pullErr) {
      logger.error({ err: pullErr, image: config.image }, "Failed to pull agent sidecar image");
      reportStep("Pull sidecar image", "failed", pullErr instanceof Error ? pullErr.message : String(pullErr));
      throw new Error(
        `Failed to pull agent sidecar image "${config.image}": ${pullErr instanceof Error ? pullErr.message : pullErr}`,
      );
    }

    // Step 2: Create container
    const createOptions: Record<string, unknown> = {
      Image: config.image,
      name: AGENT_SIDECAR_CONTAINER_NAME,
      Labels: {
        [AGENT_SIDECAR_LABEL]: "true",
        "mini-infra.managed": "true",
      },
      Env: [
        `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ""}`,
        `MINI_INFRA_API_URL=http://${containerName}:${appConfig.server.port}`,
        `MINI_INFRA_API_KEY=${process.env.API_KEY_SECRET || ""}`,
        `SIDECAR_AUTH_TOKEN=${internalToken}`,
        `PORT=${SIDECAR_PORT}`,
        `AGENT_MODEL=${config.model}`,
        `AGENT_THINKING=${config.thinking}`,
        `AGENT_EFFORT=${config.effort}`,
        `AGENT_TIMEOUT_MS=${config.timeoutMs}`,
        `LOG_LEVEL=${process.env.LOG_LEVEL || "info"}`,
        // Forward OpenTelemetry config if present
        ...["ENABLE_BETA_TRACING_DETAILED", "BETA_TRACING_ENDPOINT"]
          .filter((key) => process.env[key] !== undefined)
          .map((key) => `${key}=${process.env[key]}`),
      ],
      ExposedPorts: { [`${SIDECAR_PORT}/tcp`]: {} },
      HostConfig: {
        Binds: [
          "/var/run/docker.sock:/var/run/docker.sock",
          "mini-infra-agent-sessions:/home/node/.claude",
        ],
        RestartPolicy: { Name: "unless-stopped" },
        Memory: 512 * 1024 * 1024,
        MemorySwap: 512 * 1024 * 1024,
        CpuShares: 256,
      },
    };

    if (sidecarNetwork) {
      (createOptions as Record<string, unknown>).NetworkingConfig = {
        EndpointsConfig: {
          [sidecarNetwork]: {},
        },
      };
    }

    const sidecar = await docker.createContainer(
      createOptions as Docker.ContainerCreateOptions,
    );
    reportStep("Create container", "completed");

    // Step 3: Start container
    await sidecar.start();

    const sidecarId = (sidecar as unknown as { id: string }).id;
    sidecarUrl = `http://${AGENT_SIDECAR_CONTAINER_NAME}:${SIDECAR_PORT}`;

    logger.info({ sidecarId, sidecarUrl }, "Agent sidecar container started");
    reportStep("Start container", "completed", sidecarId.slice(0, 12));

    // Step 4: Verify health
    startHealthChecks();
    // Give the sidecar a moment to start accepting connections
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await checkSidecarHealth();
    if (sidecarHealthy) {
      reportStep("Verify health", "completed");
    } else {
      // Container started but health check didn't pass yet — not fatal,
      // the periodic health check will pick it up
      reportStep("Verify health", "completed", "Health check pending — container is starting");
    }

    return { containerId: sidecarId, url: sidecarUrl };
  } catch (err) {
    logger.error({ err }, "Failed to create agent sidecar container");
    throw err;
  }
}

export async function removeAgentSidecar(): Promise<void> {
  stopHealthChecks();

  // Dev mode: no Docker container to manage, just clear state
  if (!getOwnContainerId()) {
    sidecarUrl = null;
    internalToken = null;
    sidecarHealthy = false;
    return;
  }

  const existing = await findAgentSidecar();
  if (!existing) {
    sidecarUrl = null;
    internalToken = null;
    sidecarHealthy = false;
    return;
  }

  try {
    const docker = await DockerService.getInstance().getDockerInstance();
    const container = docker.getContainer(existing.id);

    if (existing.state === "running") {
      logger.info({ containerId: existing.id }, "Stopping agent sidecar");
      await container.stop({ t: 10 });
    }

    await container.remove();
    logger.info({ containerId: existing.id }, "Agent sidecar removed");
  } catch (err) {
    logger.error({ err }, "Failed to remove agent sidecar");
  }

  sidecarUrl = null;
  internalToken = null;
  sidecarHealthy = false;
}

export async function restartAgentSidecar(options?: {
  onProgress?: SidecarProgressCallback;
}): Promise<{
  containerId: string;
  url: string;
} | null> {
  await removeAgentSidecar();
  return ensureAgentSidecar({ onProgress: options?.onProgress });
}

// ---------------------------------------------------------------------------
// Proxy helper
// ---------------------------------------------------------------------------

export async function proxyToSidecar(
  path: string,
  options: { method: string; body?: unknown },
): Promise<Response> {
  if (!sidecarUrl) {
    throw new Error("Agent sidecar not available");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (internalToken) {
    headers["Authorization"] = `Bearer ${internalToken}`;
  }

  const fetchOptions: RequestInit = {
    method: options.method,
    headers,
    signal: AbortSignal.timeout(60_000),
  };

  if (
    options.body &&
    ["POST", "PUT", "PATCH"].includes(options.method.toUpperCase())
  ) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  return fetch(`${sidecarUrl}${path}`, fetchOptions);
}

// Import Docker types
import type Docker from "dockerode";
