/**
 * Container serialization utility.
 *
 * Converts internal DockerContainerInfo (with Date fields) to API-friendly
 * ContainerInfo (with ISO string dates and environment enrichment).
 *
 * Extracted from routes/containers.ts so it can be reused by both the REST
 * API and the Socket.IO container emitter.
 */

import type { ContainerInfo, DockerContainerInfo } from "@mini-infra/types";
import prisma from "../lib/prisma";
import { appLogger } from "../lib/logger-factory";
import type DockerService from "./docker";

const logger = appLogger();

/**
 * Serialize a DockerContainerInfo to a ContainerInfo suitable for API responses.
 * Enriches with environment info from the database when available.
 */
export async function serializeContainer(
  container: DockerContainerInfo,
): Promise<ContainerInfo> {
  const serialized: ContainerInfo = {
    ...container,
    createdAt: container.createdAt.toISOString(),
    startedAt: container.startedAt?.toISOString(),
  };

  // Check if container has environment label
  const environmentId = container.labels["mini-infra.environment"];
  if (environmentId) {
    try {
      const environment = await prisma.environment.findUnique({
        where: { id: environmentId },
        select: { id: true, name: true, type: true },
      });

      if (environment) {
        serialized.environmentInfo = {
          id: environment.id,
          name: environment.name,
          type: environment.type,
        };
      }
    } catch (error) {
      logger.warn(
        { error, environmentId, containerId: container.id },
        "Failed to look up environment for container",
      );
    }
  }

  return serialized;
}

/**
 * Fetch all containers from Docker and serialize them for API/socket responses.
 */
export async function fetchAndSerializeContainers(
  dockerService: DockerService,
): Promise<ContainerInfo[]> {
  const rawContainers = await dockerService.listContainers(true);
  return Promise.all(rawContainers.map(serializeContainer));
}
