import { servicesLogger } from '../lib/logger-factory';
import { cloudflareDNSService } from './cloudflare-dns';
import { networkUtils } from './network-utils';
import prisma from '../lib/prisma';
import { DeploymentConfiguration, Environment } from '@prisma/client';

const logger = servicesLogger();

/**
 * Deployment DNS Manager
 * Manages DNS records lifecycle for deployments based on environment network type
 */
export class DeploymentDNSManager {
  /**
   * Create DNS record for a deployment configuration
   * Only creates DNS for 'local' network type environments
   */
  async createDNSRecordForDeployment(
    deploymentConfig: DeploymentConfiguration & { environment?: Environment }
  ): Promise<void> {
    logger.info(
      { deploymentConfigId: deploymentConfig.id, hostname: deploymentConfig.hostname },
      'Creating DNS record for deployment'
    );

    if (!deploymentConfig.hostname) {
      logger.warn({ deploymentConfigId: deploymentConfig.id }, 'No hostname configured, skipping DNS creation');
      return;
    }

    try {
      // Get environment if not included
      let environment = deploymentConfig.environment;
      if (!environment) {
        environment = await prisma.environment.findUnique({
          where: { id: deploymentConfig.environmentId }
        });

        if (!environment) {
          throw new Error(`Environment not found: ${deploymentConfig.environmentId}`);
        }
      }

      logger.info(
        {
          deploymentConfigId: deploymentConfig.id,
          environmentId: environment.id,
          networkType: environment.networkType
        },
        'Checking environment network type for DNS creation'
      );

      // Check network type
      if (environment.networkType === 'internet') {
        logger.info(
          { deploymentConfigId: deploymentConfig.id },
          'Environment network type is "internet", skipping DNS creation (assumed externally managed)'
        );

        // Create a record in database to track that DNS was skipped
        await prisma.deploymentDNSRecord.create({
          data: {
            deploymentConfigId: deploymentConfig.id,
            hostname: deploymentConfig.hostname,
            dnsProvider: 'external',
            status: 'active'
          }
        });

        return;
      }

      // For 'local' network type, create DNS record in CloudFlare
      logger.info(
        { deploymentConfigId: deploymentConfig.id },
        'Environment network type is "local", creating CloudFlare DNS record'
      );

      // Get appropriate IP for environment
      const ipAddress = await networkUtils.getAppropriateIPForEnvironment(environment.id);

      logger.info(
        { deploymentConfigId: deploymentConfig.id, ipAddress },
        'Determined IP address for DNS record'
      );

      // Create or update DNS record in CloudFlare
      const result = await cloudflareDNSService.upsertDNSRecord(
        deploymentConfig.hostname,
        ipAddress,
        300, // TTL: 5 minutes
        false // Not proxied
      );

      logger.info(
        {
          deploymentConfigId: deploymentConfig.id,
          hostname: deploymentConfig.hostname,
          recordId: result.record.id,
          created: result.created
        },
        'DNS record created/updated in CloudFlare'
      );

      // Save DNS record to database
      await prisma.deploymentDNSRecord.create({
        data: {
          deploymentConfigId: deploymentConfig.id,
          hostname: deploymentConfig.hostname,
          dnsProvider: 'cloudflare',
          dnsRecordId: result.record.id,
          ipAddress: ipAddress,
          zoneId: result.zone.id,
          zoneName: result.zone.name,
          status: 'active'
        }
      });

      logger.info(
        { deploymentConfigId: deploymentConfig.id },
        'DNS record created and saved to database'
      );
    } catch (error) {
      logger.error(
        { error, deploymentConfigId: deploymentConfig.id },
        'Failed to create DNS record for deployment'
      );

      // Save error to database
      try {
        await prisma.deploymentDNSRecord.create({
          data: {
            deploymentConfigId: deploymentConfig.id,
            hostname: deploymentConfig.hostname!,
            dnsProvider: 'cloudflare',
            status: 'failed',
            errorMessage: error.message
          }
        });
      } catch (dbError) {
        logger.error({ dbError }, 'Failed to save DNS error to database');
      }

      throw new Error(`Failed to create DNS record: ${error.message}`);
    }
  }

