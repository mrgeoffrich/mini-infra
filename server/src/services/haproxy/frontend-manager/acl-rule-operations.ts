import { getLogger } from "../../../lib/logger-factory";
import { HAProxyDataPlaneClient } from "../haproxy-dataplane-client";
import { generateACLName } from "../haproxy-naming";
import {
  DataPlaneACL,
  DataPlaneBackendSwitchingRule,
} from "./frontend-types";

const logger = getLogger("haproxy", "acl-rule-operations");

/** Detect DataPlane "already exists" responses that are safe to swallow. */
function isAlreadyExistsError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 409) return true;
  const message = error instanceof Error ? error.message : "";
  return message.includes("already exists");
}

/**
 * Add an ACL to a frontend, tolerating 409/"already exists" by logging a warning
 * and continuing. The criterion is passed as a full string (e.g. "hdr(host) -i example.com")
 * and split into fetch method + value before being sent to the DataPlane client.
 */
export async function addACL(
  frontendName: string,
  aclName: string,
  fullCriterion: string,
  haproxyClient: HAProxyDataPlaneClient
): Promise<void> {
  logger.info({ frontendName, aclName, fullCriterion }, "Adding ACL to frontend");

  const firstSpaceIndex = fullCriterion.indexOf(" ");
  if (firstSpaceIndex === -1) {
    throw new Error(`Invalid ACL criterion format: ${fullCriterion}`);
  }
  const criterion = fullCriterion.substring(0, firstSpaceIndex).trim();
  const value = fullCriterion.substring(firstSpaceIndex + 1).trim();

  try {
    await haproxyClient.addACL(frontendName, aclName, criterion, value);
    logger.info({ frontendName, aclName }, "Successfully added ACL to frontend");
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      logger.warn({ frontendName, aclName }, "ACL already exists, continuing");
      return;
    }
    logger.error({ error, frontendName, aclName }, "Failed to add ACL");
    throw new Error(`Failed to add ACL: ${error}`, { cause: error });
  }
}

/**
 * Add a backend switching rule to a frontend, tolerating 409/"already exists"
 * by logging a warning and continuing.
 */
export async function addBackendSwitchingRule(
  frontendName: string,
  aclName: string,
  backendName: string,
  haproxyClient: HAProxyDataPlaneClient
): Promise<void> {
  logger.info(
    { frontendName, aclName, backendName },
    "Adding backend switching rule to frontend"
  );

  try {
    await haproxyClient.addBackendSwitchingRule(
      frontendName,
      backendName,
      aclName,
      "if"
    );
    logger.info(
      { frontendName, backendName, aclName },
      "Successfully added backend switching rule"
    );
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      logger.warn(
        { frontendName, backendName },
        "Backend switching rule already exists, continuing"
      );
      return;
    }
    logger.error(
      { error, frontendName, backendName },
      "Failed to add backend switching rule"
    );
    throw new Error(`Failed to add backend switching rule: ${error}`, {
      cause: error,
    });
  }
}

/**
 * Add hostname-based routing to a frontend. Creates the ACL for hostname matching
 * and the corresponding backend switching rule.
 */
export async function addHostnameRouting(
  frontendName: string,
  hostname: string,
  backendName: string,
  haproxyClient: HAProxyDataPlaneClient
): Promise<void> {
  logger.info(
    { frontendName, hostname, backendName },
    "Adding hostname routing to frontend"
  );

  try {
    const aclName = generateACLName(hostname);
    await addACL(
      frontendName,
      aclName,
      `hdr(host) -i ${hostname}`,
      haproxyClient
    );
    await addBackendSwitchingRule(frontendName, aclName, backendName, haproxyClient);
    logger.info(
      { frontendName, hostname, backendName },
      "Successfully added hostname routing"
    );
  } catch (error) {
    logger.error(
      { error, frontendName, hostname, backendName },
      "Failed to add hostname routing"
    );
    throw error;
  }
}

/**
 * Remove the ACL with the given name from a frontend, if it exists.
 *
 * @param prefetchedACLs Optional pre-fetched ACL list. When provided, this
 *   function skips the extra round-trip to `getACLs`. Callers that already
 *   hold a list (e.g. the environment synchronizer) should pass it through.
 * @returns `true` if an ACL was deleted, `false` if it was not present.
 */
export async function removeACLByName(
  frontendName: string,
  aclName: string,
  haproxyClient: HAProxyDataPlaneClient,
  prefetchedACLs?: readonly Record<string, unknown>[]
): Promise<boolean> {
  const acls = (prefetchedACLs ??
    (await haproxyClient.getACLs(frontendName))) as Array<DataPlaneACL>;
  const aclIndex = acls.findIndex((acl) => acl.acl_name === aclName);

  if (aclIndex === -1) {
    logger.warn({ frontendName, aclName }, "ACL not found in HAProxy");
    return false;
  }

  logger.info({ frontendName, aclName, aclIndex }, "Removing ACL");
  await haproxyClient.deleteACL(frontendName, aclIndex);
  return true;
}

/**
 * Remove the backend switching rule matching the given ACL name from a frontend,
 * if present.
 *
 * @param prefetchedRules Optional pre-fetched rule list (same semantics as
 *   `prefetchedACLs` on `removeACLByName`).
 * @returns `true` if a rule was deleted, `false` if none matched.
 */
export async function removeBackendSwitchingRuleByAclName(
  frontendName: string,
  aclName: string,
  haproxyClient: HAProxyDataPlaneClient,
  prefetchedRules?: readonly Record<string, unknown>[]
): Promise<boolean> {
  const rules = (prefetchedRules ??
    (await haproxyClient.getBackendSwitchingRules(
      frontendName
    ))) as Array<DataPlaneBackendSwitchingRule>;
  const ruleIndex = rules.findIndex((rule) => rule.cond_test === aclName);

  if (ruleIndex === -1) {
    logger.warn(
      { frontendName, aclName },
      "Backend switching rule not found in HAProxy"
    );
    return false;
  }

  logger.info(
    { frontendName, aclName, ruleIndex },
    "Removing backend switching rule"
  );
  await haproxyClient.deleteBackendSwitchingRule(frontendName, ruleIndex);
  return true;
}
