import { loadbalancerLogger } from "../../lib/logger-factory";
import { HAProxyDataPlaneClient } from "./haproxy-dataplane-client";
import { PrismaClient } from "@prisma/client";
import { DefaultAzureCredential, ClientSecretCredential } from "@azure/identity";
import { AzureKeyVaultCertificateStore } from "../tls/azure-keyvault-certificate-store";
import { TlsConfigService } from "../tls/tls-config";

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
      const frontendName = this.generateFrontendName(
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
      const aclName = this.generateACLName(hostname);

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
      const version = await haproxyClient.getVersion();

      await haproxyClient["axiosInstance"].delete(
        `/services/haproxy/configuration/frontends/${frontendName}?version=${version}`
      );

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
      const aclName = this.generateACLName(hostname);

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
      const version = await haproxyClient.getVersion();
      const ruleData = {
        index: ruleIndex,
        name: newBackendName,
        cond: "if",
        cond_test: aclName,
      };

      await haproxyClient["axiosInstance"].put(
        `/services/haproxy/configuration/frontends/${frontendName}/backend_switching_rules/${ruleIndex}?version=${version}`,
        ruleData
      );

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
      // Step 1: Get certificate from database
      const certificate = await prisma.tlsCertificate.findUnique({
        where: { id: tlsCertificateId },
      });

      if (!certificate) {
        throw new Error(`Certificate not found: ${tlsCertificateId}`);
      }

      if (certificate.status !== "ACTIVE") {
        throw new Error(
          `Certificate is not active: ${certificate.status}`
        );
      }

      logger.info(
        {
          frontendName,
          certificateId: tlsCertificateId,
          keyVaultName: certificate.keyVaultCertificateName,
        },
        "Retrieved certificate from database"
      );

      // Step 2: Initialize TLS config and Key Vault client
      const tlsConfig = new TlsConfigService(prisma);
      const keyVaultUrl = await tlsConfig.get("key_vault_url");

      if (!keyVaultUrl) {
        throw new Error("Key Vault URL not configured");
      }

      // Get credentials
      const tenantId = await tlsConfig.get("key_vault_tenant_id");
      const clientId = await tlsConfig.get("key_vault_client_id");
      const clientSecret = await tlsConfig.get("key_vault_client_secret");

      let credential;
      if (tenantId && clientId && clientSecret) {
        credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
      } else {
        credential = new DefaultAzureCredential();
      }

      const keyVaultStore = new AzureKeyVaultCertificateStore(keyVaultUrl, credential);

      // Step 3: Get certificate from Key Vault
      logger.info(
        { keyVaultName: certificate.keyVaultCertificateName },
        "Retrieving certificate from Azure Key Vault"
      );

      const certData = await keyVaultStore.getCertificate(
        certificate.keyVaultCertificateName
      );

      // Step 4: Deploy certificate to HAProxy
      const certFileName = `${certificate.keyVaultCertificateName}.pem`;

      logger.info(
        { certFileName, frontendName },
        "Deploying certificate to HAProxy"
      );

      // Check if certificate already exists in HAProxy
      const existingCerts = await haproxyClient.listSSLCertificates();
      const certExists = existingCerts.some(
        (cert: any) => cert.storage_name === certFileName
      );

      if (certExists) {
        logger.info({ certFileName }, "Certificate already exists in HAProxy, updating");
        await haproxyClient.updateSSLCertificate(certFileName, certData.combinedPem, false);
      } else {
        logger.info({ certFileName }, "Uploading new certificate to HAProxy");
        await haproxyClient.uploadSSLCertificate(certFileName, certData.combinedPem, false);
      }

      // Step 5: Add SSL binding to frontend (port 443)
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
          ssl_certificate: certFileName,
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
    try {
      const response = await haproxyClient["axiosInstance"].get(
        `/services/haproxy/configuration/frontends/${frontendName}`
      );

      return response.data.data || response.data;
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Generate a frontend name from application name and environment ID
   *
   * @param applicationName The application name
   * @param environmentId The environment ID
   * @returns The generated frontend name
   */
  private generateFrontendName(
    applicationName: string,
    environmentId: string
  ): string {
    // Sanitize names to be HAProxy-friendly (alphanumeric and underscores only)
    const sanitizedApp = applicationName.replace(/[^a-zA-Z0-9]/g, "_");
    const sanitizedEnv = environmentId.replace(/[^a-zA-Z0-9]/g, "_");
    return `fe_${sanitizedApp}_${sanitizedEnv}`;
  }

  /**
   * Generate an ACL name from a hostname
   *
   * @param hostname The hostname
   * @returns The generated ACL name
   */
  private generateACLName(hostname: string): string {
    // Replace dots and other special characters with underscores
    return `acl_${hostname.replace(/[^a-zA-Z0-9]/g, "_")}`;
  }
}

// Export singleton instance
export const haproxyFrontendManager = new HAProxyFrontendManager();
