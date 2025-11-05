import { loadbalancerLogger } from "../../lib/logger-factory";
import { HAProxyDataPlaneClient } from "./haproxy-dataplane-client";

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
   * @param bindPort The port to bind on (default: 80)
   * @param bindAddress The address to bind on (default: *)
   * @returns The name of the created frontend
   */
  async createFrontendForDeployment(
    hostname: string,
    backendName: string,
    applicationName: string,
    environmentId: string,
    haproxyClient: HAProxyDataPlaneClient,
    bindPort: number = 80,
    bindAddress: string = "*"
  ): Promise<string> {
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

      logger.info(
        { frontendName, hostname, backendName },
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
      const parts = fullCriterion.split(/\s+/, 2);
      const criterion = parts[0]; // e.g., "hdr(host)"
      const value = parts.slice(1).join(' ') || ''; // e.g., "-i example.com"

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
