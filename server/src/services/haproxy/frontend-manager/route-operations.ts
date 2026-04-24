import { getLogger } from "../../../lib/logger-factory";
import { PrismaClient } from "../../../generated/prisma/client";
import { HAProxyDataPlaneClient } from "../haproxy-dataplane-client";
import { generateACLName } from "../haproxy-naming";
import {
  addHostnameRouting,
  removeACLByName,
  removeBackendSwitchingRuleByAclName,
} from "./acl-rule-operations";
import { HAProxyRouteDTO, UpdatedHAProxyRouteDTO } from "./frontend-types";
import {
  createRouteRecord,
  findRouteByHostname,
  findSharedFrontendById,
  toRouteDTO,
} from "./shared-frontend-repository";
import { uploadCertificateForSNI } from "./ssl-binding-deployer";

const logger = getLogger("haproxy", "route-operations");

/**
 * Update an existing frontend's backend switching rule for a given hostname.
 * If the rule does not exist, a new one is created (same self-heal semantics
 * as the original manager had inline).
 */
export async function updateFrontendBackend(
  frontendName: string,
  hostname: string,
  newBackendName: string,
  haproxyClient: HAProxyDataPlaneClient
): Promise<void> {
  logger.info(
    { frontendName, hostname, newBackendName },
    "Updating frontend backend"
  );

  try {
    const aclName = generateACLName(hostname);
    const existingRules = await haproxyClient.getBackendSwitchingRules(frontendName);

    const ruleIndex = existingRules.findIndex(
      (rule: { cond_test?: string }) => rule.cond_test === aclName
    );

    if (ruleIndex === -1) {
      logger.warn(
        { frontendName, aclName },
        "No existing rule found, creating new one"
      );
      // Missing rule => fall back to the full add-hostname-routing path. ACL
      // may also be missing, and addHostnameRouting handles both with its
      // already-exists tolerance.
      await addHostnameRouting(frontendName, hostname, newBackendName, haproxyClient);
      return;
    }

    await haproxyClient.updateBackendSwitchingRule(frontendName, ruleIndex, {
      name: newBackendName,
      cond: "if",
      cond_test: aclName,
    });

    logger.info(
      { frontendName, hostname, newBackendName },
      "Successfully updated frontend backend"
    );
  } catch (error) {
    logger.error(
      { error, frontendName, hostname, newBackendName },
      "Failed to update frontend backend"
    );
    throw error;
  }
}

/**
 * Add a route (ACL + backend switching rule) to a shared frontend. If a route
 * already exists for the given hostname it is returned as-is and HAProxy state
 * is not touched — callers relied on this idempotency in the original.
 */
export async function addRouteToSharedFrontend(
  sharedFrontendId: string,
  hostname: string,
  backendName: string,
  sourceType: "manual" | "stack",
  sourceId: string,
  haproxyClient: HAProxyDataPlaneClient,
  prisma: PrismaClient,
  sslOptions?: { useSSL: boolean; tlsCertificateId?: string }
): Promise<HAProxyRouteDTO> {
  logger.info(
    { sharedFrontendId, hostname, backendName, sourceType, sourceId },
    "Adding route to shared frontend"
  );

  try {
    const sharedFrontend = await findSharedFrontendById(sharedFrontendId, prisma);
    if (!sharedFrontend) {
      throw new Error(`Shared frontend not found: ${sharedFrontendId}`);
    }
    if (!sharedFrontend.isSharedFrontend) {
      throw new Error(`Frontend ${sharedFrontendId} is not a shared frontend`);
    }

    const frontendName = sharedFrontend.frontendName;
    const aclName = generateACLName(hostname);

    const existingRoute = await findRouteByHostname(sharedFrontendId, hostname, prisma);
    if (existingRoute) {
      logger.warn(
        { hostname, sharedFrontendId },
        "Route already exists for this hostname"
      );
      return toRouteDTO(existingRoute);
    }

    await addHostnameRouting(frontendName, hostname, backendName, haproxyClient);

    if (sslOptions?.useSSL && sslOptions?.tlsCertificateId) {
      // Ensure the cert lands in /etc/haproxy/ssl/ for SNI selection.
      await uploadCertificateForSNI(
        sslOptions.tlsCertificateId,
        prisma,
        haproxyClient
      );
    }

    const route = await createRouteRecord(
      {
        sharedFrontendId,
        hostname,
        aclName,
        backendName,
        sourceType,
        sourceId,
        useSSL: sslOptions?.useSSL ?? false,
        tlsCertificateId: sslOptions?.tlsCertificateId ?? null,
      },
      prisma
    );

    logger.info(
      { routeId: route.id, hostname, backendName, frontendName },
      "Successfully added route to shared frontend"
    );

    return toRouteDTO(route);
  } catch (error) {
    logger.error(
      { error, sharedFrontendId, hostname, backendName },
      "Failed to add route to shared frontend"
    );
    throw new Error(`Failed to add route to shared frontend: ${error}`, {
      cause: error,
    });
  }
}

