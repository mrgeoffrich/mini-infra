import { servicesLogger } from '../lib/logger-factory';
import axios from 'axios';
import os from 'os';
import prisma from '../lib/prisma';

const logger = servicesLogger();

/**
 * Network utilities service for getting IP addresses
 */
export class NetworkUtils {
  /**
   * Get the Docker host's public IP address
   * First tries to get from system settings, then falls back to external service
   */
  async getDockerHostPublicIP(): Promise<string> {
    logger.info('Getting Docker host public IP address');

    try {
      // Try to get from system settings first
      const dockerHostIP = await this.getDockerHostIPFromSettings();
      if (dockerHostIP) {
        logger.info({ ip: dockerHostIP }, 'Using Docker host IP from system settings');
        return dockerHostIP;
      }

      // Fall back to external service
      logger.info('Docker host IP not in settings, querying external service');
      const response = await axios.get('https://api.ipify.org?format=json', {
        timeout: 5000
      });
      const publicIP = response.data.ip;
      logger.info({ ip: publicIP }, 'Retrieved public IP from external service');
      return publicIP;
    } catch (error) {
      logger.error({ error }, 'Failed to get Docker host public IP');
      throw new Error(`Failed to get Docker host public IP: ${error.message}`);
    }
  }

  /**
   * Get the Docker host's private IP address
   * Uses the first non-internal IPv4 address from network interfaces
   */
  async getDockerHostPrivateIP(): Promise<string> {
    logger.info('Getting Docker host private IP address');

    try {
      const interfaces = os.networkInterfaces();

      // Look for first non-internal IPv4 address
      for (const name of Object.keys(interfaces)) {
        const iface = interfaces[name];
        if (!iface) continue;

        for (const addr of iface) {
          // Skip internal (loopback) and non-IPv4 addresses
          if (addr.family === 'IPv4' && !addr.internal) {
            logger.info({ ip: addr.address, interface: name }, 'Found private IP address');
            return addr.address;
          }
        }
      }

      throw new Error('No private IP address found');
    } catch (error) {
      logger.error({ error }, 'Failed to get Docker host private IP');
      throw new Error(`Failed to get Docker host private IP: ${error.message}`);
    }
  }

  /**
   * Get the appropriate IP address for an environment based on its networkType
   * - 'local' → private IP
   * - 'internet' → public IP
   */
  async getAppropriateIPForEnvironment(environmentId: string): Promise<string> {
    logger.info({ environmentId }, 'Getting appropriate IP for environment');

    try {
      // Get environment to check networkType
      const environment = await prisma.environment.findUnique({
        where: { id: environmentId }
      });

      if (!environment) {
        throw new Error(`Environment not found: ${environmentId}`);
      }

      logger.info(
        { environmentId, networkType: environment.networkType },
        'Determining IP based on network type'
      );

      if (environment.networkType === 'local') {
        return await this.getDockerHostPrivateIP();
      } else {
        return await this.getDockerHostPublicIP();
      }
    } catch (error) {
      logger.error({ error, environmentId }, 'Failed to get appropriate IP for environment');
      throw error;
    }
  }

  /**
   * Get Docker host IP from system settings
   * Returns null if not configured
   */
  private async getDockerHostIPFromSettings(): Promise<string | null> {
    try {
      const setting = await prisma.systemSetting.findUnique({
        where: { key: 'docker_host_ip' }
      });

      if (setting && setting.value) {
        return setting.value as string;
      }

      return null;
    } catch (error) {
      logger.warn({ error }, 'Failed to get Docker host IP from settings');
      return null;
    }
  }

  /**
   * Set Docker host IP in system settings
   */
  async setDockerHostIP(ipAddress: string): Promise<void> {
    logger.info({ ipAddress }, 'Setting Docker host IP in system settings');

    try {
      await prisma.systemSetting.upsert({
        where: { key: 'docker_host_ip' },
        update: { value: ipAddress },
        create: {
          key: 'docker_host_ip',
          value: ipAddress,
          description: 'Public IP address of the Docker host for DNS configuration'
        }
      });

      logger.info({ ipAddress }, 'Docker host IP set successfully');
    } catch (error) {
      logger.error({ error, ipAddress }, 'Failed to set Docker host IP');
      throw new Error(`Failed to set Docker host IP: ${error.message}`);
    }
  }
}

// Export singleton instance
export const networkUtils = new NetworkUtils();
