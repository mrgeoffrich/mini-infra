import {
  DockerEventPatternDetector,
  type DockerContainerEvent,
} from "../../lib/docker-event-pattern-detector";
import { loadbalancerLogger } from "../../lib/logger-factory";
import { repairHAProxyConfig } from "./haproxy-config-repair";
import prisma from "../../lib/prisma";
import DockerService from "../docker";
import { UserEventService } from "../user-events";

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
      !!event.labels["mini-infra.stack-id"] &&
      !!event.labels["mini-infra.environment"],
    threshold: 3,
    windowMs: 5 * 60_000,
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

      const userEventService = new UserEventService(prisma);
      let userEventId: string | undefined;

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

        // Create user event so the crash loop + repair is visible in the UI
        const userEvent = await userEventService.createEvent({
          eventType: "system_maintenance",
          eventCategory: "infrastructure",
          eventName: `HAProxy crash loop detected: ${env.name}`,
          triggeredBy: "system",
          status: "running",
          resourceId: environmentId,
          resourceType: "environment",
          resourceName: env.name,
          description: `HAProxy container "${sample.containerName}" died ${events.length} times in 5 minutes. Attempting automatic config repair.`,
          metadata: {
            stackId,
            containerName: sample.containerName,
            dieCount: events.length,
          },
        });
        userEventId = userEvent.id;

        const volumeName = `${env.name}-haproxy_haproxy_config`;
        const repaired = await repairHAProxyConfig(volumeName);

        if (repaired) {
          logger.info(
            { environmentId, volumeName },
            "HAProxy config repaired — Docker restart policy will restart the container",
          );
          await userEventService.updateEvent(userEventId, {
            status: "completed",
            progress: 100,
            completedAt: new Date().toISOString(),
            resultSummary: "Config repaired: injected Docker DNS resolvers. HAProxy will restart automatically.",
          });
        } else {
          logger.info(
            { environmentId, volumeName },
            "HAProxy config already has resolvers — crash loop may have a different cause",
          );
          await userEventService.updateEvent(userEventId, {
            status: "completed",
            progress: 100,
            completedAt: new Date().toISOString(),
            resultSummary: "Config already has DNS resolvers — crash loop may have a different cause. Check HAProxy logs.",
          });
        }
      } catch (err) {
        logger.error(
          { environmentId, stackId, error: err },
          "Failed to repair HAProxy config",
        );
        if (userEventId) {
          try {
            await userEventService.updateEvent(userEventId, {
              status: "failed",
              completedAt: new Date().toISOString(),
              errorMessage: err instanceof Error ? err.message : String(err),
              resultSummary: "Automatic config repair failed. Manual intervention required.",
            });
          } catch {
            // Don't let event update failure mask the original error
          }
        }
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
