import { loadbalancerLogger } from "../../lib/logger-factory";
import { HAProxyDataPlaneClient } from "./haproxy-dataplane-client";
import { PrismaClient } from "@prisma/client";
import {
  generateFrontendName,
  generateACLName,
  generateSharedFrontendName,
} from "./haproxy-naming";
import { haproxyCertificateDeployer } from "./haproxy-certificate-deployer";

const logger = loadbalancerLogger();

/**
 * HAProxyFrontendManager handles frontend creation and management for deployments
 * Includes ACL configuration for hostname-based routing
 */
export class HAProxyFrontendManager {
  /**
   * Create a frontend for a deployment with hostname-based routing
   *
   * @param hostname The hostname to route (e.g., api.example.com)
   * @param backendName The backend to route to
   * @param applicationName The application name for naming
   * @param environmentId The environment ID for naming
   * @param haproxyClient The HAProxy DataPlane client instance
   * @param options Optional configuration
   * @param options.tlsCertificateId TLS certificate ID for SSL binding
   * @param options.prisma Prisma client instance (required if tlsCertificateId is provided)
   * @param options.bindPort The port to bind on (default: 80)
   * @param options.bindAddress The address to bind on (default: *)
   * @returns The name of the created frontend
   */
  async createFrontendForDeployment(
    hostname: string,
    backendName: string,
    applicationName: string,
    environmentId: string,
    haproxyClient: HAProxyDataPlaneClient,
    options?: {
      tlsCertificateId?: string;
      prisma?: PrismaClient;
      bindPort?: number;
      bindAddress?: string;
    }
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
      // Generate frontend name: fe_{applicationName}_{environmentId}
      const frontendName = generateFrontendName(
        applicationName,
        environmentId
      );

      // Check if frontend already exists
      const existingFrontend = await this.getFrontend(
        frontendName,
        haproxyClient
      );
      if (existingFrontend) {
        logger.warn(
          { frontendName },
          "Frontend already exists, will update routing rules"
        );
      } else {
        // Create frontend
        logger.info({ frontendName }, "Creating new frontend");
        await haproxyClient.createFrontend({
          name: frontendName,
          mode: "http",
        });

        // Add bind configuration
        logger.info(
          { frontendName, bindAddress, bindPort },
          "Adding bind to frontend"
        );
        await haproxyClient.addFrontendBind(
          frontendName,
          bindAddress,
          bindPort
        );
      }

      // Add hostname routing (ACL + backend switching rule)
      await this.addHostnameRouting(
        frontendName,
        hostname,
        backendName,
        haproxyClient
      );

      // Handle SSL certificate deployment if provided
      if (options?.tlsCertificateId && options?.prisma) {
        logger.info(
          { frontendName, tlsCertificateId: options.tlsCertificateId },
          "SSL certificate provided, deploying to HAProxy and adding SSL binding"
        );

        try {
          await this.configureSslBinding(
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
            { error: sslError, frontendName, tlsCertificateId: options.tlsCertificateId },
            "Failed to configure SSL binding - frontend created but SSL not enabled"
          );
          // Don't throw - frontend is created, SSL configuration failed
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
      throw new Error(`Failed to create frontend: ${error}`);
    }
  }

  /**
   * Add hostname-based routing to a frontend
   * This creates an ACL for hostname matching and a backend switching rule
   *
   * @param frontendName The frontend to add routing to
   * @param hostname The hostname to match
   * @param backendName The backend to route to
   * @param haproxyClient The HAProxy DataPlane client instance
   */
  async addHostnameRouting(
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
      // Generate ACL name from hostname (replace dots with underscores)
      const aclName = generateACLName(hostname);

      // Add ACL for hostname matching
      logger.info({ frontendName, aclName, hostname }, "Creating ACL");
      await this.addACL(
        frontendName,
        aclName,
        `hdr(host) -i ${hostname}`,
        haproxyClient
      );

      // Add backend switching rule
      logger.info(
        { frontendName, aclName, backendName },
        "Adding backend switching rule"
      );
      await this.addBackendSwitchingRule(
        frontendName,
        aclName,
        backendName,
        haproxyClient
      );

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
   * Add an ACL to a frontend
   *
   * @param frontendName The frontend to add ACL to
   * @param aclName The name of the ACL
   * @param fullCriterion The full ACL criterion (e.g., "hdr(host) -i example.com")
   * @param haproxyClient The HAProxy DataPlane client instance
   */
  private async addACL(
    frontendName: string,
    aclName: string,
    fullCriterion: string,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<void> {
    logger.info(
      { frontendName, aclName, fullCriterion },
      "Adding ACL to frontend"
    );

    try {
      // Split criterion into fetch method and value
      // e.g., "hdr(host) -i example.com" -> criterion: "hdr(host)", value: "-i example.com"
      const firstSpaceIndex = fullCriterion.indexOf(' ');
      if (firstSpaceIndex === -1) {
        throw new Error(`Invalid ACL criterion format: ${fullCriterion}`);
      }
      const criterion = fullCriterion.substring(0, firstSpaceIndex).trim();
      const value = fullCriterion.substring(firstSpaceIndex + 1).trim();

      await haproxyClient.addACL(frontendName, aclName, criterion, value);

      logger.info(
        { frontendName, aclName },
        "Successfully added ACL to frontend"
      );
    } catch (error: any) {
      // If ACL already exists, log warning but don't throw
      if (
        error?.response?.status === 409 ||
        error?.message?.includes("already exists")
      ) {
        logger.warn(
          { frontendName, aclName },
          "ACL already exists, continuing"
        );
        return;
      }

      logger.error({ error, frontendName, aclName }, "Failed to add ACL");
      throw new Error(`Failed to add ACL: ${error}`);
    }
  }

  /**
   * Add a backend switching rule to a frontend
   *
   * @param frontendName The frontend to add the rule to
   * @param aclName The ACL name to use in the condition
   * @param backendName The backend to switch to
   * @param haproxyClient The HAProxy DataPlane client instance
   */
  private async addBackendSwitchingRule(
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
        'if'
      );

      logger.info(
        { frontendName, backendName, aclName },
        "Successfully added backend switching rule"
      );
    } catch (error: any) {
      // If rule already exists, log warning but don't throw
      if (
        error?.response?.status === 409 ||
        error?.message?.includes("already exists")
      ) {
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
      throw new Error(`Failed to add backend switching rule: ${error}`);
    }
  }

  /**
   * Remove a frontend
   *
   * @param frontendName The frontend to remove
   * @param haproxyClient The HAProxy DataPlane client instance
   */
  async removeFrontend(
    frontendName: string,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<void> {
    logger.info({ frontendName }, "Removing frontend");

    try {
      await haproxyClient.deleteFrontend(frontendName);

      logger.info({ frontendName }, "Successfully removed frontend");
    } catch (error: any) {
      // If frontend doesn't exist, consider it already removed
      if (error?.response?.status === 404) {
        logger.warn(
          { frontendName },
          "Frontend not found, considering it already removed"
        );
        return;
      }

      logger.error({ error, frontendName }, "Failed to remove frontend");
      throw new Error(`Failed to remove frontend: ${error}`);
    }
  }

  /**
   * Update the backend for a frontend's routing rule
   *
   * @param frontendName The frontend to update
   * @param hostname The hostname to update routing for
   * @param newBackendName The new backend to route to
   * @param haproxyClient The HAProxy DataPlane client instance
   */
  async updateFrontendBackend(
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

      // Get existing rules
      const existingRules = await haproxyClient.getBackendSwitchingRules(
        frontendName
      );

      // Find the rule that matches our ACL
      const ruleIndex = existingRules.findIndex(
        (rule: any) => rule.cond_test === aclName
      );

      if (ruleIndex === -1) {
        logger.warn(
          { frontendName, aclName },
          "No existing rule found, creating new one"
        );
        await this.addBackendSwitchingRule(
          frontendName,
          aclName,
          newBackendName,
          haproxyClient
        );
        return;
      }

      // Update the existing rule
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
   * Configure SSL binding for a frontend
   *
   * This method:
   * 1. Retrieves the certificate from the database
   * 2. Gets the certificate from Azure Key Vault
   * 3. Deploys it to HAProxy via DataPlane API
   * 4. Adds an SSL binding on port 443
   *
   * @param frontendName The frontend to configure SSL for
   * @param tlsCertificateId The TLS certificate ID from database
   * @param prisma Prisma client instance
   * @param haproxyClient HAProxy DataPlane client instance
   * @param bindAddress The address to bind on (default: *)
   */
  private async configureSslBinding(
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
      // Fetch, prepare, and deploy certificate to HAProxy
      const certFileName = await haproxyCertificateDeployer.fetchAndDeployCertificate(
        tlsCertificateId,
        prisma,
        haproxyClient,
        { requireActive: true, fileNameSource: "blobName" }
      );

      if (!certFileName) {
        throw new Error(`Failed to deploy certificate: ${tlsCertificateId}`);
      }

      // Add SSL binding to frontend (port 443)
      logger.info(
        { frontendName, bindAddress, port: 443, certFileName },
        "Adding SSL binding to frontend"
      );

      await haproxyClient.addFrontendBind(
        frontendName,
        bindAddress,
        443,
        {
          ssl: true,
          ssl_certificate: `/etc/haproxy/ssl/${certFileName}`,
        }
      );

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
   * Get frontend status
   *
   * @param frontendName The frontend to get status for
   * @param haproxyClient The HAProxy DataPlane client instance
   * @returns The frontend configuration, or null if not found
   */
  async getFrontendStatus(
    frontendName: string,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<any | null> {
    logger.info({ frontendName }, "Getting frontend status");

    try {
      return await this.getFrontend(frontendName, haproxyClient);
    } catch (error) {
      logger.error({ error, frontendName }, "Failed to get frontend status");
      throw error;
    }
  }

  /**
   * Get a frontend by name
   *
   * @param frontendName The frontend name
   * @param haproxyClient The HAProxy DataPlane client instance
   * @returns The frontend configuration, or null if not found
   */
  private async getFrontend(
    frontendName: string,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<any | null> {
    return haproxyClient.getFrontend(frontendName);
  }

  /**
   * Get or create a shared frontend for an environment
   *
   * @param environmentId The environment ID
   * @param type The frontend type ('http' or 'https')
   * @param haproxyClient The HAProxy DataPlane client instance
   * @param prisma Prisma client instance
   * @param options Optional configuration
   * @param options.bindPort The port to bind on (default: 80 for http, 443 for https)
   * @param options.bindAddress The address to bind on (default: *)
   * @param options.tlsCertificateId TLS certificate ID for HTTPS frontends - if provided, SSL will be configured
   * @returns The shared frontend database record
   */
  async getOrCreateSharedFrontend(
    environmentId: string,
    type: "http" | "https",
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient,
    options?: {
      bindPort?: number;
      bindAddress?: string;
      tlsCertificateId?: string;
    }
  ): Promise<{
    id: string;
    frontendName: string;
    environmentId: string | null;
    isSharedFrontend: boolean;
    bindPort: number;
    bindAddress: string;
    useSSL: boolean;
    tlsCertificateId: string | null;
  }> {
    const frontendName = generateSharedFrontendName(environmentId, type);
    const bindPort = options?.bindPort ?? (type === "https" ? 443 : 80);
    const bindAddress = options?.bindAddress ?? "*";
    const tlsCertificateId = options?.tlsCertificateId;

    logger.info(
      { environmentId, type, frontendName, bindPort, bindAddress, hasTlsCert: !!tlsCertificateId },
      "Getting or creating shared frontend"
    );

    try {
      // Check if shared frontend already exists in database
      const existingFrontend = await prisma.hAProxyFrontend.findFirst({
        where: {
          environmentId,
          isSharedFrontend: true,
          frontendType: "shared",
          bindPort,
        },
      });

      if (existingFrontend) {
        logger.info(
          { frontendName: existingFrontend.frontendName, environmentId },
          "Shared frontend already exists in database"
        );
        return {
          id: existingFrontend.id,
          frontendName: existingFrontend.frontendName,
          environmentId: existingFrontend.environmentId,
          isSharedFrontend: existingFrontend.isSharedFrontend,
          bindPort: existingFrontend.bindPort,
          bindAddress: existingFrontend.bindAddress,
          useSSL: existingFrontend.useSSL,
          tlsCertificateId: existingFrontend.tlsCertificateId,
        };
      }

      // Check if frontend exists in HAProxy
      const existingHAProxyFrontend = await this.getFrontend(
        frontendName,
        haproxyClient
      );

      if (!existingHAProxyFrontend) {
        // Create frontend in HAProxy
        logger.info({ frontendName }, "Creating shared frontend in HAProxy");
        await haproxyClient.createFrontend({
          name: frontendName,
          mode: "http",
        });

        // Add bind configuration based on type and SSL options
        if (type === "https" && tlsCertificateId) {
          // HTTPS with certificate - configure SSL from the start
          logger.info(
            { frontendName, bindAddress, bindPort, tlsCertificateId },
            "Configuring HTTPS shared frontend with SSL"
          );
          await this.configureSharedFrontendSSL(
            frontendName,
            tlsCertificateId,
            prisma,
            haproxyClient,
            bindAddress,
            bindPort
          );
        } else if (type === "https") {
          // HTTPS without certificate - don't create bind yet
          // The SSL endpoint will create the bind with proper SSL configuration later
          logger.info(
            { frontendName, bindPort },
            "HTTPS shared frontend created without bind - SSL must be configured separately"
          );
        } else {
          // HTTP - create plain bind
          logger.info(
            { frontendName, bindAddress, bindPort },
            "Adding bind to HTTP shared frontend"
          );
          await haproxyClient.addFrontendBind(
            frontendName,
            bindAddress,
            bindPort
          );
        }
      } else {
        logger.info(
          { frontendName },
          "Shared frontend already exists in HAProxy"
        );
      }

      // Create database record
      const newFrontend = await prisma.hAProxyFrontend.create({
        data: {
          frontendType: "shared",
          frontendName,
          backendName: "", // Shared frontends don't have a single backend
          hostname: "", // Shared frontends route multiple hostnames
          bindPort,
          bindAddress,
          isSharedFrontend: true,
          environmentId,
          status: "active",
          useSSL: type === "https" && !!tlsCertificateId,
          tlsCertificateId: tlsCertificateId ?? null,
        },
      });

      logger.info(
        { frontendId: newFrontend.id, frontendName, environmentId, useSSL: newFrontend.useSSL },
        "Created shared frontend"
      );

      return {
        id: newFrontend.id,
        frontendName: newFrontend.frontendName,
        environmentId: newFrontend.environmentId,
        isSharedFrontend: newFrontend.isSharedFrontend,
        bindPort: newFrontend.bindPort,
        bindAddress: newFrontend.bindAddress,
        useSSL: newFrontend.useSSL,
        tlsCertificateId: newFrontend.tlsCertificateId,
      };
    } catch (error) {
      logger.error(
        { error, environmentId, type },
        "Failed to get or create shared frontend"
      );
      throw new Error(`Failed to get or create shared frontend: ${error}`);
    }
  }

  /**
   * Configure SSL for a shared frontend
   * This deploys the certificate and creates an SSL-enabled bind
   *
   * @param frontendName The frontend name
   * @param tlsCertificateId The TLS certificate ID
   * @param prisma Prisma client instance
   * @param haproxyClient HAProxy DataPlane client instance
   * @param bindAddress The address to bind on
   * @param bindPort The port to bind on (default: 443)
   */
  private async configureSharedFrontendSSL(
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

    // Fetch, prepare, and deploy certificate to HAProxy
    const certFileName = await haproxyCertificateDeployer.fetchAndDeployCertificate(
      tlsCertificateId,
      prisma,
      haproxyClient,
      { fileNameSource: "primaryDomain" }
    );

    if (!certFileName) {
      throw new Error(`Failed to deploy certificate: ${tlsCertificateId}`);
    }

    // Add SSL-enabled bind
    logger.info(
      { frontendName, bindAddress, bindPort, certFileName },
      "Adding SSL binding to shared frontend"
    );

    await haproxyClient.addFrontendBind(
      frontendName,
      bindAddress,
      bindPort,
      {
        ssl: true,
        ssl_certificate: `/etc/haproxy/ssl/`,  // Directory path for SNI-based certificate selection
      }
    );

    logger.info(
      { frontendName, tlsCertificateId },
      "Successfully configured SSL for shared frontend"
    );
  }

  /**
   * Upload a certificate to HAProxy storage for SNI-based selection.
   *
   * The certificate is uploaded to /etc/haproxy/ssl/ where the shared
   * HTTPS frontend bind is pointing. HAProxy will automatically select
   * the correct certificate based on the SNI hostname.
   *
   * @param tlsCertificateId The TLS certificate ID from database
   * @param prisma Prisma client instance
   * @param haproxyClient HAProxy DataPlane client instance
   */
  async uploadCertificateForSNI(
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
   * Remove a certificate from HAProxy storage.
   *
   * This should be called when a deployment is removed and its certificate
   * is no longer needed by any other deployments.
   *
   * @param tlsCertificateId The TLS certificate ID from database
   * @param prisma Prisma client instance
   * @param haproxyClient HAProxy DataPlane client instance
   */
  async removeCertificateFromHAProxy(
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

  /**
   * Add a route (ACL + backend switching rule) to a shared frontend
   *
   * @param sharedFrontendId The shared frontend database ID
   * @param hostname The hostname to route
   * @param backendName The backend to route to
   * @param sourceType The source type ('deployment' or 'manual')
   * @param sourceId The source ID (deployment config ID or manual frontend ID)
   * @param haproxyClient The HAProxy DataPlane client instance
   * @param prisma Prisma client instance
   * @param sslOptions Optional SSL configuration
   * @returns The created route database record
   */
  async addRouteToSharedFrontend(
    sharedFrontendId: string,
    hostname: string,
    backendName: string,
    sourceType: "manual" | "stack",
    sourceId: string,
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient,
    sslOptions?: { useSSL: boolean; tlsCertificateId?: string }
  ): Promise<{
    id: string;
    hostname: string;
    aclName: string;
    backendName: string;
    sourceType: string;
    useSSL: boolean;
  }> {
    logger.info(
      { sharedFrontendId, hostname, backendName, sourceType, sourceId },
      "Adding route to shared frontend"
    );

    try {
      // Get the shared frontend
      const sharedFrontend = await prisma.hAProxyFrontend.findUnique({
        where: { id: sharedFrontendId },
      });

      if (!sharedFrontend) {
        throw new Error(`Shared frontend not found: ${sharedFrontendId}`);
      }

      if (!sharedFrontend.isSharedFrontend) {
        throw new Error(
          `Frontend ${sharedFrontendId} is not a shared frontend`
        );
      }

      const frontendName = sharedFrontend.frontendName;
      const aclName = generateACLName(hostname);

      // Check if route already exists
      const existingRoute = await prisma.hAProxyRoute.findFirst({
        where: {
          sharedFrontendId,
          hostname,
        },
      });

      if (existingRoute) {
        logger.warn(
          { hostname, sharedFrontendId },
          "Route already exists for this hostname"
        );
        return {
          id: existingRoute.id,
          hostname: existingRoute.hostname,
          aclName: existingRoute.aclName,
          backendName: existingRoute.backendName,
          sourceType: existingRoute.sourceType,
          useSSL: existingRoute.useSSL,
        };
      }

      // Add ACL and backend switching rule to HAProxy
      await this.addHostnameRouting(
        frontendName,
        hostname,
        backendName,
        haproxyClient
      );

      // If SSL is enabled and we have a certificate, upload it to HAProxy
      // This ensures the certificate is in /etc/haproxy/ssl/ for SNI selection
      if (sslOptions?.useSSL && sslOptions?.tlsCertificateId) {
        await this.uploadCertificateForSNI(
          sslOptions.tlsCertificateId,
          prisma,
          haproxyClient
        );
      }

      // Create route record in database
      const route = await prisma.hAProxyRoute.create({
        data: {
          sharedFrontendId,
          hostname,
          aclName,
          backendName,
          sourceType,
          manualFrontendId: sourceType === "manual" ? sourceId : null,
          useSSL: sslOptions?.useSSL ?? false,
          tlsCertificateId: sslOptions?.tlsCertificateId ?? null,
          status: "active",
        },
      });

      logger.info(
        { routeId: route.id, hostname, backendName, frontendName },
        "Successfully added route to shared frontend"
      );

      return {
        id: route.id,
        hostname: route.hostname,
        aclName: route.aclName,
        backendName: route.backendName,
        sourceType: route.sourceType,
        useSSL: route.useSSL,
      };
    } catch (error) {
      logger.error(
        { error, sharedFrontendId, hostname, backendName },
        "Failed to add route to shared frontend"
      );
      throw new Error(`Failed to add route to shared frontend: ${error}`);
    }
  }

  /**
   * Remove a route from a shared frontend
   *
   * @param sharedFrontendId The shared frontend database ID
   * @param hostname The hostname to remove
   * @param haproxyClient The HAProxy DataPlane client instance
   * @param prisma Prisma client instance
   */
  async removeRouteFromSharedFrontend(
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
      // Get the shared frontend
      const sharedFrontend = await prisma.hAProxyFrontend.findUnique({
        where: { id: sharedFrontendId },
      });

      if (!sharedFrontend) {
        throw new Error(`Shared frontend not found: ${sharedFrontendId}`);
      }

      const frontendName = sharedFrontend.frontendName;
      const aclName = generateACLName(hostname);

      // Get the route from database
      const route = await prisma.hAProxyRoute.findFirst({
        where: {
          sharedFrontendId,
          hostname,
        },
      });

      if (!route) {
        logger.warn(
          { hostname, sharedFrontendId },
          "Route not found in database, may have been already removed"
        );
      }

      // Remove backend switching rule from HAProxy
      const existingRules =
        await haproxyClient.getBackendSwitchingRules(frontendName);
      const ruleIndex = existingRules.findIndex(
        (rule: any) => rule.cond_test === aclName
      );

      if (ruleIndex !== -1) {
        logger.info(
          { frontendName, aclName, ruleIndex },
          "Removing backend switching rule"
        );
        await haproxyClient.deleteBackendSwitchingRule(frontendName, ruleIndex);
      } else {
        logger.warn(
          { frontendName, aclName },
          "Backend switching rule not found in HAProxy"
        );
      }

      // Remove ACL from HAProxy
      const existingACLs = await haproxyClient.getACLs(frontendName);
      const aclIndex = existingACLs.findIndex(
        (acl: any) => acl.acl_name === aclName
      );

      if (aclIndex !== -1) {
        logger.info({ frontendName, aclName, aclIndex }, "Removing ACL");
        await haproxyClient.deleteACL(frontendName, aclIndex);
      } else {
        logger.warn({ frontendName, aclName }, "ACL not found in HAProxy");
      }

      // Delete route from database
      if (route) {
        await prisma.hAProxyRoute.delete({
          where: { id: route.id },
        });
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
      throw new Error(`Failed to remove route from shared frontend: ${error}`);
    }
  }

  /**
   * Update an existing route
   *
   * @param routeId The route database ID
   * @param updates The updates to apply
   * @param haproxyClient The HAProxy DataPlane client instance
   * @param prisma Prisma client instance
   * @returns The updated route
   */
  async updateRoute(
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
  ): Promise<{
    id: string;
    hostname: string;
    aclName: string;
    backendName: string;
    useSSL: boolean;
    priority: number;
    status: string;
  }> {
    logger.info({ routeId, updates }, "Updating route");

    try {
      // Get the existing route
      const existingRoute = await prisma.hAProxyRoute.findUnique({
        where: { id: routeId },
        include: { sharedFrontend: true },
      });

      if (!existingRoute) {
        throw new Error(`Route not found: ${routeId}`);
      }

      const frontendName = existingRoute.sharedFrontend.frontendName;
      const oldAclName = existingRoute.aclName;

      // If hostname is being changed, we need to update ACL and rule
      if (updates.hostname && updates.hostname !== existingRoute.hostname) {
        const newAclName = generateACLName(updates.hostname);

        // Remove old ACL and rule
        const existingRules =
          await haproxyClient.getBackendSwitchingRules(frontendName);
        const ruleIndex = existingRules.findIndex(
          (rule: any) => rule.cond_test === oldAclName
        );

        if (ruleIndex !== -1) {
          await haproxyClient.deleteBackendSwitchingRule(
            frontendName,
            ruleIndex
          );
        }

        const existingACLs = await haproxyClient.getACLs(frontendName);
        const aclIndex = existingACLs.findIndex(
          (acl: any) => acl.acl_name === oldAclName
        );

        if (aclIndex !== -1) {
          await haproxyClient.deleteACL(frontendName, aclIndex);
        }

        // Add new ACL and rule
        await this.addHostnameRouting(
          frontendName,
          updates.hostname,
          updates.backendName ?? existingRoute.backendName,
          haproxyClient
        );
      } else if (
        updates.backendName &&
        updates.backendName !== existingRoute.backendName
      ) {
        // Only backend changed, update the rule
        await this.updateFrontendBackend(
          frontendName,
          existingRoute.hostname,
          updates.backendName,
          haproxyClient
        );
      }

      // Update database record
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
      throw new Error(`Failed to update route: ${error}`);
    }
  }

  /**
   * Sync all routes for an environment (used by remediation)
   * This ensures HAProxy config matches database state
   *
   * @param environmentId The environment ID
   * @param haproxyClient The HAProxy DataPlane client instance
   * @param prisma Prisma client instance
   */
  async syncEnvironmentRoutes(
    environmentId: string,
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient
  ): Promise<{
    synced: number;
    errors: string[];
  }> {
    logger.info({ environmentId }, "Syncing environment routes");

    const errors: string[] = [];
    let synced = 0;

    try {
      // Get all shared frontends for this environment
      const sharedFrontends = await prisma.hAProxyFrontend.findMany({
        where: {
          environmentId,
          isSharedFrontend: true,
        },
        include: {
          routes: true,
        },
      });

      for (const frontend of sharedFrontends) {
        const frontendName = frontend.frontendName;

        // Get current ACLs and rules from HAProxy
        const haproxyACLs = await haproxyClient.getACLs(frontendName);
        const haproxyRules =
          await haproxyClient.getBackendSwitchingRules(frontendName);

        // Build set of expected ACL names from database routes
        const expectedACLs = new Set(frontend.routes.map((r) => r.aclName));

        // Find ACLs in HAProxy that are not in database (should be removed)
        for (const acl of haproxyACLs) {
          if (!expectedACLs.has(acl.acl_name)) {
            try {
              logger.info(
                { frontendName, aclName: acl.acl_name },
                "Removing orphaned ACL"
              );
              const aclIndex = haproxyACLs.findIndex(
                (a: any) => a.acl_name === acl.acl_name
              );
              if (aclIndex !== -1) {
                await haproxyClient.deleteACL(frontendName, aclIndex);
              }
            } catch (err) {
              errors.push(`Failed to remove orphaned ACL ${acl.acl_name}: ${err}`);
            }
          }
        }

        // Find rules in HAProxy that reference ACLs not in database
        for (const rule of haproxyRules) {
          if (!expectedACLs.has(rule.cond_test)) {
            try {
              logger.info(
                { frontendName, aclName: rule.cond_test },
                "Removing orphaned rule"
              );
              const ruleIndex = haproxyRules.findIndex(
                (r: any) => r.cond_test === rule.cond_test
              );
              if (ruleIndex !== -1) {
                await haproxyClient.deleteBackendSwitchingRule(
                  frontendName,
                  ruleIndex
                );
              }
            } catch (err) {
              errors.push(`Failed to remove orphaned rule: ${err}`);
            }
          }
        }

        // Ensure all database routes exist in HAProxy
        for (const route of frontend.routes) {
          const aclExists = haproxyACLs.some(
            (a: any) => a.acl_name === route.aclName
          );
          const ruleExists = haproxyRules.some(
            (r: any) => r.cond_test === route.aclName
          );

          if (!aclExists || !ruleExists) {
            try {
              logger.info(
                { frontendName, hostname: route.hostname },
                "Adding missing route to HAProxy"
              );
              await this.addHostnameRouting(
                frontendName,
                route.hostname,
                route.backendName,
                haproxyClient
              );
              synced++;
            } catch (err) {
              errors.push(
                `Failed to add route for ${route.hostname}: ${err}`
              );
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
      logger.error({ error, environmentId }, "Failed to sync environment routes");
      throw new Error(`Failed to sync environment routes: ${error}`);
    }
  }
}

// Export singleton instance
export const haproxyFrontendManager = new HAProxyFrontendManager();
