import { deploymentLogger } from '../../../lib/logger-factory';
import { deploymentDNSManager } from '../../deployment-dns-manager';
import prisma from '../../../lib/prisma';

const logger = deploymentLogger();

export class ConfigureDNS {
  async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
    logger.info(
      {
        deploymentId: context?.deploymentId,
        applicationName: context?.applicationName,
        configurationId: context?.configurationId,
        hostname: context?.config?.hostname
      },
      'Action: Configuring DNS for deployment...'
    );

    try {
      // Validate required context
      if (!context.configurationId) {
        throw new Error('Configuration ID is required for DNS configuration');
      }

      if (!context.config?.hostname) {
        logger.info(
          { deploymentId: context.deploymentId },
          'No hostname configured, skipping DNS configuration'
        );
        sendEvent({ type: 'DNS_CONFIG_SKIPPED' });
        return;
      }

      // Get deployment configuration with environment
      const deploymentConfig = await prisma.deploymentConfiguration.findUnique({
        where: { id: context.configurationId },
        include: { environment: true }
      });

      if (!deploymentConfig) {
        throw new Error(`Deployment configuration not found: ${context.configurationId}`);
      }

      logger.info(
        {
          deploymentId: context.deploymentId,
          hostname: deploymentConfig.hostname,
          environmentId: deploymentConfig.environmentId,
          networkType: deploymentConfig.environment?.networkType
        },
        'Creating DNS record for deployment'
      );

      // Create DNS record (service will handle network type logic)
      await deploymentDNSManager.createDNSRecordForDeployment(deploymentConfig);

      logger.info(
        {
          deploymentId: context.deploymentId,
          hostname: deploymentConfig.hostname
        },
        'DNS configured successfully'
      );

      // Update context
      context.dnsConfigured = true;

      // Send success event
      sendEvent({
        type: 'DNS_CONFIGURED'
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during DNS configuration';

      logger.error(
        {
          deploymentId: context.deploymentId,
          applicationName: context.applicationName,
          configurationId: context.configurationId,
          hostname: context?.config?.hostname,
          error: errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined
        },
        'Failed to configure DNS'
      );

      // Send error event
      sendEvent({
        type: 'DNS_CONFIG_ERROR',
        error: errorMessage
      });
    }
  }
}
