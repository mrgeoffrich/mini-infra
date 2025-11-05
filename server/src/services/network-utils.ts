import prisma from "../lib/prisma";
import { servicesLogger } from "../lib/logger-factory";

const logger = servicesLogger();

/**
 * NetworkUtils provides network-related utilities for the application
 * including Docker host IP detection and network interface management
 */
export class NetworkUtils {
  private static readonly DOCKER_HOST_IP_KEY = "docker_host_ip";
  private static readonly SYSTEM_CATEGORY = "system";

  /**
   * Get the public/private IP address of the Docker host
   * This method prioritizes configured values from system settings
   *
   * @returns The Docker host IP address
   * @throws Error if no IP is configured
   */
  async getDockerHostIP(): Promise<string> {
    logger.info("Retrieving Docker host IP address");

    try {
      // Try to get configured value from system settings
      const setting = await prisma.systemSettings.findFirst({
        where: {
          category: NetworkUtils.SYSTEM_CATEGORY,
          key: NetworkUtils.DOCKER_HOST_IP_KEY,
          isActive: true,
        },
      });

      if (setting?.value) {
        logger.info(
          { ip: setting.value },
          "Retrieved Docker host IP from system settings"
        );
        return setting.value;
      }

      // If no configured value, throw an error
      const errorMsg =
        "Docker host IP not configured. Please set the 'docker_host_ip' in system settings.";
      logger.error(errorMsg);
      throw new Error(errorMsg);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not configured")) {
        throw error;
      }
      logger.error({ error }, "Failed to retrieve Docker host IP");
      throw new Error(`Failed to retrieve Docker host IP: ${error}`);
    }
  }

  /**
   * Get the appropriate IP address to use based on environment network type
   * For 'local' environments with an ipAddress set, this returns the environment-specific IP
   * Otherwise, this falls back to the global Docker host IP
   *
   * @param environmentId The environment ID to check
   * @returns The appropriate IP address for the environment
   * @throws Error if environment not found or IP not configured
   */
  async getAppropriateIPForEnvironment(
    environmentId: string
  ): Promise<string> {
    logger.info(
      { environmentId },
      "Determining appropriate IP for environment"
    );

    try {
      // Get the environment to check networkType and ipAddress
      const environment = await prisma.environment.findUnique({
        where: { id: environmentId },
        select: {
          id: true,
          name: true,
          networkType: true,
          ipAddress: true,
        },
      });

      if (!environment) {
        throw new Error(`Environment not found: ${environmentId}`);
      }

      logger.info(
        {
          environmentId,
          networkType: environment.networkType,
          hasIpAddress: !!environment.ipAddress,
        },
        "Retrieved environment network configuration"
      );

      // For local environments, prefer the environment-specific IP if set
      if (environment.networkType === "local" && environment.ipAddress) {
        // Validate the IP format
        if (!this.isValidIPAddress(environment.ipAddress)) {
          logger.warn(
            {
              environmentId,
              ipAddress: environment.ipAddress,
            },
            "Environment has invalid IP address, falling back to Docker host IP"
          );
        } else {
          logger.info(
            {
              environmentId,
              ipAddress: environment.ipAddress,
            },
            "Using environment-specific IP address"
          );
          return environment.ipAddress;
        }
      }

      // Fall back to global Docker host IP from settings
      const dockerHostIp = await this.getDockerHostIP();

      logger.info(
        {
          environmentId,
          dockerHostIp,
          networkType: environment.networkType,
        },
        "Using global Docker host IP"
      );

      return dockerHostIp;
    } catch (error) {
      logger.error(
        { error, environmentId },
        "Failed to determine appropriate IP for environment"
      );
      throw error;
    }
  }

  /**
   * Set the Docker host IP address in system settings
   * This is a convenience method for configuration
   *
   * @param ipAddress The IP address to set
   * @param userId The user making the change
   */
  async setDockerHostIP(ipAddress: string, userId: string): Promise<void> {
    logger.info({ ipAddress, userId }, "Setting Docker host IP");

    try {
      // Validate IP address format
      if (!this.isValidIPAddress(ipAddress)) {
        throw new Error(`Invalid IP address format: ${ipAddress}`);
      }

      // Check if setting already exists
      const existing = await prisma.systemSettings.findFirst({
        where: {
          category: NetworkUtils.SYSTEM_CATEGORY,
          key: NetworkUtils.DOCKER_HOST_IP_KEY,
        },
      });

      if (existing) {
        // Update existing setting
        await prisma.systemSettings.update({
          where: { id: existing.id },
          data: {
            value: ipAddress,
            isActive: true,
            updatedBy: userId,
          },
        });
        logger.info(
          { ipAddress, userId },
          "Updated existing Docker host IP setting"
        );
      } else {
        // Create new setting
        await prisma.systemSettings.create({
          data: {
            category: NetworkUtils.SYSTEM_CATEGORY,
            key: NetworkUtils.DOCKER_HOST_IP_KEY,
            value: ipAddress,
            isEncrypted: false,
            isActive: true,
            createdBy: userId,
            updatedBy: userId,
          },
        });
        logger.info({ ipAddress, userId }, "Created Docker host IP setting");
      }
    } catch (error) {
      logger.error({ error, ipAddress }, "Failed to set Docker host IP");
      throw error;
    }
  }

  /**
   * Validate IP address format (both IPv4 and IPv6)
   *
   * @param ip The IP address to validate
   * @returns True if valid, false otherwise
   */
  private isValidIPAddress(ip: string): boolean {
    // IPv4 regex pattern
    const ipv4Pattern =
      /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

    // IPv6 regex pattern (simplified)
    const ipv6Pattern =
      /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;

    return ipv4Pattern.test(ip) || ipv6Pattern.test(ip);
  }

  /**
   * Check if Docker host IP is configured
   *
   * @returns True if configured, false otherwise
   */
  async isDockerHostIPConfigured(): Promise<boolean> {
    try {
      const setting = await prisma.systemSettings.findFirst({
        where: {
          category: NetworkUtils.SYSTEM_CATEGORY,
          key: NetworkUtils.DOCKER_HOST_IP_KEY,
          isActive: true,
        },
      });

      return setting !== null && setting.value.length > 0;
    } catch (error) {
      logger.error({ error }, "Failed to check Docker host IP configuration");
      return false;
    }
  }
}

// Export singleton instance
export const networkUtils = new NetworkUtils();
