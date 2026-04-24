import { getLogger } from "../../../lib/logger-factory";
import { PrismaClient } from "../../../generated/prisma/client";
import { HAProxyDataPlaneClient } from "../haproxy-dataplane-client";
import { haproxyCertificateDeployer } from "../haproxy-certificate-deployer";

const logger = getLogger("haproxy", "ssl-binding-deployer");

/**
 * Configure SSL for a per-deployment frontend.
 *
 * Deploys the certificate to HAProxy and attaches it as a specific file path in
 * the SSL bind (`ssl_certificate: /etc/haproxy/ssl/<filename>`). Uses the
 * certificate's blob name as the source for the filename and requires an
 * ACTIVE cert record — both are the historical semantics of the per-deployment
 * path and must not drift to the shared-frontend flavour.
 */
export async function configurePerDeploymentSSL(
  frontendName: string,
  tlsCertificateId: string,
  prisma: PrismaClient,
  haproxyClient: HAProxyDataPlaneClient,
  bindAddress: string = "*"
): Promise<void> {
  logger.info(
    { frontendName, tlsCertificateId },
    "Configuring SSL binding for frontend"
  );

  try {
    const certFileName = await haproxyCertificateDeployer.fetchAndDeployCertificate(
      tlsCertificateId,
      prisma,
      haproxyClient,
      { requireActive: true, fileNameSource: "blobName" }
    );

    if (!certFileName) {
      throw new Error(`Failed to deploy certificate: ${tlsCertificateId}`);
    }

    logger.info(
      { frontendName, bindAddress, port: 443, certFileName },
      "Adding SSL binding to frontend"
    );

    await haproxyClient.addFrontendBind(frontendName, bindAddress, 443, {
      ssl: true,
      ssl_certificate: `/etc/haproxy/ssl/${certFileName}`,
    });

    logger.info(
      { frontendName, tlsCertificateId },
      "Successfully configured SSL binding"
    );
  } catch (error) {
    logger.error(
      { error, frontendName, tlsCertificateId },
      "Failed to configure SSL binding"
    );
    throw error;
  }
}

/**
 * Configure SSL for a shared frontend.
 *
 * Deploys the certificate to HAProxy and attaches an SSL bind that points at
 * the certificate *directory* (`/etc/haproxy/ssl/`) rather than a specific file.
 * HAProxy then selects the correct cert per request via SNI. Uses the primary
 * domain as the filename source — the shared-frontend convention.
 */
export async function configureSharedSSL(
  frontendName: string,
  tlsCertificateId: string,
  prisma: PrismaClient,
  haproxyClient: HAProxyDataPlaneClient,
  bindAddress: string = "*",
  bindPort: number = 443
): Promise<void> {
  logger.info(
    { frontendName, tlsCertificateId, bindPort },
    "Configuring SSL for shared frontend"
  );

  const certFileName = await haproxyCertificateDeployer.fetchAndDeployCertificate(
    tlsCertificateId,
    prisma,
    haproxyClient,
    { fileNameSource: "primaryDomain" }
  );

  if (!certFileName) {
    throw new Error(`Failed to deploy certificate: ${tlsCertificateId}`);
  }

  logger.info(
    { frontendName, bindAddress, bindPort, certFileName },
    "Adding SSL binding to shared frontend"
  );

  await haproxyClient.addFrontendBind(frontendName, bindAddress, bindPort, {
    ssl: true,
    // Directory path for SNI-based certificate selection
    ssl_certificate: `/etc/haproxy/ssl/`,
  });

  logger.info(
    { frontendName, tlsCertificateId },
    "Successfully configured SSL for shared frontend"
  );
}

/**
 * Upload a certificate to HAProxy storage for SNI-based selection.
 *
 * The certificate is uploaded to /etc/haproxy/ssl/ where the shared HTTPS
 * frontend bind is pointing. HAProxy will select the correct certificate
 * automatically based on the SNI hostname. Missing certificates are handled
 * gracefully — a no-op rather than a throw — which matches the historical
 * call sites that tolerate a cert record being absent.
 */
export async function uploadCertificateForSNI(
  tlsCertificateId: string,
  prisma: PrismaClient,
  haproxyClient: HAProxyDataPlaneClient
): Promise<void> {
  logger.info(
    { tlsCertificateId },
    "Uploading certificate to HAProxy for SNI selection"
  );

  const certFileName = await haproxyCertificateDeployer.fetchAndDeployCertificate(
    tlsCertificateId,
    prisma,
    haproxyClient,
    { gracefulNotFound: true }
  );

  if (certFileName) {
    logger.info(
      { certFileName, tlsCertificateId },
      "Certificate uploaded successfully for SNI selection"
    );
  }
}

/**
 * Remove a certificate from HAProxy storage when no deployment still needs it.
 */
export async function removeCertificateFromHAProxy(
  tlsCertificateId: string,
  prisma: PrismaClient,
  haproxyClient: HAProxyDataPlaneClient
): Promise<void> {
  await haproxyCertificateDeployer.removeCertificateIfUnused(
    tlsCertificateId,
    prisma,
    haproxyClient
  );
}
