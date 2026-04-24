import { getLogger } from "../../../lib/logger-factory";
import { PrismaClient } from "../../../generated/prisma/client";
import { HAProxyDataPlaneClient } from "../haproxy-dataplane-client";
import { generateFrontendName } from "../haproxy-naming";
import { addHostnameRouting } from "./acl-rule-operations";
import { configurePerDeploymentSSL } from "./ssl-binding-deployer";

const logger = getLogger("haproxy", "deployment-frontend-operations");

export interface CreateFrontendForDeploymentOptions {
  tlsCertificateId?: string;
  prisma?: PrismaClient;
  bindPort?: number;
  bindAddress?: string;
}

/**
 * Create (or update routing on) a per-deployment frontend for a hostname.
 *
 * SSL behaviour is intentionally forgiving: an SSL configuration failure is
 * logged but does NOT throw. The frontend has already been created and the
 * hostname routing is attached — marking the whole operation failed would
 * force the caller to roll back both, which was never the intent. Do not
 * change this to throw without updating all callers.
 */
export async function createFrontendForDeployment(
  hostname: string,
  backendName: string,
  applicationName: string,
  environmentId: string,
  haproxyClient: HAProxyDataPlaneClient,
  options?: CreateFrontendForDeploymentOptions
): Promise<string> {
  const bindPort = options?.bindPort ?? 80;
  const bindAddress = options?.bindAddress ?? "*";
  logger.info(
    {
      hostname,
      backendName,
      applicationName,
      environmentId,
      bindPort,
      bindAddress,
    },
    "Creating frontend for deployment"
  );

  try {
    const frontendName = generateFrontendName(applicationName, environmentId);

    const existingFrontend = await haproxyClient.getFrontend(frontendName);
    if (existingFrontend) {
      logger.warn(
        { frontendName },
        "Frontend already exists, will update routing rules"
      );
    } else {
      logger.info({ frontendName }, "Creating new frontend");
      await haproxyClient.createFrontend({ name: frontendName, mode: "http" });

      logger.info(
        { frontendName, bindAddress, bindPort },
        "Adding bind to frontend"
      );
      await haproxyClient.addFrontendBind(frontendName, bindAddress, bindPort);
    }

    await addHostnameRouting(frontendName, hostname, backendName, haproxyClient);

    if (options?.tlsCertificateId && options?.prisma) {
      logger.info(
        { frontendName, tlsCertificateId: options.tlsCertificateId },
        "SSL certificate provided, deploying to HAProxy and adding SSL binding"
      );

      try {
        await configurePerDeploymentSSL(
          frontendName,
          options.tlsCertificateId,
          options.prisma,
          haproxyClient,
          bindAddress
        );

        logger.info(
          { frontendName, tlsCertificateId: options.tlsCertificateId },
          "Successfully configured SSL binding"
        );
      } catch (sslError) {
        logger.error(
          {
            error: sslError,
            frontendName,
            tlsCertificateId: options.tlsCertificateId,
          },
          "Failed to configure SSL binding - frontend created but SSL not enabled"
        );
        // Intentionally swallowed — see method comment.
      }
    }

    logger.info(
      { frontendName, hostname, backendName, hasSsl: !!options?.tlsCertificateId },
      "Successfully created frontend with hostname routing"
    );

    return frontendName;
  } catch (error) {
    logger.error(
      { error, hostname, backendName },
      "Failed to create frontend for deployment"
    );
    throw new Error(`Failed to create frontend: ${error}`, { cause: error });
  }
}

/**
 * Remove a frontend. Treats DataPlane 404 as "already removed" and returns
 * successfully — callers rely on this idempotency during stack teardown.
 */
export async function removeFrontend(
  frontendName: string,
  haproxyClient: HAProxyDataPlaneClient
): Promise<void> {
  logger.info({ frontendName }, "Removing frontend");

  try {
    await haproxyClient.deleteFrontend(frontendName);
    logger.info({ frontendName }, "Successfully removed frontend");
  } catch (error) {
    if ((error as { response?: { status?: number } })?.response?.status === 404) {
      logger.warn(
        { frontendName },
        "Frontend not found, considering it already removed"
      );
      return;
    }

    logger.error({ error, frontendName }, "Failed to remove frontend");
    throw new Error(`Failed to remove frontend: ${error}`, { cause: error });
  }
}

/**
 * Get the current HAProxy configuration for a frontend, or `null` if missing.
 */
export async function getFrontendStatus(
  frontendName: string,
  haproxyClient: HAProxyDataPlaneClient
): Promise<Record<string, unknown> | null> {
  logger.info({ frontendName }, "Getting frontend status");

  try {
    return await haproxyClient.getFrontend(frontendName);
  } catch (error) {
    logger.error({ error, frontendName }, "Failed to get frontend status");
    throw error;
  }
}
