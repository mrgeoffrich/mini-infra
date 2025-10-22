import { servicesLogger } from '../../lib/logger-factory';
import { HAProxyDataPlaneClient } from './haproxy-dataplane-client';
import prisma from '../../lib/prisma';
import { DeploymentConfiguration } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

const logger = servicesLogger();

/**
 * HAProxy Frontend Manager
 * Manages HAProxy frontends with hostname-based routing
 */
export class HAProxyFrontendManager {
  /**
   * Create a frontend for a deployment configuration
   * Creates frontend with hostname-based ACL and routing to backend
   */
  async createFrontendForDeployment(
    deploymentConfig: DeploymentConfiguration,
    backendName: string,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<string> {
    const frontendName = this.generateFrontendName(
      deploymentConfig.applicationName,
      deploymentConfig.environmentId
    );

    logger.info(
      {
        deploymentConfigId: deploymentConfig.id,
        frontendName,
        backendName,
        hostname: deploymentConfig.hostname
      },
      'Creating HAProxy frontend for deployment'
    );

    if (!deploymentConfig.hostname) {
      throw new Error('Deployment configuration must have a hostname to create frontend');
    }

    try {
      // 1. Create the frontend
      await haproxyClient.createFrontend({
        name: frontendName,
        mode: 'http'
      });

      logger.info({ frontendName }, 'Created HAProxy frontend');

      // 2. Add bind on port 80
      await haproxyClient.addFrontendBind(frontendName, '*', 80);

      logger.info({ frontendName, port: 80 }, 'Added bind to frontend');

      // 3. Add ACL for hostname matching
      const aclName = this.generateACLName(deploymentConfig.hostname);
      await this.addACLToFrontend(haproxyClient, frontendName, aclName, deploymentConfig.hostname);

      logger.info({ frontendName, aclName, hostname: deploymentConfig.hostname }, 'Added ACL to frontend');

      // 4. Add use_backend rule
      await this.addUseBackendRule(haproxyClient, frontendName, aclName, backendName);

      logger.info(
        { frontendName, backendName, aclName },
        'Added use_backend rule to frontend'
      );

      // 5. Save frontend record to database
      await prisma.hAProxyFrontend.create({
        data: {
          deploymentConfigId: deploymentConfig.id,
          frontendName,
          backendName,
          hostname: deploymentConfig.hostname,
          bindPort: 80,
          bindAddress: '*',
          useSSL: false,
          status: 'active'
        }
      });

      logger.info(
        { frontendName, deploymentConfigId: deploymentConfig.id },
        'HAProxy frontend created and saved to database'
      );

      return frontendName;
    } catch (error) {
      logger.error(
        { error, frontendName, deploymentConfigId: deploymentConfig.id },
        'Failed to create HAProxy frontend'
      );

      // Try to clean up frontend if it was partially created
      try {
        await haproxyClient.deleteFrontend(frontendName);
        logger.info({ frontendName }, 'Cleaned up partially created frontend');
      } catch (cleanupError) {
        logger.warn({ cleanupError, frontendName }, 'Failed to clean up frontend');
      }

      throw new Error(`Failed to create HAProxy frontend: ${error.message}`);
    }
  }

  /**
   * Remove a frontend for a deployment
   */
  async removeFrontendForDeployment(
    deploymentConfigId: string,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<void> {
    logger.info({ deploymentConfigId }, 'Removing HAProxy frontend for deployment');

    try {
      // Get frontend record from database
      const frontendRecord = await prisma.hAProxyFrontend.findUnique({
        where: { deploymentConfigId }
      });

      if (!frontendRecord) {
        logger.warn({ deploymentConfigId }, 'No frontend record found in database');
        return;
      }

      const frontendName = frontendRecord.frontendName;

      logger.info({ frontendName, deploymentConfigId }, 'Deleting HAProxy frontend');

      // Delete frontend from HAProxy
      await haproxyClient.deleteFrontend(frontendName);

      logger.info({ frontendName }, 'Deleted frontend from HAProxy');

      // Update database record
      await prisma.hAProxyFrontend.update({
        where: { deploymentConfigId },
        data: { status: 'removed' }
      });

      logger.info({ frontendName, deploymentConfigId }, 'Frontend removed successfully');
    } catch (error) {
      logger.error({ error, deploymentConfigId }, 'Failed to remove HAProxy frontend');

      // Update database with error
      await prisma.hAProxyFrontend.updateMany({
        where: { deploymentConfigId },
        data: {
          status: 'failed',
          errorMessage: error.message
        }
      });

      throw new Error(`Failed to remove HAProxy frontend: ${error.message}`);
    }
  }

  /**
   * Update frontend to point to a different backend
   * Used during blue-green deployments
   */
  async updateFrontendBackend(
    frontendName: string,
    newBackendName: string,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<void> {
    logger.info({ frontendName, newBackendName }, 'Updating frontend backend');

    try {
      // This would require updating the use_backend rule in the frontend
      // For now, we'll log that this is not yet implemented
      logger.warn(
        { frontendName, newBackendName },
        'Frontend backend update not yet fully implemented'
      );

      // Update database record
      await prisma.hAProxyFrontend.updateMany({
        where: { frontendName },
        data: { backendName: newBackendName }
      });
    } catch (error) {
      logger.error({ error, frontendName, newBackendName }, 'Failed to update frontend backend');
      throw error;
    }
  }

  /**
   * Get frontend status from database
   */
  async getFrontendStatus(deploymentConfigId: string): Promise<any | null> {
    try {
      const frontend = await prisma.hAProxyFrontend.findUnique({
        where: { deploymentConfigId }
      });

      return frontend;
    } catch (error) {
      logger.error({ error, deploymentConfigId }, 'Failed to get frontend status');
      return null;
    }
  }

  /**
   * Generate a frontend name from application name and environment ID
   */
  private generateFrontendName(applicationName: string, environmentId: string): string {
    // Use first 8 chars of environment ID for uniqueness
    const envPrefix = environmentId.substring(0, 8);
    return `fe_${applicationName}_${envPrefix}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  }

  /**
   * Generate an ACL name from hostname
   */
  private generateACLName(hostname: string): string {
    // Replace dots with underscores for valid ACL name
    return `acl_${hostname.replace(/\./g, '_')}`;
  }

  /**
   * Add an ACL to a frontend for hostname matching
   * Uses direct API call since this may not be in the client yet
   */
  private async addACLToFrontend(
    haproxyClient: HAProxyDataPlaneClient,
    frontendName: string,
    aclName: string,
    hostname: string
  ): Promise<void> {
    try {
      // Get the axios instance from the client (we'll access the private property)
      const clientAxios = (haproxyClient as any).axiosInstance as AxiosInstance;
      const version = await haproxyClient.getVersion();

      // Create ACL via HAProxy Data Plane API
      const aclData = {
        acl_name: aclName,
        criterion: 'hdr(host)',
        value: hostname,
        index: 0
      };

      await clientAxios.post(
        `/services/haproxy/configuration/acls?parent_type=frontend&parent_name=${frontendName}&version=${version}`,
        aclData
      );

      logger.info({ frontendName, aclName, hostname }, 'Added ACL to frontend');
    } catch (error) {
      logger.error({ error, frontendName, aclName }, 'Failed to add ACL to frontend');
      throw error;
    }
  }

  /**
   * Add a use_backend rule to a frontend
   * Uses direct API call since this may not be in the client yet
   */
  private async addUseBackendRule(
    haproxyClient: HAProxyDataPlaneClient,
    frontendName: string,
    aclName: string,
    backendName: string
  ): Promise<void> {
    try {
      const clientAxios = (haproxyClient as any).axiosInstance as AxiosInstance;
      const version = await haproxyClient.getVersion();

      // Create backend switching rule
      const ruleData = {
        name: backendName,
        cond: 'if',
        cond_test: aclName,
        index: 0
      };

      await clientAxios.post(
        `/services/haproxy/configuration/backend_switching_rules?parent_type=frontend&parent_name=${frontendName}&version=${version}`,
        ruleData
      );

      logger.info({ frontendName, backendName, aclName }, 'Added use_backend rule to frontend');
    } catch (error) {
      logger.error({ error, frontendName, backendName }, 'Failed to add use_backend rule');
      throw error;
    }
  }
}

// Export singleton instance
export const haproxyFrontendManager = new HAProxyFrontendManager();
