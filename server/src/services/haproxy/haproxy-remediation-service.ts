import { loadbalancerLogger } from "../../lib/logger-factory";
import { HAProxyDataPlaneClient } from "./haproxy-dataplane-client";
import { PrismaClient } from "@prisma/client";
import { generateSharedFrontendName } from "./haproxy-naming";

const logger = loadbalancerLogger();

/**
 * Preview of what a full HAProxy rebuild would do
 */
export interface RemediationPreview {
  needsRemediation: boolean;
  currentState: {
    frontends: string[];
    backends: string[];
  };
  expectedState: {
    sharedHttpFrontend: string | null;
    sharedHttpsFrontend: string | null;
    manualFrontends: Array<{ frontendName: string; hostname: string; containerName: string | null }>;
    routes: Array<{ hostname: string; backend: string; ssl: boolean }>;
    backends: string[];
  };
  changes: {
    frontendsToCreate: string[];
    backendsToRecreate: string[];
    routesToAdd: string[];
  };
}

/**
 * HAProxyRemediationService provides preview/diagnostic capabilities for
 * HAProxy configuration. The actual rebuild is performed by
 * restoreHAProxyRuntimeState() in haproxy-post-apply.ts.
 */
export class HAProxyRemediationService {
  /**
   * Get current state vs expected state for an environment.
   * Used by the UI to show what a rebuild would change.
   */
  async getRemediationPreview(
    environmentId: string,
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient
  ): Promise<RemediationPreview> {
    logger.info({ environmentId }, "Getting remediation preview");

    try {
      // Get current state from database
      const existingFrontends = await prisma.hAProxyFrontend.findMany({
        where: {
          environmentId,
          status: { not: "removed" },
        },
      });

      // Build current state
      const currentFrontends = existingFrontends.map((f) => f.frontendName);

      // Try to get current backends from HAProxy
      let currentBackends: string[] = [];
      try {
        const backends = await haproxyClient.listBackends();
        currentBackends = backends.map((b: { name: string }) => b.name);
      } catch {
        logger.warn("Could not fetch current backends from HAProxy");
      }

      // Get DB-tracked backends for comparison
      let dbBackends: string[] = [];
      try {
        const dbBackendRecords = await prisma.hAProxyBackend.findMany({
          where: {
            environmentId,
            status: 'active',
          },
          select: { name: true },
        });
        dbBackends = dbBackendRecords.map((b) => b.name);
      } catch {
        logger.warn("Could not fetch DB backend records");
      }

      // Build expected state — check ALL sources for SSL need
      const manualFrontends = existingFrontends.filter(
        (f) => f.frontendType === "manual" && f.hostname
      );

      const existingRoutes = await prisma.hAProxyRoute.findMany({
        where: {
          sharedFrontend: { environmentId },
          status: 'active',
        },
        select: { useSSL: true, hostname: true },
      });

      const sharedHttpFrontend = generateSharedFrontendName(environmentId, "http");
      const hasSSL =
        manualFrontends.some((mf) => mf.useSSL) ||
        existingRoutes.some((r) => r.useSSL);
      const sharedHttpsFrontend = hasSSL
        ? generateSharedFrontendName(environmentId, "https")
        : null;

      const expectedRoutes: Array<{ hostname: string; backend: string; ssl: boolean }> = [];

      // Add manual frontends as expected routes
      for (const manual of manualFrontends) {
        expectedRoutes.push({
          hostname: manual.hostname,
          backend: manual.backendName,
          ssl: manual.useSSL,
        });
      }

      const expectedBackends = [
        ...new Set(expectedRoutes.map((r) => r.backend)),
      ];

      // Determine what needs to change
      const frontendsToCreate: string[] = [];
      const sharedExists = existingFrontends.some(
        (f) => f.isSharedFrontend && f.frontendType === "shared"
      );
      if (!sharedExists) {
        frontendsToCreate.push(sharedHttpFrontend);
        if (hasSSL && sharedHttpsFrontend) {
          frontendsToCreate.push(sharedHttpsFrontend);
        }
      }

      // Only show routes that don't already have active route records
      const existingRouteHostnames = new Set(existingRoutes.map((r) => r.hostname));
      const routesToAdd = expectedRoutes
        .filter((r) => !existingRouteHostnames.has(r.hostname))
        .map((r) => r.hostname);

      // Backends that exist in DB but not in HAProxy runtime need recreation
      const backendsToRecreate = dbBackends.filter(
        (name) => !currentBackends.includes(name)
      );

      const needsRemediation =
        frontendsToCreate.length > 0 ||
        backendsToRecreate.length > 0 ||
        routesToAdd.length > 0 ||
        !sharedExists;

      return {
        needsRemediation,
        currentState: {
          frontends: currentFrontends,
          backends: currentBackends,
        },
        expectedState: {
          sharedHttpFrontend,
          sharedHttpsFrontend,
          manualFrontends: manualFrontends.map((mf) => ({
            frontendName: mf.frontendName,
            hostname: mf.hostname,
            containerName: mf.containerName,
          })),
          routes: expectedRoutes,
          backends: expectedBackends,
        },
        changes: {
          frontendsToCreate,
          backendsToRecreate,
          routesToAdd,
        },
      };
    } catch (error) {
      logger.error(
        { error, environmentId },
        "Failed to get remediation preview"
      );
      throw new Error(`Failed to get remediation preview: ${error}`, { cause: error });
    }
  }
}

// Export singleton instance
export const haproxyRemediationService = new HAProxyRemediationService();
