import { loadbalancerLogger } from "../../lib/logger-factory";
import { HAProxyDataPlaneClient } from "./haproxy-dataplane-client";
import { HAProxyFrontendManager } from "./haproxy-frontend-manager";
import { PrismaClient } from "@prisma/client";
import { generateSharedFrontendName } from "./haproxy-naming";

const logger = loadbalancerLogger();

/**
 * Result of a remediation operation
 */
export interface RemediationResult {
  success: boolean;
  frontendsDeleted: number;
  frontendsCreated: number;
  backendsRecreated: number;
  routesConfigured: number;
  statsFrontendConfigured: boolean;
  errors: string[];
}

// The stats frontend name as defined in haproxy.cfg template
const STATS_FRONTEND_NAME = 'stats';

// The prometheus-exporter http-request rule that must always be present
const PROMETHEUS_HTTP_REQUEST_RULE = {
  type: 'use-service',
  service_name: 'prometheus-exporter',
  cond: 'if',
  cond_test: '{ path /metrics }',
} as const;

/**
 * Preview of what remediation would do
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
    routes: Array<{ hostname: string; backend: string; ssl: boolean }>;
    backends: string[];
  };
  changes: {
    frontendsToDelete: string[];
    frontendsToCreate: string[];
    backendsToRecreate: string[];
    routesToAdd: string[];
  };
}

/**
 * HAProxyRemediationService handles full remediation of HAProxy configuration
 * for an environment. This includes deleting legacy per-app frontends and
 * creating a single shared frontend with hostname-based routing.
 */
export class HAProxyRemediationService {
  private frontendManager: HAProxyFrontendManager;

  constructor() {
    this.frontendManager = new HAProxyFrontendManager();
  }

