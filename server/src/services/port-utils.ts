import prisma from "../lib/prisma";
import { servicesLogger } from "../lib/logger-factory";
import type { HAProxyPortConfig, HAProxyPortValidationResult } from "@mini-infra/types";
import * as net from "net";

const logger = servicesLogger();

/**
 * PortUtils provides port management utilities for HAProxy
 * including port override management and availability checking
 */
export class PortUtils {
  private static readonly HAPROXY_HTTP_PORT_KEY = "haproxy_http_port";
  private static readonly HAPROXY_HTTPS_PORT_KEY = "haproxy_https_port";
  private static readonly HAPROXY_CATEGORY = "haproxy";

  // Default port mappings based on network type
  private static readonly DEFAULT_PORTS = {
    local: { http: 80, https: 443 },
    internet: { http: 8111, https: 8443 },
  };

  /**
   * Get HAProxy ports for an environment
   * Priority: Manual override > Network type defaults
   *
   * @param environmentId The environment ID
   * @returns HAProxy port configuration
   */
  async getHAProxyPortsForEnvironment(environmentId: string): Promise<HAProxyPortConfig> {
    logger.info({ environmentId }, "Getting HAProxy ports for environment");

    try {
      // Get the environment to check networkType
      const environment = await prisma.environment.findUnique({
        where: { id: environmentId },
      });

      if (!environment) {
        throw new Error(`Environment not found: ${environmentId}`);
      }

      // Check for manual port overrides
      const httpOverride = await this.getPortOverride("http");
      const httpsOverride = await this.getPortOverride("https");

      if (httpOverride && httpsOverride) {
        logger.info(
          { httpPort: httpOverride, httpsPort: httpsOverride },
          "Using manual port overrides for HAProxy"
        );
        return {
          httpPort: httpOverride,
          httpsPort: httpsOverride,
          source: "override",
        };
      }

      // Use network type defaults
      const networkType = environment.networkType as "local" | "internet";
      const defaultPorts = PortUtils.DEFAULT_PORTS[networkType] || PortUtils.DEFAULT_PORTS.internet;

      logger.info(
        {
          environmentId,
          networkType,
          httpPort: defaultPorts.http,
          httpsPort: defaultPorts.https,
        },
        "Using network type default ports for HAProxy"
      );

      return {
        httpPort: defaultPorts.http,
        httpsPort: defaultPorts.https,
        source: "network-type",
        networkType,
      };
    } catch (error) {
      logger.error(
        { error, environmentId },
        "Failed to get HAProxy ports for environment"
      );
      throw error;
    }
  }

  /**
   * Validate HAProxy port configuration
   * Checks if ports are available and returns validation result
   *
   * @param httpPort HTTP port to validate
   * @param httpsPort HTTPS port to validate
   * @returns Validation result with availability status
   */
  async validateHAProxyPorts(
    httpPort: number,
    httpsPort: number
  ): Promise<HAProxyPortValidationResult> {
    logger.info({ httpPort, httpsPort }, "Validating HAProxy ports");

    const result: HAProxyPortValidationResult = {
      isValid: true,
      httpPortAvailable: true,
      httpsPortAvailable: true,
      conflicts: {},
      message: "Ports are available",
    };

    try {
      // Validate port numbers
      if (!this.isValidPort(httpPort)) {
        result.isValid = false;
        result.httpPortAvailable = false;
        result.conflicts.httpPort = `Invalid port number: ${httpPort}`;
      }

      if (!this.isValidPort(httpsPort)) {
        result.isValid = false;
        result.httpsPortAvailable = false;
        result.conflicts.httpsPort = `Invalid port number: ${httpsPort}`;
      }

      if (!result.isValid) {
        result.message = "Invalid port numbers";
        return result;
      }

      // Check if ports are the same
      if (httpPort === httpsPort) {
        result.isValid = false;
        result.conflicts.httpPort = "HTTP and HTTPS ports cannot be the same";
        result.conflicts.httpsPort = "HTTP and HTTPS ports cannot be the same";
        result.message = "HTTP and HTTPS ports must be different";
        return result;
      }

      // Check port availability
      const httpAvailable = await this.isPortAvailable(httpPort);
      const httpsAvailable = await this.isPortAvailable(httpsPort);

      if (!httpAvailable) {
        result.isValid = false;
        result.httpPortAvailable = false;
        result.conflicts.httpPort = `Port ${httpPort} is already in use`;
      }

      if (!httpsAvailable) {
        result.isValid = false;
        result.httpsPortAvailable = false;
        result.conflicts.httpsPort = `Port ${httpsPort} is already in use`;
      }

      if (!result.isValid) {
        result.message = "One or more ports are already in use";
        result.suggestedPorts = {
          httpPort: 8111,
          httpsPort: 8443,
        };
      }

      return result;
    } catch (error) {
      logger.error({ error, httpPort, httpsPort }, "Failed to validate HAProxy ports");
      throw error;
    }
  }

