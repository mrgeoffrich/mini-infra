import {
  DockerEventPatternDetector,
  type DockerContainerEvent,
} from "../../lib/docker-event-pattern-detector";
import { loadbalancerLogger } from "../../lib/logger-factory";
import { repairHAProxyConfig } from "./haproxy-config-repair";
import prisma from "../../lib/prisma";
import DockerService from "../docker";

const logger = loadbalancerLogger();

let detector: DockerEventPatternDetector | null = null;

/**
 * Set up a crash-loop detector that watches for repeated HAProxy container
 * "die" events and automatically repairs the config volume.
 *
 * Call this once during server startup, after Docker is initialized.
 */
export function setupHAProxyCrashLoopWatcher(): void {
  detector = new DockerEventPatternDetector({
    name: "haproxy-crash-loop",
    matchEvent: (event: DockerContainerEvent) =>
      event.action === "die" &&
      event.labels["mini-infra.service"] === "haproxy" &&
      !!event.labels["mini-infra.stack-id"],
    threshold: 3,
    windowMs: 60_000,
    cooldownMs: 5 * 60_000,
    onDetected: async (events) => {
      const sample = events[0];
      const environmentId = sample.labels["mini-infra.environment"];
      const stackId = sample.labels["mini-infra.stack-id"];

      logger.warn(
        {
          environmentId,
          stackId,
          containerName: sample.containerName,
          dieCount: events.length,
        },
        "HAProxy crash loop detected — attempting config repair",
      );

      try {
        // Look up environment name to derive the volume name
        const env = await prisma.environment.findUnique({
          where: { id: environmentId },
          select: { name: true },
        });

        if (!env) {
          logger.error(
            { environmentId },
            "Cannot repair: environment not found in database",
          );
          return;
        }

        const volumeName = `${env.name}-haproxy_haproxy_config`;
        const repaired = await repairHAProxyConfig(volumeName);

        if (repaired) {
          logger.info(
            { environmentId, volumeName },
            "HAProxy config repaired — Docker restart policy will restart the container",
          );
        } else {
          logger.info(
            { environmentId, volumeName },
            "HAProxy config already has resolvers — crash loop may have a different cause",
          );
        }
      } catch (err) {
        logger.error(
          { environmentId, stackId, error: err },
          "Failed to repair HAProxy config",
        );
      }
    },
  });

  // Register with Docker event stream
  const dockerService = DockerService.getInstance();
  dockerService.onContainerEvent((event) => {
    detector!.handleEvent(event);
  });

  logger.info("HAProxy crash loop watcher initialized");
}