  /**
   * Full remediation of HAProxy for an environment
   *
   * Steps:
   * 1. Query all active DeploymentConfiguration and manual frontends
   * 2. Delete all existing frontends from HAProxy via DataPlane API
   * 3. Delete all backends via DataPlane API
   * 4. Create single http_frontend bound to *:80
   * 5. Create single https_frontend bound to *:443 with SNI (if SSL routes exist)
   * 6. For each deployment config / manual frontend:
   *    - Create backend with servers from active containers
   *    - Add ACL + backend switching rule to appropriate frontend
   * 7. Update database records
   *
   * @param environmentId The environment ID to remediate
   * @param haproxyClient The HAProxy DataPlane client instance
   * @param prisma Prisma client instance
   * @returns The result of the remediation
   */
  async remediateEnvironment(
    environmentId: string,
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient
  ): Promise<RemediationResult> {
    logger.info({ environmentId }, "Starting environment remediation");

    const result: RemediationResult = {
      success: false,
      frontendsDeleted: 0,
      frontendsCreated: 0,
      backendsRecreated: 0,
      routesConfigured: 0,
      statsFrontendConfigured: false,
      errors: [],
    };

    try {
      // Step 1: Get all deployment configurations and manual frontends for this environment
      const deploymentConfigs = await prisma.deploymentConfiguration.findMany({
        where: {
          environmentId,
          isActive: true,
          hostname: { not: null },
        },
      });

      const existingFrontends = await prisma.hAProxyFrontend.findMany({
        where: {
          environmentId,
          status: { not: "removed" },
        },
      });

      logger.info(
        {
          environmentId,
          deploymentConfigCount: deploymentConfigs.length,
          existingFrontendCount: existingFrontends.length,
        },
        "Found deployment configs and existing frontends"
      );

      // Step 2: Delete existing non-shared frontends from HAProxy
      for (const frontend of existingFrontends) {
        if (!frontend.isSharedFrontend) {
          try {
            logger.info(
              { frontendName: frontend.frontendName },
              "Deleting legacy frontend from HAProxy"
            );
            await this.frontendManager.removeFrontend(
              frontend.frontendName,
              haproxyClient
            );
            result.frontendsDeleted++;

            // Update database record
            await prisma.hAProxyFrontend.update({
              where: { id: frontend.id },
              data: { status: "removed" },
            });
          } catch (error) {
            const errorMsg = `Failed to delete frontend ${frontend.frontendName}: ${error}`;
            logger.error({ error, frontendName: frontend.frontendName }, errorMsg);
            result.errors.push(errorMsg);
          }
        }
      }

      // Step 3: Create shared HTTP frontend
      let httpFrontend;
      try {
        httpFrontend = await this.frontendManager.getOrCreateSharedFrontend(
          environmentId,
          "http",
          haproxyClient,
          prisma
        );
        result.frontendsCreated++;
        logger.info(
          { frontendName: httpFrontend.frontendName },
          "Created/retrieved shared HTTP frontend"
        );
      } catch (error) {
        const errorMsg = `Failed to create shared HTTP frontend: ${error}`;
        logger.error({ error, environmentId }, errorMsg);
        result.errors.push(errorMsg);
        result.success = false;
        return result;
      }

      // Step 4: Check if any routes need SSL and create HTTPS frontend if needed
      const sslConfigs = deploymentConfigs.filter((dc) => dc.enableSsl);
      let httpsFrontend = null;

      if (sslConfigs.length > 0) {
        try {
          // Use the first available TLS certificate for the shared HTTPS frontend
          const firstCertId = sslConfigs.find((dc) => dc.tlsCertificateId)?.tlsCertificateId;
          httpsFrontend = await this.frontendManager.getOrCreateSharedFrontend(
            environmentId,
            "https",
            haproxyClient,
            prisma,
            {
              tlsCertificateId: firstCertId ?? undefined,
            }
          );
          result.frontendsCreated++;
          logger.info(
            { frontendName: httpsFrontend.frontendName },
            "Created/retrieved shared HTTPS frontend"
          );
        } catch (error) {
          const errorMsg = `Failed to create shared HTTPS frontend: ${error}`;
          logger.error({ error, environmentId }, errorMsg);
          result.errors.push(errorMsg);
        }
      }

      // Step 5: Add routes for each deployment configuration
      for (const config of deploymentConfigs) {
        if (!config.hostname) continue;

        try {
          // Determine which frontend to use
          const targetFrontend =
            config.enableSsl && httpsFrontend ? httpsFrontend : httpFrontend;

          // Add route to shared frontend
          await this.frontendManager.addRouteToSharedFrontend(
            targetFrontend.id,
            config.hostname,
            config.applicationName, // Backend name matches app name
            "deployment",
            config.id,
            haproxyClient,
            prisma,
            {
              useSSL: config.enableSsl,
              tlsCertificateId: config.tlsCertificateId ?? undefined,
            }
          );
          result.routesConfigured++;

          logger.info(
            {
              hostname: config.hostname,
              backendName: config.applicationName,
              frontendName: targetFrontend.frontendName,
            },
            "Added route for deployment config"
          );
        } catch (error) {
          const errorMsg = `Failed to add route for ${config.hostname}: ${error}`;
          logger.error({ error, hostname: config.hostname }, errorMsg);
          result.errors.push(errorMsg);
        }
      }

      // Step 6: Add routes for manual frontends
      const manualFrontends = existingFrontends.filter(
        (f) => f.frontendType === "manual" && f.hostname
      );

      for (const manual of manualFrontends) {
        try {
          const targetFrontend = manual.useSSL && httpsFrontend ? httpsFrontend : httpFrontend;

          await this.frontendManager.addRouteToSharedFrontend(
            targetFrontend.id,
            manual.hostname,
            manual.backendName,
            "manual",
            manual.id,
            haproxyClient,
            prisma,
            {
              useSSL: manual.useSSL,
              tlsCertificateId: manual.tlsCertificateId ?? undefined,
            }
          );
          result.routesConfigured++;

          logger.info(
            {
              hostname: manual.hostname,
              backendName: manual.backendName,
              frontendName: targetFrontend.frontendName,
            },
            "Added route for manual frontend"
          );
        } catch (error) {
          const errorMsg = `Failed to add route for manual frontend ${manual.hostname}: ${error}`;
          logger.error({ error, hostname: manual.hostname }, errorMsg);
          result.errors.push(errorMsg);
        }
      }

      // Final step: ensure global stats frontend config (e.g. prometheus-exporter rule)
      try {
        result.statsFrontendConfigured = await this.ensureStatsFrontendConfig(haproxyClient);
      } catch (error) {
        const errorMsg = `Failed to ensure stats frontend config: ${error}`;
        logger.error({ error }, errorMsg);
        result.errors.push(errorMsg);
      }

      result.success = result.errors.length === 0;

      logger.info(
        {
          environmentId,
          result,
        },
        "Completed environment remediation"
      );

      return result;
    } catch (error) {
      logger.error({ error, environmentId }, "Failed to remediate environment");
      result.errors.push(`Remediation failed: ${error}`);
      result.success = false;
      return result;
    }
  }

