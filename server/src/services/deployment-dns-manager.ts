import prisma from "../lib/prisma";
import { servicesLogger } from "../lib/logger-factory";
import { cloudflareDNSService } from "./cloudflare-dns";
import { networkUtils } from "./network-utils";
import { CloudflareDNSRecord } from "@mini-infra/types";

const logger = servicesLogger();

/**
 * DeploymentDNSManager handles DNS record lifecycle for deployments
 * Orchestrates DNS creation/updates/deletion based on environment network type
 */
export class DeploymentDNSManager {
  /**
   * Create a DNS record for a deployment
   * Only creates DNS for 'local' network type environments
   * For 'internet' network type, logs and skips
   *
   * @param deploymentConfigId The deployment configuration ID
   * @returns The created DNS record info from database, or null if skipped
   */
  async createDNSRecordForDeployment(
    deploymentConfigId: string
  ): Promise<{ id: string; hostname: string } | null> {
    logger.info(
      { deploymentConfigId },
      "Creating DNS record for deployment"
    );

    try {
      // Get deployment configuration with environment
      const deploymentConfig = await prisma.deploymentConfiguration.findUnique(
        {
          where: { id: deploymentConfigId },
          include: { environment: true },
        }
      );

      if (!deploymentConfig) {
        throw new Error(
          `Deployment configuration not found: ${deploymentConfigId}`
        );
      }

      if (!deploymentConfig.hostname) {
        logger.warn(
          { deploymentConfigId },
          "No hostname configured, skipping DNS creation"
        );
        return null;
      }

      const { hostname, environment } = deploymentConfig;

      // Check if DNS record already exists for this deployment
      const existingDNSRecord = await prisma.deploymentDNSRecord.findFirst({
        where: {
          deploymentConfigId,
          status: { not: "removed" },
        },
      });

      // Check network type
      if (environment.networkType === "internet") {
        logger.info(
          {
            deploymentConfigId,
            networkType: environment.networkType,
            hostname,
          },
          "Network type is 'internet', skipping DNS creation (external DNS assumed)"
        );

        // If existing record is external, return it
        if (existingDNSRecord?.dnsProvider === "external") {
          return null;
        }

        // Create a tracking record with status 'external'
        const dnsRecord = await prisma.deploymentDNSRecord.create({
          data: {
            deploymentConfigId,
            hostname,
            dnsProvider: "external",
            status: "removed", // Using 'removed' to indicate we're not managing it
          },
        });

        return null; // Return null to indicate DNS was skipped
      }

      // For 'local' network type, create or update CloudFlare DNS record
      logger.info(
        {
          deploymentConfigId,
          networkType: environment.networkType,
          hostname,
        },
        "Network type is 'local', creating CloudFlare DNS record"
      );

      // Get the IP address we need to set
      const ipAddress =
        await networkUtils.getAppropriateIPForEnvironment(environment.id);

      // If we have an existing active record with Cloudflare details, check if IP needs updating
      if (
        existingDNSRecord &&
        existingDNSRecord.status === "active" &&
        existingDNSRecord.dnsRecordId &&
        existingDNSRecord.zoneId
      ) {
        // Check if IP has changed
        if (existingDNSRecord.ipAddress === ipAddress) {
          logger.info(
            {
              deploymentConfigId,
              recordId: existingDNSRecord.id,
              ipAddress,
            },
            "DNS record already exists and is up to date"
          );
          return {
            id: existingDNSRecord.id,
            hostname: existingDNSRecord.hostname,
          };
        }

        // IP has changed, update it
        logger.info(
          {
            deploymentConfigId,
            recordId: existingDNSRecord.id,
            oldIP: existingDNSRecord.ipAddress,
            newIP: ipAddress,
          },
          "DNS record exists but IP has changed, updating"
        );

        await this.updateDNSRecordIP(deploymentConfigId, ipAddress);

        return {
          id: existingDNSRecord.id,
          hostname: existingDNSRecord.hostname,
        };
      }

      // Create pending DNS record in database (or update existing failed/pending record)
      const pendingDNSRecord = existingDNSRecord
        ? await prisma.deploymentDNSRecord.update({
            where: { id: existingDNSRecord.id },
            data: {
              status: "pending",
              errorMessage: null,
            },
          })
        : await prisma.deploymentDNSRecord.create({
            data: {
              deploymentConfigId,
              hostname,
              dnsProvider: "cloudflare",
              status: "pending",
            },
          });

      logger.info(
        {
          deploymentConfigId,
          recordId: pendingDNSRecord.id,
          isRetry: !!existingDNSRecord,
        },
        existingDNSRecord
          ? "Retrying DNS record creation for failed/incomplete record"
          : "Creating new DNS record"
      );

      try {
        logger.info(
          { deploymentConfigId, hostname, ipAddress },
          "Creating DNS A record in CloudFlare"
        );

        // Create or update DNS record in CloudFlare
        const cfRecord = await cloudflareDNSService.upsertARecord(
          hostname,
          ipAddress,
          300, // 5 minute TTL for quick updates
          false // Not proxied through CloudFlare
        );

        // Update database record with CloudFlare details
        const updatedDNSRecord = await prisma.deploymentDNSRecord.update({
          where: { id: pendingDNSRecord.id },
          data: {
            dnsRecordId: cfRecord.id,
            ipAddress,
            zoneId: cfRecord.zone_id,
            zoneName: cfRecord.zone_name,
            status: "active",
            errorMessage: null,
          },
        });

        logger.info(
          {
            deploymentConfigId,
            dnsRecordId: updatedDNSRecord.id,
            cfRecordId: cfRecord.id,
            hostname,
            ipAddress,
          },
          "Successfully created DNS record for deployment"
        );

        return {
          id: updatedDNSRecord.id,
          hostname: updatedDNSRecord.hostname,
        };
      } catch (error) {
        // Update record with error status
        await prisma.deploymentDNSRecord.update({
          where: { id: pendingDNSRecord.id },
          data: {
            status: "failed",
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
        });

        logger.error(
          { error, deploymentConfigId, hostname },
          "Failed to create DNS record in CloudFlare"
        );

        throw error;
      }
    } catch (error) {
      logger.error(
        { error, deploymentConfigId },
        "Failed to create DNS record for deployment"
      );
      throw error;
    }
  }

  /**
   * Remove DNS record for a deployment
   * Deletes from CloudFlare and updates database status
   *
   * @param deploymentConfigId The deployment configuration ID
   */
  async removeDNSRecordForDeployment(
    deploymentConfigId: string
  ): Promise<void> {
    logger.info(
      { deploymentConfigId },
      "Removing DNS record for deployment"
    );

    try {
      // Get DNS record from database
      const dnsRecord = await prisma.deploymentDNSRecord.findFirst({
        where: {
          deploymentConfigId,
          status: { not: "removed" },
        },
      });

      if (!dnsRecord) {
        logger.warn(
          { deploymentConfigId },
          "No active DNS record found for deployment"
        );
        return;
      }

      // If external DNS provider, just update status
      if (dnsRecord.dnsProvider === "external") {
        logger.info(
          { deploymentConfigId },
          "DNS provider is external, skipping CloudFlare deletion"
        );

        await prisma.deploymentDNSRecord.update({
          where: { id: dnsRecord.id },
          data: { status: "removed" },
        });

        return;
      }

      // For CloudFlare DNS, delete the record
      if (dnsRecord.dnsRecordId && dnsRecord.zoneId) {
        try {
          logger.info(
            {
              deploymentConfigId,
              dnsRecordId: dnsRecord.dnsRecordId,
              zoneId: dnsRecord.zoneId,
            },
            "Deleting DNS record from CloudFlare"
          );

          await cloudflareDNSService.deleteDNSRecord(
            dnsRecord.zoneId,
            dnsRecord.dnsRecordId
          );

          logger.info(
            { deploymentConfigId, dnsRecordId: dnsRecord.id },
            "Successfully deleted DNS record from CloudFlare"
          );
        } catch (error) {
          logger.error(
            { error, deploymentConfigId, dnsRecordId: dnsRecord.id },
            "Failed to delete DNS record from CloudFlare, updating status anyway"
          );
          // Continue to update database status even if CloudFlare deletion fails
        }
      }

      // Update database status to removed
      await prisma.deploymentDNSRecord.update({
        where: { id: dnsRecord.id },
        data: {
          status: "removed",
          errorMessage: null,
        },
      });

      logger.info(
        { deploymentConfigId, dnsRecordId: dnsRecord.id },
        "Successfully removed DNS record for deployment"
      );
    } catch (error) {
      logger.error(
        { error, deploymentConfigId },
        "Failed to remove DNS record for deployment"
      );
      throw error;
    }
  }

  /**
   * Update DNS record IP address for a deployment
   * Useful when Docker host IP changes
   *
   * @param deploymentConfigId The deployment configuration ID
   * @param newIP The new IP address to set
   */
  async updateDNSRecordIP(
    deploymentConfigId: string,
    newIP: string
  ): Promise<void> {
    logger.info(
      { deploymentConfigId, newIP },
      "Updating DNS record IP for deployment"
    );

    try {
      // Get DNS record from database
      const dnsRecord = await prisma.deploymentDNSRecord.findFirst({
        where: {
          deploymentConfigId,
          status: "active",
        },
      });

      if (!dnsRecord) {
        throw new Error(
          `No active DNS record found for deployment: ${deploymentConfigId}`
        );
      }

      // If external DNS provider, log and skip
      if (dnsRecord.dnsProvider === "external") {
        logger.info(
          { deploymentConfigId },
          "DNS provider is external, skipping IP update"
        );
        return;
      }

      // For CloudFlare DNS, update the record
      if (!dnsRecord.dnsRecordId || !dnsRecord.zoneId) {
        throw new Error(
          `DNS record missing CloudFlare details: ${dnsRecord.id}`
        );
      }

      logger.info(
        {
          deploymentConfigId,
          dnsRecordId: dnsRecord.dnsRecordId,
          oldIP: dnsRecord.ipAddress,
          newIP,
        },
        "Updating DNS record in CloudFlare"
      );

      // Fetch the existing DNS record to get all required fields
      const existingRecord = await cloudflareDNSService.getDNSRecord(
        dnsRecord.zoneId,
        dnsRecord.dnsRecordId
      );

      if (!existingRecord) {
        throw new Error(
          `DNS record not found in CloudFlare: ${dnsRecord.dnsRecordId}`
        );
      }

      // Update with all required fields (Cloudflare API requires type, name, and content)
      await cloudflareDNSService.updateDNSRecord(
        dnsRecord.zoneId,
        dnsRecord.dnsRecordId,
        {
          type: existingRecord.type as "A" | "AAAA" | "CNAME" | "MX" | "TXT",
          name: existingRecord.name,
          content: newIP,
          ttl: existingRecord.ttl,
          proxied: existingRecord.proxied,
        }
      );

      // Update database
      await prisma.deploymentDNSRecord.update({
        where: { id: dnsRecord.id },
        data: {
          ipAddress: newIP,
          errorMessage: null,
        },
      });

      logger.info(
        { deploymentConfigId, newIP },
        "Successfully updated DNS record IP"
      );
    } catch (error) {
      logger.error(
        { error, deploymentConfigId, newIP },
        "Failed to update DNS record IP"
      );
      throw error;
    }
  }

  /**
   * Get DNS record status for a deployment
   *
   * @param deploymentConfigId The deployment configuration ID
   * @returns The DNS record from database, or null if not found
   */
  async getDNSRecordStatus(deploymentConfigId: string): Promise<any | null> {
    logger.info({ deploymentConfigId }, "Getting DNS record status");

    try {
      const dnsRecord = await prisma.deploymentDNSRecord.findFirst({
        where: {
          deploymentConfigId,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      if (!dnsRecord) {
        logger.warn(
          { deploymentConfigId },
          "No DNS record found for deployment"
        );
        return null;
      }

      return dnsRecord;
    } catch (error) {
      logger.error(
        { error, deploymentConfigId },
        "Failed to get DNS record status"
      );
      throw error;
    }
  }

  /**
   * Sync DNS records for all active deployments
   * This can be run as a background job to ensure DNS is in sync
   *
   * @returns Summary of sync results
   */
  async syncDNSRecords(): Promise<{
    synced: number;
    failed: number;
    skipped: number;
  }> {
    logger.info("Starting DNS records sync");

    let synced = 0;
    let failed = 0;
    let skipped = 0;

    try {
      // Get all active DNS records
      const dnsRecords = await prisma.deploymentDNSRecord.findMany({
        where: {
          status: "active",
          dnsProvider: "cloudflare",
        },
        include: {
          deploymentConfig: {
            include: {
              environment: true,
            },
          },
        },
      });

      logger.info(
        { recordCount: dnsRecords.length },
        "Found DNS records to sync"
      );

      for (const record of dnsRecords) {
        try {
          // Skip if no CloudFlare details
          if (!record.dnsRecordId || !record.zoneId) {
            logger.warn(
              { recordId: record.id },
              "DNS record missing CloudFlare details, skipping"
            );
            skipped++;
            continue;
          }

          // Get current IP
          const currentIP = await networkUtils.getAppropriateIPForEnvironment(
            record.deploymentConfig.environment.id
          );

          // Check if IP changed
          if (record.ipAddress !== currentIP) {
            logger.info(
              {
                recordId: record.id,
                hostname: record.hostname,
                oldIP: record.ipAddress,
                newIP: currentIP,
              },
              "IP changed, updating DNS record"
            );

            await this.updateDNSRecordIP(
              record.deploymentConfigId,
              currentIP
            );
            synced++;
          } else {
            logger.debug(
              { recordId: record.id, hostname: record.hostname },
              "DNS record IP unchanged"
            );
            skipped++;
          }
        } catch (error) {
          logger.error(
            { error, recordId: record.id },
            "Failed to sync DNS record"
          );
          failed++;
        }
      }

      logger.info(
        { synced, failed, skipped },
        "Completed DNS records sync"
      );

      return { synced, failed, skipped };
    } catch (error) {
      logger.error({ error }, "Failed to sync DNS records");
      throw error;
    }
  }

  /**
   * Check if a deployment should have DNS managed
   * Based on environment network type and hostname configuration
   *
   * @param deploymentConfigId The deployment configuration ID
   * @returns True if DNS should be managed, false otherwise
   */
  async shouldManageDNS(deploymentConfigId: string): Promise<boolean> {
    try {
      const deploymentConfig = await prisma.deploymentConfiguration.findUnique(
        {
          where: { id: deploymentConfigId },
          include: { environment: true },
        }
      );

      if (!deploymentConfig) {
        return false;
      }

      // Must have hostname configured
      if (!deploymentConfig.hostname) {
        return false;
      }

      // Only manage DNS for 'local' network type
      return deploymentConfig.environment.networkType === "local";
    } catch (error) {
      logger.error(
        { error, deploymentConfigId },
        "Failed to check if DNS should be managed"
      );
      return false;
    }
  }
}

// Export singleton instance
export const deploymentDNSManager = new DeploymentDNSManager();
