/**
 * Container Socket Emitter
 *
 * Bridges Docker container state changes to Socket.IO events.
 * Registers a callback on the Docker service that fires when containers change,
 * then fetches the fresh list and emits it to subscribed clients.
 *
 * Uses a trailing debounce to avoid flooding clients when Docker fires
 * bursts of events (e.g., during deployments).
 */

import DockerService from "./docker";
import { Channel, ServerEvent } from "@mini-infra/types";
import { fetchAndSerializeContainers } from "./container-serializer";
import { emitToChannel } from "../lib/socket";
import { servicesLogger } from "../lib/logger-factory";

const logger = servicesLogger();

const DEBOUNCE_MS = 500;

/**
 * Wire up the Docker service to emit Socket.IO events on container changes.
 * Call this once during server startup, after both Docker and Socket.IO are initialized.
 */
export function setupContainerSocketEmitter(): void {
  const dockerService = DockerService.getInstance();

  let debounceTimer: NodeJS.Timeout | null = null;

  dockerService.onContainerChange(() => {
    // Debounce: reset timer on each event, only fire after quiet period
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      try {
        if (!dockerService.isConnected()) {
          return;
        }

        const containers = await fetchAndSerializeContainers(dockerService);

        emitToChannel(Channel.CONTAINERS, ServerEvent.CONTAINERS_LIST, {
          containers,
          totalCount: containers.length,
        });

        // Also notify volumes and networks channels — Docker events often
        // indicate that volumes/networks have changed (container create/remove).
        emitToChannel(Channel.VOLUMES, ServerEvent.VOLUMES_LIST, {
          count: -1, // Signal to invalidate; client will refetch
        });
        emitToChannel(Channel.NETWORKS, ServerEvent.NETWORKS_LIST, {
          count: -1,
        });

        logger.debug(
          { count: containers.length },
          "Emitted containers:list, volumes:list, networks:list via socket",
        );
      } catch (error) {
        // Socket emit failures should never crash the service
        logger.error(
          { error: error instanceof Error ? error.message : error },
          "Failed to emit container update via socket",
        );
      }
    }, DEBOUNCE_MS);
  });

  logger.info("Container socket emitter initialized");
}