  /**
   * Get current state vs expected state for an environment
   *
   * @param environmentId The environment ID
   * @param haproxyClient The HAProxy DataPlane client instance
   * @param prisma Prisma client instance
   * @returns Preview of what remediation would do
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

      // Get deployment configurations
      const deploymentConfigs = await prisma.deploymentConfiguration.findMany({
        where: {
          environmentId,
          isActive: true,
          hostname: { not: null },
        },
      });

      // Build current state
      const currentFrontends = existingFrontends.map((f) => f.frontendName);

      // Try to get current backends from HAProxy
      let currentBackends: string[] = [];
      try {
        const backends = await haproxyClient.listBackends();
        currentBackends = backends.map((b: any) => b.name);
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

      // Build expected state
      const sharedHttpFrontend = generateSharedFrontendName(environmentId, "http");
      const hasSSL = deploymentConfigs.some((dc) => dc.enableSsl);
      const sharedHttpsFrontend = hasSSL
        ? generateSharedFrontendName(environmentId, "https")
        : null;

      const expectedRoutes = deploymentConfigs
        .filter((dc) => dc.hostname)
        .map((dc) => ({
          hostname: dc.hostname!,
          backend: dc.applicationName,
          ssl: dc.enableSsl,
        }));

      // Add manual frontends as expected routes
      const manualFrontends = existingFrontends.filter(
        (f) => f.frontendType === "manual" && f.hostname
      );
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
      const legacyFrontends = existingFrontends.filter(
        (f) => !f.isSharedFrontend && f.frontendType !== "shared"
      );
      const frontendsToDelete = legacyFrontends.map((f) => f.frontendName);

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

      const routesToAdd = expectedRoutes.map((r) => r.hostname);

      // Backends that exist in DB but not in HAProxy runtime need recreation
      const backendsToRecreate = dbBackends.filter(
        (name) => !currentBackends.includes(name)
      );

      const needsRemediation =
        frontendsToDelete.length > 0 ||
        frontendsToCreate.length > 0 ||
        backendsToRecreate.length > 0 ||
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
          routes: expectedRoutes,
          backends: expectedBackends,
        },
        changes: {
          frontendsToDelete,
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
      throw new Error(`Failed to get remediation preview: ${error}`);
    }
  }

  /**
   * Check if remediation is needed
   *
   * @param environmentId The environment ID
   * @param haproxyClient The HAProxy DataPlane client instance
   * @param prisma Prisma client instance
   * @returns True if remediation is needed
   */
  async isRemediationNeeded(
    environmentId: string,
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient
  ): Promise<boolean> {
    try {
      const preview = await this.getRemediationPreview(
        environmentId,
        haproxyClient,
        prisma
      );
      return preview.needsRemediation;
    } catch (error) {
      logger.error(
        { error, environmentId },
        "Failed to check if remediation is needed"
      );
      // If we can't check, assume remediation might be needed
      return true;
    }
  }

  /**
   * Ensure the stats frontend has the required global config rules.
   * Currently ensures the Prometheus exporter http-request rule is present.
   * This is idempotent — safe to call on every remediation or startup.
   *
   * @param haproxyClient The HAProxy DataPlane client instance
   * @returns true if the rule was added, false if it was already present
   */
  async ensureStatsFrontendConfig(haproxyClient: HAProxyDataPlaneClient): Promise<boolean> {
    logger.info({ frontendName: STATS_FRONTEND_NAME }, 'Ensuring stats frontend global config');

    const applied = await haproxyClient.ensureHttpRequestRule(
      STATS_FRONTEND_NAME,
      PROMETHEUS_HTTP_REQUEST_RULE
    );

    if (applied) {
      logger.info(
        { frontendName: STATS_FRONTEND_NAME, rule: PROMETHEUS_HTTP_REQUEST_RULE },
        'Applied missing prometheus-exporter rule to stats frontend'
      );
    } else {
      logger.debug(
        { frontendName: STATS_FRONTEND_NAME },
        'Stats frontend already has prometheus-exporter rule'
      );
    }

    return applied;
  }
}

// Export singleton instance
export const haproxyRemediationService = new HAProxyRemediationService();
