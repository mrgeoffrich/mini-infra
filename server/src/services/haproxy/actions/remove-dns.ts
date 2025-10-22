import { deploymentLogger } from '../../../lib/logger-factory';
import { deploymentDNSManager } from '../../deployment-dns-manager';

const logger = deploymentLogger();

export class RemoveDNS {
  async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
    logger.info(
      {
        deploymentId: context?.deploymentId,
        applicationName: context?.applicationName,
        configurationId: context?.configurationId
      },
      'Action: Removing DNS records...'
    );

    try {
      // Validate required context
      if (!context.configurationId) {
        throw new Error('Configuration ID is required for DNS removal');
      }

      // Remove DNS records using manager
      await deploymentDNSManager.removeDNSRecordForDeployment(context.configurationId);

      logger.info(
        {
          deploymentId: context.deploymentId,
          configurationId: context.configurationId
        },
        'DNS records removed successfully'
      );

      // Send success event
      sendEvent({
        type: 'DNS_REMOVED'
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during DNS removal';

      logger.error(
        {
          deploymentId: context.deploymentId,
          applicationName: context.applicationName,
          configurationId: context.configurationId,
          error: errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined
        },
        'Failed to remove DNS records'
      );

      // For removal operations, we might want to continue even if DNS removal fails
      // Send success event to allow removal to continue
      logger.warn(
        { deploymentId: context.deploymentId },
        'Continuing removal despite DNS removal error'
      );

      sendEvent({
        type: 'DNS_REMOVED',
        warning: errorMessage
      });
    }
  }
}