  /**
   * Check if a port is available on the host
   *
   * @param port The port to check
   * @returns True if available, false if in use
   */
  async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          logger.debug({ port }, "Port is already in use");
          resolve(false);
        } else {
          logger.warn({ port, error: err }, "Error checking port availability");
          resolve(false);
        }
      });

      server.once("listening", () => {
        server.close();
        logger.debug({ port }, "Port is available");
        resolve(true);
      });

      server.listen(port, "0.0.0.0");
    });
  }

  /**
   * Get port override from system settings
   *
   * @param type 'http' or 'https'
   * @returns Port number if override exists, null otherwise
   */
  private async getPortOverride(type: "http" | "https"): Promise<number | null> {
    const key =
      type === "http"
        ? PortUtils.HAPROXY_HTTP_PORT_KEY
        : PortUtils.HAPROXY_HTTPS_PORT_KEY;

    try {
      const setting = await prisma.systemSettings.findFirst({
        where: {
          category: PortUtils.HAPROXY_CATEGORY,
          key,
          isActive: true,
        },
      });

      if (setting?.value) {
        const port = parseInt(setting.value, 10);
        if (this.isValidPort(port)) {
          return port;
        }
      }

      return null;
    } catch (error) {
      logger.error({ error, type }, "Failed to get port override");
      return null;
    }
  }

  /**
   * Set HAProxy port override in system settings
   *
   * @param type 'http' or 'https'
   * @param port The port number to set
   * @param userId The user making the change
   */
  async setPortOverride(
    type: "http" | "https",
    port: number | null,
    userId: string
  ): Promise<void> {
    logger.info({ type, port, userId }, "Setting HAProxy port override");

    const key =
      type === "http"
        ? PortUtils.HAPROXY_HTTP_PORT_KEY
        : PortUtils.HAPROXY_HTTPS_PORT_KEY;

    try {
      // If port is null, delete the override
      if (port === null) {
        const existing = await prisma.systemSettings.findFirst({
          where: {
            category: PortUtils.HAPROXY_CATEGORY,
            key,
          },
        });

        if (existing) {
          await prisma.systemSettings.delete({
            where: { id: existing.id },
          });
          logger.info({ type, userId }, "Deleted HAProxy port override");
        }
        return;
      }

      // Validate port number
      if (!this.isValidPort(port)) {
        throw new Error(`Invalid port number: ${port}`);
      }

      // Check if setting already exists
      const existing = await prisma.systemSettings.findFirst({
        where: {
          category: PortUtils.HAPROXY_CATEGORY,
          key,
        },
      });

      if (existing) {
        // Update existing setting
        await prisma.systemSettings.update({
          where: { id: existing.id },
          data: {
            value: port.toString(),
            isActive: true,
            updatedBy: userId,
          },
        });
        logger.info({ type, port, userId }, "Updated HAProxy port override");
      } else {
        // Create new setting
        await prisma.systemSettings.create({
          data: {
            category: PortUtils.HAPROXY_CATEGORY,
            key,
            value: port.toString(),
            isEncrypted: false,
            isActive: true,
            createdBy: userId,
            updatedBy: userId,
          },
        });
        logger.info({ type, port, userId }, "Created HAProxy port override");
      }
    } catch (error) {
      logger.error({ error, type, port }, "Failed to set HAProxy port override");
      throw error;
    }
  }

  /**
   * Get current port overrides
   *
   * @returns Object with http and https port overrides (null if not set)
   */
  async getPortOverrides(): Promise<{ httpPort: number | null; httpsPort: number | null }> {
    try {
      const httpPort = await this.getPortOverride("http");
      const httpsPort = await this.getPortOverride("https");

      return { httpPort, httpsPort };
    } catch (error) {
      logger.error({ error }, "Failed to get port overrides");
      throw error;
    }
  }

  /**
   * Validate port number
   *
   * @param port The port number to validate
   * @returns True if valid, false otherwise
   */
  private isValidPort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  }

  /**
   * Check if port overrides are configured
   *
   * @returns True if both HTTP and HTTPS overrides are set
   */
  async arePortOverridesConfigured(): Promise<boolean> {
    try {
      const { httpPort, httpsPort } = await this.getPortOverrides();
      return httpPort !== null && httpsPort !== null;
    } catch (error) {
      logger.error({ error }, "Failed to check port override configuration");
      return false;
    }
  }
}

// Export singleton instance
export const portUtils = new PortUtils();