  /**
   * Remove DNS record for a deployment configuration
   */
  async removeDNSRecordForDeployment(deploymentConfigId: string): Promise<void> {
    logger.info({ deploymentConfigId }, 'Removing DNS record for deployment');

    try {
      // Get DNS record from database
      const dnsRecords = await prisma.deploymentDNSRecord.findMany({
        where: { deploymentConfigId }
      });

      if (dnsRecords.length === 0) {
        logger.warn({ deploymentConfigId }, 'No DNS records found for deployment');
        return;
      }

      for (const record of dnsRecords) {
        // Skip if DNS was externally managed
        if (record.dnsProvider === 'external') {
          logger.info(
            { deploymentConfigId, recordId: record.id },
            'DNS record is externally managed, skipping deletion'
          );

          await prisma.deploymentDNSRecord.update({
            where: { id: record.id },
            data: { status: 'removed' }
          });

          continue;
        }

        // Delete from CloudFlare if we have the record ID and zone ID
        if (record.dnsRecordId && record.zoneId) {
          logger.info(
            { deploymentConfigId, recordId: record.dnsRecordId, zoneId: record.zoneId },
            'Deleting DNS record from CloudFlare'
          );

          try {
            await cloudflareDNSService.deleteDNSRecord(record.zoneId, record.dnsRecordId);

            logger.info(
              { deploymentConfigId, recordId: record.dnsRecordId },
              'DNS record deleted from CloudFlare'
            );
          } catch (error) {
            logger.error(
              { error, deploymentConfigId, recordId: record.dnsRecordId },
              'Failed to delete DNS record from CloudFlare'
            );

            // Continue with marking as removed in database even if deletion failed
          }
        }

        // Update database record
        await prisma.deploymentDNSRecord.update({
          where: { id: record.id },
          data: { status: 'removed' }
        });
      }

      logger.info({ deploymentConfigId }, 'DNS records removed successfully');
    } catch (error) {
      logger.error({ error, deploymentConfigId }, 'Failed to remove DNS records');

      // Update database with error
      await prisma.deploymentDNSRecord.updateMany({
        where: { deploymentConfigId },
        data: {
          status: 'failed',
          errorMessage: error.message
        }
      });

      throw new Error(`Failed to remove DNS records: ${error.message}`);
    }
  }

  /**
   * Update DNS record IP address (e.g., if Docker host IP changes)
   */
  async updateDNSRecordIP(deploymentConfigId: string, newIP: string): Promise<void> {
    logger.info({ deploymentConfigId, newIP }, 'Updating DNS record IP address');

    try {
      const dnsRecords = await prisma.deploymentDNSRecord.findMany({
        where: {
          deploymentConfigId,
          dnsProvider: 'cloudflare',
          status: 'active'
        }
      });

      if (dnsRecords.length === 0) {
        logger.warn({ deploymentConfigId }, 'No active CloudFlare DNS records found');
        return;
      }

      for (const record of dnsRecords) {
        if (!record.dnsRecordId || !record.zoneId) {
          logger.warn({ recordId: record.id }, 'DNS record missing CloudFlare IDs, skipping');
          continue;
        }

        // Update DNS record in CloudFlare
        await cloudflareDNSService.updateDNSRecord(record.zoneId, record.dnsRecordId, {
          content: newIP
        });

        // Update database
        await prisma.deploymentDNSRecord.update({
          where: { id: record.id },
          data: { ipAddress: newIP }
        });

        logger.info({ recordId: record.id, newIP }, 'DNS record IP updated');
      }

      logger.info({ deploymentConfigId }, 'DNS record IPs updated successfully');
    } catch (error) {
      logger.error({ error, deploymentConfigId, newIP }, 'Failed to update DNS record IPs');
      throw error;
    }
  }

  /**
   * Get DNS record status for a deployment configuration
   */
  async getDNSRecordStatus(deploymentConfigId: string): Promise<any[]> {
    try {
      const records = await prisma.deploymentDNSRecord.findMany({
        where: { deploymentConfigId }
      });

      return records;
    } catch (error) {
      logger.error({ error, deploymentConfigId }, 'Failed to get DNS record status');
      return [];
    }
  }

  /**
   * Sync DNS records (background job)
   * Verifies DNS records in CloudFlare match database records
   */
  async syncDNSRecords(): Promise<void> {
    logger.info('Starting DNS records sync');

    try {
      // Get all active CloudFlare DNS records from database
      const dnsRecords = await prisma.deploymentDNSRecord.findMany({
        where: {
          dnsProvider: 'cloudflare',
          status: 'active'
        }
      });

      logger.info({ count: dnsRecords.length }, 'Found active DNS records to sync');

      for (const record of dnsRecords) {
        try {
          if (!record.dnsRecordId || !record.zoneId) {
            logger.warn({ recordId: record.id }, 'DNS record missing CloudFlare IDs, skipping sync');
            continue;
          }

          // Get record from CloudFlare
          const cfRecord = await cloudflareDNSService.getDNSRecord(
            record.zoneId,
            record.dnsRecordId
          );

          // Check if IP matches
          if (cfRecord.content !== record.ipAddress) {
            logger.warn(
              {
                recordId: record.id,
                dbIP: record.ipAddress,
                cfIP: cfRecord.content
              },
              'DNS record IP mismatch detected'
            );

            // Update database with CloudFlare value
            await prisma.deploymentDNSRecord.update({
              where: { id: record.id },
              data: { ipAddress: cfRecord.content }
            });
          }
        } catch (error) {
          logger.error({ error, recordId: record.id }, 'Failed to sync DNS record');

          // Mark as failed if record not found in CloudFlare
          if (error.message.includes('not found') || error.message.includes('404')) {
            await prisma.deploymentDNSRecord.update({
              where: { id: record.id },
              data: {
                status: 'failed',
                errorMessage: 'DNS record not found in CloudFlare'
              }
            });
          }
        }
      }

      logger.info('DNS records sync completed');
    } catch (error) {
      logger.error({ error }, 'Failed to sync DNS records');
    }
  }
}

// Export singleton instance
export const deploymentDNSManager = new DeploymentDNSManager();
