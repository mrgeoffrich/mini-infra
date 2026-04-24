import { getLogger } from "../../../lib/logger-factory";
import { PrismaClient } from "../../../generated/prisma/client";
import { HAProxyDataPlaneClient } from "../haproxy-dataplane-client";
import {
  addHostnameRouting,
  removeACLByName,
  removeBackendSwitchingRuleByAclName,
} from "./acl-rule-operations";
import {
  DataPlaneACL,
  DataPlaneBackendSwitchingRule,
} from "./frontend-types";
import { findSharedFrontendsWithRoutes } from "./shared-frontend-repository";

const logger = getLogger("haproxy", "environment-route-synchronizer");

/**
 * Sync all shared-frontend routes for an environment against HAProxy state.
 *
 * Reconciles HAProxy's ACL + switching-rule sets with the DB route list:
 * - Removes ACLs/rules present in HAProxy but not in the DB (orphans).
 * - Adds ACLs/rules present in the DB but missing in HAProxy.
 *
 * Returns a summary of added routes and per-operation error strings. Never
 * throws for per-route failures — those are collected into `errors` so the
 * remediator can report partial progress.
 */
export async function syncEnvironmentRoutes(
  environmentId: string,
  haproxyClient: HAProxyDataPlaneClient,
  prisma: PrismaClient
): Promise<{ synced: number; errors: string[] }> {
  logger.info({ environmentId }, "Syncing environment routes");

  const errors: string[] = [];
  let synced = 0;

  try {
    const sharedFrontends = await findSharedFrontendsWithRoutes(
      environmentId,
      prisma
    );

    for (const frontend of sharedFrontends) {
      const frontendName = frontend.frontendName;

      const haproxyACLs = (await haproxyClient.getACLs(
        frontendName
      )) as Array<DataPlaneACL>;
      const haproxyRules = (await haproxyClient.getBackendSwitchingRules(
        frontendName
      )) as Array<DataPlaneBackendSwitchingRule>;

      const expectedACLs = new Set(frontend.routes.map((r) => r.aclName));

      for (const acl of haproxyACLs) {
        if (!expectedACLs.has(acl.acl_name)) {
          try {
            logger.info(
              { frontendName, aclName: acl.acl_name },
              "Removing orphaned ACL"
            );
            await removeACLByName(
              frontendName,
              acl.acl_name,
              haproxyClient,
              haproxyACLs
            );
          } catch (err) {
            errors.push(`Failed to remove orphaned ACL ${acl.acl_name}: ${err}`);
          }
        }
      }

      for (const rule of haproxyRules) {
        if (!expectedACLs.has(rule.cond_test)) {
          try {
            logger.info(
              { frontendName, aclName: rule.cond_test },
              "Removing orphaned rule"
            );
            await removeBackendSwitchingRuleByAclName(
              frontendName,
              rule.cond_test,
              haproxyClient,
              haproxyRules
            );
          } catch (err) {
            errors.push(`Failed to remove orphaned rule: ${err}`);
          }
        }
      }

      for (const route of frontend.routes) {
        const aclExists = haproxyACLs.some(
          (a) => a.acl_name === route.aclName
        );
        const ruleExists = haproxyRules.some(
          (r) => r.cond_test === route.aclName
        );

        if (!aclExists || !ruleExists) {
          try {
            logger.info(
              { frontendName, hostname: route.hostname },
              "Adding missing route to HAProxy"
            );
            await addHostnameRouting(
              frontendName,
              route.hostname,
              route.backendName,
              haproxyClient
            );
            synced++;
          } catch (err) {
            errors.push(`Failed to add route for ${route.hostname}: ${err}`);
          }
        }
      }
    }

    logger.info(
      { environmentId, synced, errorCount: errors.length },
      "Completed environment routes sync"
    );

    return { synced, errors };
  } catch (error) {
    logger.error(
      { error, environmentId },
      "Failed to sync environment routes"
    );
    throw new Error(`Failed to sync environment routes: ${error}`, {
      cause: error,
    });
  }
}