/**
 * Remove a route from a shared frontend. Removes the ACL + switching rule from
 * HAProxy and deletes the route row. Missing HAProxy objects are treated as
 * "already removed" warnings — the DB delete still happens.
 */
export async function removeRouteFromSharedFrontend(
  sharedFrontendId: string,
  hostname: string,
  haproxyClient: HAProxyDataPlaneClient,
  prisma: PrismaClient
): Promise<void> {
  logger.info(
    { sharedFrontendId, hostname },
    "Removing route from shared frontend"
  );

  try {
    const sharedFrontend = await findSharedFrontendById(sharedFrontendId, prisma);
    if (!sharedFrontend) {
      throw new Error(`Shared frontend not found: ${sharedFrontendId}`);
    }

    const frontendName = sharedFrontend.frontendName;
    const aclName = generateACLName(hostname);

    const route = await findRouteByHostname(sharedFrontendId, hostname, prisma);
    if (!route) {
      logger.warn(
        { hostname, sharedFrontendId },
        "Route not found in database, may have been already removed"
      );
    }

    await removeBackendSwitchingRuleByAclName(frontendName, aclName, haproxyClient);
    await removeACLByName(frontendName, aclName, haproxyClient);

    if (route) {
      await prisma.hAProxyRoute.delete({ where: { id: route.id } });
    }

    logger.info(
      { hostname, frontendName },
      "Successfully removed route from shared frontend"
    );
  } catch (error) {
    logger.error(
      { error, sharedFrontendId, hostname },
      "Failed to remove route from shared frontend"
    );
    throw new Error(`Failed to remove route from shared frontend: ${error}`, {
      cause: error,
    });
  }
}

/**
 * Update an existing route. Handles three distinct change sets:
 * - hostname changed (maybe with backend too): re-create ACL + rule under the
 *   new hostname, leaving the old ACL/rule removed.
 * - backend-only change: update the switching rule in place.
 * - other fields only (priority / status / useSSL / cert): DB only.
 */
export async function updateRoute(
  routeId: string,
  updates: {
    hostname?: string;
    backendName?: string;
    useSSL?: boolean;
    tlsCertificateId?: string | null;
    priority?: number;
    status?: string;
  },
  haproxyClient: HAProxyDataPlaneClient,
  prisma: PrismaClient
): Promise<UpdatedHAProxyRouteDTO> {
  logger.info({ routeId, updates }, "Updating route");

  try {
    const existingRoute = await prisma.hAProxyRoute.findUnique({
      where: { id: routeId },
      include: { sharedFrontend: true },
    });

    if (!existingRoute) {
      throw new Error(`Route not found: ${routeId}`);
    }

    const frontendName = existingRoute.sharedFrontend.frontendName;
    const oldAclName = existingRoute.aclName;

    if (updates.hostname && updates.hostname !== existingRoute.hostname) {
      await removeBackendSwitchingRuleByAclName(frontendName, oldAclName, haproxyClient);
      await removeACLByName(frontendName, oldAclName, haproxyClient);

      await addHostnameRouting(
        frontendName,
        updates.hostname,
        updates.backendName ?? existingRoute.backendName,
        haproxyClient
      );
    } else if (
      updates.backendName &&
      updates.backendName !== existingRoute.backendName
    ) {
      await updateFrontendBackend(
        frontendName,
        existingRoute.hostname,
        updates.backendName,
        haproxyClient
      );
    }

    const updatedRoute = await prisma.hAProxyRoute.update({
      where: { id: routeId },
      data: {
        hostname: updates.hostname ?? existingRoute.hostname,
        aclName: updates.hostname
          ? generateACLName(updates.hostname)
          : existingRoute.aclName,
        backendName: updates.backendName ?? existingRoute.backendName,
        useSSL: updates.useSSL ?? existingRoute.useSSL,
        tlsCertificateId:
          updates.tlsCertificateId !== undefined
            ? updates.tlsCertificateId
            : existingRoute.tlsCertificateId,
        ...(updates.priority !== undefined && { priority: updates.priority }),
        ...(updates.status !== undefined && { status: updates.status }),
      },
    });

    logger.info({ routeId, updates }, "Successfully updated route");

    return {
      id: updatedRoute.id,
      hostname: updatedRoute.hostname,
      aclName: updatedRoute.aclName,
      backendName: updatedRoute.backendName,
      useSSL: updatedRoute.useSSL,
      priority: updatedRoute.priority,
      status: updatedRoute.status,
    };
  } catch (error) {
    logger.error({ error, routeId, updates }, "Failed to update route");
    throw new Error(`Failed to update route: ${error}`, { cause: error });
  }
}
