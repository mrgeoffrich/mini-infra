import { getLogger } from "../../../lib/logger-factory";
import { PrismaClient } from "../../../generated/prisma/client";
import { HAProxyDataPlaneClient } from "../haproxy-dataplane-client";
import { generateSharedFrontendName } from "../haproxy-naming";
import { SharedFrontendDTO } from "./frontend-types";
import {
  createSharedFrontendRecord,
  findSharedFrontend,
  toSharedFrontendDTO,
} from "./shared-frontend-repository";
import { configureSharedSSL } from "./ssl-binding-deployer";

const logger = getLogger("haproxy", "shared-frontend-creator");

export interface GetOrCreateSharedFrontendOptions {
  bindPort?: number;
  bindAddress?: string;
  tlsCertificateId?: string;
}

/**
 * Get or create a shared frontend for an environment.
 *
 * Behaviour by `type`:
 * - `http`: creates the HAProxy frontend with a plain bind on `bindPort`.
 * - `https` **with** `tlsCertificateId`: creates the frontend, deploys the
 *   certificate, and attaches an SSL bind that points at the SNI directory.
 * - `https` **without** `tlsCertificateId`: creates the frontend but adds no
 *   bind — the SSL endpoint creates the bind later. This is deliberate; do
 *   not regress it into a plain bind.
 *
 * Always creates / reuses a matching `HAProxyFrontend` row in the database.
 */
export async function getOrCreateSharedFrontend(
  environmentId: string,
  type: "http" | "https",
  haproxyClient: HAProxyDataPlaneClient,
  prisma: PrismaClient,
  options?: GetOrCreateSharedFrontendOptions
): Promise<SharedFrontendDTO> {
  const frontendName = generateSharedFrontendName(environmentId, type);
  const bindPort = options?.bindPort ?? (type === "https" ? 443 : 80);
  const bindAddress = options?.bindAddress ?? "*";
  const tlsCertificateId = options?.tlsCertificateId;

  logger.info(
    {
      environmentId,
      type,
      frontendName,
      bindPort,
      bindAddress,
      hasTlsCert: !!tlsCertificateId,
    },
    "Getting or creating shared frontend"
  );

  try {
    const existingFrontend = await findSharedFrontend(
      environmentId,
      bindPort,
      prisma
    );

    if (existingFrontend) {
      logger.info(
        { frontendName: existingFrontend.frontendName, environmentId },
        "Shared frontend already exists in database"
      );
      return toSharedFrontendDTO(existingFrontend);
    }

    const existingHAProxyFrontend = await haproxyClient.getFrontend(frontendName);

    if (!existingHAProxyFrontend) {
      logger.info({ frontendName }, "Creating shared frontend in HAProxy");
      await haproxyClient.createFrontend({ name: frontendName, mode: "http" });

      if (type === "https" && tlsCertificateId) {
        logger.info(
          { frontendName, bindAddress, bindPort, tlsCertificateId },
          "Configuring HTTPS shared frontend with SSL"
        );
        await configureSharedSSL(
          frontendName,
          tlsCertificateId,
          prisma,
          haproxyClient,
          bindAddress,
          bindPort
        );
      } else if (type === "https") {
        // HTTPS without cert: bind is deferred until SSL endpoint configures it.
        logger.info(
          { frontendName, bindPort },
          "HTTPS shared frontend created without bind - SSL must be configured separately"
        );
      } else {
        logger.info(
          { frontendName, bindAddress, bindPort },
          "Adding bind to HTTP shared frontend"
        );
        await haproxyClient.addFrontendBind(frontendName, bindAddress, bindPort);
      }
    } else {
      logger.info({ frontendName }, "Shared frontend already exists in HAProxy");
    }

    const newFrontend = await createSharedFrontendRecord(
      {
        environmentId,
        frontendName,
        bindPort,
        bindAddress,
        useSSL: type === "https" && !!tlsCertificateId,
        tlsCertificateId: tlsCertificateId ?? null,
      },
      prisma
    );

    logger.info(
      {
        frontendId: newFrontend.id,
        frontendName,
        environmentId,
        useSSL: newFrontend.useSSL,
      },
      "Created shared frontend"
    );

    return toSharedFrontendDTO(newFrontend);
  } catch (error) {
    logger.error(
      { error, environmentId, type },
      "Failed to get or create shared frontend"
    );
    throw new Error(`Failed to get or create shared frontend: ${error}`, {
      cause: error,
    });
  }
}
