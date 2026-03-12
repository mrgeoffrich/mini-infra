import Docker from "dockerode";
import { logger } from "./logger";

/**
 * Captured container settings that will be applied to the new container.
 * Only includes fields we explicitly need — everything else is intentionally dropped
 * to avoid carrying over internal Docker state.
 */
export interface CapturedContainerSettings {
  name: string;
  env: string[];
  labels: Record<string, string>;
  exposedPorts: Record<string, Record<string, never>>;
  hostConfig: {
    Binds?: string[];
    PortBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    RestartPolicy?: { Name: string; MaximumRetryCount?: number };
    NetworkMode?: string;
    CapAdd?: string[];
    CapDrop?: string[];
    Tmpfs?: Record<string, string>;
    Memory?: number;
    MemorySwap?: number;
    CpuShares?: number;
    Privileged?: boolean;
  };
  networkingConfig: {
    EndpointsConfig: Record<
      string,
      { IPAMConfig?: { IPv4Address?: string }; Aliases?: string[] }
    >;
  };
}

const UPDATE_LOCK_LABEL = "mini-infra.update-lock";

/**
 * Inspects a running container and extracts the settings needed to recreate it
 * with a new image. Strips internal Docker metadata and the update-lock label.
 */
export async function inspectContainer(
  docker: Docker,
  containerId: string,
): Promise<CapturedContainerSettings> {
  logger.info({ containerId }, "Inspecting container");

  const container = docker.getContainer(containerId);
  const info = await container.inspect();

  // Strip the leading "/" from Docker container names
  const name = info.Name.replace(/^\//, "");

  // Copy labels but remove the update-lock label
  const labels = { ...info.Config.Labels };
  delete labels[UPDATE_LOCK_LABEL];

  // Build port bindings from HostConfig (authoritative for host mappings)
  const portBindings = info.HostConfig.PortBindings ?? {};

  // Build ExposedPorts from the keys in PortBindings
  const exposedPorts: Record<string, Record<string, never>> = {};
  for (const port of Object.keys(portBindings)) {
    exposedPorts[port] = {};
  }

  // Build networking config to preserve network attachments and aliases
  const networkingConfig: CapturedContainerSettings["networkingConfig"] = {
    EndpointsConfig: {},
  };
  if (info.NetworkSettings?.Networks) {
    for (const [netName, netInfo] of Object.entries(
      info.NetworkSettings.Networks,
    )) {
      const epConfig: {
        IPAMConfig?: { IPv4Address?: string };
        Aliases?: string[];
      } = {};
      if (netInfo.IPAMConfig?.IPv4Address) {
        epConfig.IPAMConfig = { IPv4Address: netInfo.IPAMConfig.IPv4Address };
      }
      if (netInfo.Aliases?.length) {
        epConfig.Aliases = netInfo.Aliases;
      }
      networkingConfig.EndpointsConfig[netName] = epConfig;
    }
  }

  const settings: CapturedContainerSettings = {
    name,
    env: info.Config.Env ?? [],
    labels,
    exposedPorts,
    hostConfig: {
      Binds: info.HostConfig.Binds ?? undefined,
      PortBindings: Object.keys(portBindings).length > 0 ? portBindings : undefined,
      RestartPolicy: info.HostConfig.RestartPolicy ?? undefined,
      NetworkMode: info.HostConfig.NetworkMode ?? undefined,
      CapAdd: info.HostConfig.CapAdd ?? undefined,
      CapDrop: info.HostConfig.CapDrop ?? undefined,
      Tmpfs: info.HostConfig.Tmpfs ?? undefined,
      Memory: info.HostConfig.Memory ?? undefined,
      MemorySwap: info.HostConfig.MemorySwap ?? undefined,
      CpuShares: info.HostConfig.CpuShares ?? undefined,
      Privileged: info.HostConfig.Privileged ?? undefined,
    },
    networkingConfig,
  };

  logger.info(
    {
      name: settings.name,
      envCount: settings.env.length,
      bindCount: settings.hostConfig.Binds?.length ?? 0,
      networkCount: Object.keys(networkingConfig.EndpointsConfig).length,
    },
    "Container settings captured",
  );

  return settings;
}
