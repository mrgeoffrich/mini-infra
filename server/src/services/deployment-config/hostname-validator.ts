import { PrismaClient } from "../../lib/prisma";
import { servicesLogger } from "../../lib/logger-factory";
import { HostnameValidationResult } from "@mini-infra/types";
import { CloudflareService } from "../cloudflare-service";

export class HostnameValidator {
  private prisma: PrismaClient;
  private cloudflareService: CloudflareService;

  constructor(prisma: PrismaClient, cloudflareService: CloudflareService) {
    this.prisma = prisma;
    this.cloudflareService = cloudflareService;
  }

  /**
   * Validate a hostname for deployment configuration
   * Checks if hostname is available and not conflicting with existing configs or Cloudflare
   */
  async validateHostname(hostname: string, excludeConfigId?: string): Promise<HostnameValidationResult> {
    const logger = servicesLogger();

    try {
      // Handle empty hostname
      if (!hostname || hostname.trim().length === 0) {
        throw new Error("Hostname is required and cannot be empty");
      }

      // Check length first
      if (hostname.length > 253) {
        return {
          isValid: false,
          isAvailable: false,
          message: `Hostname must be 253 characters or less (currently ${hostname.length} characters)`,
          suggestions: []
        };
      }

      // Basic hostname format validation - updated to allow single word hostnames
      const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;
      if (!hostnameRegex.test(hostname)) {
        let errorMessage = "Invalid hostname format.";

        // Provide specific error messages for common issues
        if (hostname.startsWith('-') || hostname.endsWith('-')) {
          errorMessage += " Hostname cannot start or end with a hyphen.";
        } else if (hostname.includes('..')) {
          errorMessage += " Hostname cannot contain consecutive dots.";
        } else if (hostname.startsWith('.') || hostname.endsWith('.')) {
          errorMessage += " Hostname cannot start or end with a dot.";
        } else if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) {
          errorMessage += " Hostname can only contain letters, numbers, dots, and hyphens.";
        } else {
          errorMessage += " Must be a valid domain name (e.g., example.com, api.example.com).";
        }

        return {
          isValid: false,
          isAvailable: false,
          message: errorMessage,
          suggestions: this.generateBasicHostnameSuggestions(hostname)
        };
      }

      // Check if hostname already exists in deployment configurations
      const existingConfig = await this.prisma.deploymentConfiguration.findFirst({
        where: {
          hostname: hostname,
          ...(excludeConfigId ? { id: { not: excludeConfigId } } : {})
        },
        select: {
          id: true,
          applicationName: true,
        }
      });

      const conflictDetails = {
        existsInCloudflare: false,
        existsInDeploymentConfigs: !!existingConfig,
        cloudflareZone: undefined as string | undefined,
        conflictingConfigId: existingConfig?.id,
        conflictingConfigName: existingConfig?.applicationName,
      };

      if (existingConfig) {
        return {
          isValid: true, // hostname format is valid
          isAvailable: false,
          message: `Hostname '${hostname}' is already used by deployment configuration '${existingConfig.applicationName}'`,
          conflictDetails,
          suggestions: this.generateHostnameSuggestions(hostname, "deployment_config")
        };
      }

      // Check Cloudflare for existing hostname usage
      let cloudflareConflict = false;
      let cloudflareZone: string | undefined;

      try {
        // Get tunnel information to check for hostname conflicts
        const tunnels = await this.cloudflareService.getTunnelInfo();

        for (const tunnel of tunnels) {
          // Get tunnel configuration to check ingress rules
          try {
            const config = await this.cloudflareService.getTunnelConfig(tunnel.id);
            if (config?.config?.ingress) {
              const hasHostname = config.config.ingress.some((rule: any) =>
                rule.hostname === hostname
              );
              if (hasHostname) {
                cloudflareConflict = true;
                cloudflareZone = tunnel.name; // Use tunnel name as zone identifier
                break;
              }
            }
          } catch (configError) {
            // Log but continue checking other tunnels
            logger.debug({
              tunnelId: tunnel.id,
              error: configError instanceof Error ? configError.message : "Unknown error"
            }, "Failed to retrieve tunnel config during hostname validation");
          }
        }
      } catch (cloudflareError) {
        // Log error but don't fail validation - Cloudflare might not be configured
        logger.warn({
          hostname,
          error: cloudflareError instanceof Error ? cloudflareError.message : "Unknown error"
        }, "Failed to check Cloudflare for hostname conflicts");
      }

      conflictDetails.existsInCloudflare = cloudflareConflict;
      conflictDetails.cloudflareZone = cloudflareZone;

      if (cloudflareConflict) {
        return {
          isValid: true,
          isAvailable: false,
          message: `Hostname '${hostname}' is already configured in Cloudflare tunnel${cloudflareZone ? ` (${cloudflareZone})` : ''}`,
          conflictDetails,
          suggestions: this.generateHostnameSuggestions(hostname, "cloudflare")
        };
      }

      // Hostname is available
      return {
        isValid: true,
        isAvailable: true,
        message: `Hostname '${hostname}' is available for use`,
        conflictDetails,
        suggestions: []
      };

    } catch (error) {
      // Re-throw validation errors (like empty hostname)
      if (error instanceof Error && error.message.includes("required and cannot be empty")) {
        throw error;
      }

      logger.error({
        hostname,
        error: error instanceof Error ? error.message : "Unknown error"
      }, "Failed to validate hostname");

      return {
        isValid: false,
        isAvailable: false,
        message: "Failed to validate hostname due to internal error",
        suggestions: []
      };
    }
  }

  /**
   * Generate basic hostname suggestions for invalid formats
   */
  private generateBasicHostnameSuggestions(hostname: string): string[] {
    const suggestions: string[] = [];

    // Clean up common issues
    const cleaned = hostname
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, '-') // Replace invalid chars with hyphens
      .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single
      .replace(/\.+/g, '.') // Replace multiple dots with single
      .replace(/^\.+|\.+$/g, ''); // Remove leading/trailing dots

    if (cleaned && cleaned !== hostname && cleaned.length <= 253) {
      suggestions.push(cleaned);
    }

    // Suggest common domain patterns if it looks like a single word
    if (!hostname.includes('.') && hostname.length > 0) {
      const clean = hostname.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (clean) {
        suggestions.push(`${clean}.example.com`);
        suggestions.push(`api.${clean}.com`);
        suggestions.push(`app.${clean}.com`);
      }
    }

    return suggestions.slice(0, 3); // Limit to 3 basic suggestions
  }

  /**
   * Generate hostname suggestions based on conflict type
   */
  private generateHostnameSuggestions(hostname: string, conflictType: "deployment_config" | "cloudflare"): string[] {
    const parts = hostname.split('.');
    const subdomain = parts[0];
    const domain = parts.slice(1).join('.');

    const suggestions: string[] = [];

    if (conflictType === "deployment_config") {
      // For deployment config conflicts, suggest versioning and staging variants
      suggestions.push(`${subdomain}-v2.${domain}`);
      suggestions.push(`${subdomain}-new.${domain}`);
      suggestions.push(`${subdomain}-staging.${domain}`);
      suggestions.push(`${subdomain}-dev.${domain}`);
      suggestions.push(`api-${subdomain}.${domain}`);
    } else if (conflictType === "cloudflare") {
      // For Cloudflare conflicts, suggest alternative subdomains
      suggestions.push(`api.${hostname}`);
      suggestions.push(`app.${hostname}`);
      suggestions.push(`service.${hostname}`);
      suggestions.push(`${subdomain}-app.${domain}`);
      suggestions.push(`${subdomain}-service.${domain}`);
    }

    // Add generic alternatives
    if (domain && parts.length > 1) {
      suggestions.push(`new.${hostname}`);
      suggestions.push(`v2.${hostname}`);
    }

    // Remove duplicates and filter valid ones
    return [...new Set(suggestions)]
      .filter(s => s !== hostname && s.length <= 253)
      .slice(0, 6); // Limit to 6 suggestions
  }
}
