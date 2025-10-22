import { deploymentLogger } from '../../../lib/logger-factory';
import { HAProxyDataPlaneClient } from '../haproxy-dataplane-client';
import { haproxyFrontendManager } from '../haproxy-frontend-manager';

const logger = deploymentLogger();

export class RemoveFrontend {
  private haproxyClient: HAProxyDataPlaneClient;

  constructor() {
    this.haproxyClient = new HAProxyDataPlaneClient();
  }

  async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
    logger.info(
      {
        deploymentId: context?.deploymentId,
        applicationName: context?.applicationName,
        configurationId: context?.configurationId
      },
      'Action: Removing HAProxy frontend...'
    );

    try {
      // Validate required context
      if (!context.configurationId) {
        throw new Error('Configuration ID is required for frontend removal');
      }

      if (!context.haproxyContainerId) {
        throw new Error('HAProxy container ID is required for frontend removal');
      }

      // Initialize HAProxy DataPlane client
      logger.info(
        {
          deploymentId: context.deploymentId,
          haproxyContainerId: context.haproxyContainerId.slice(0, 12)
        },
        'Initializing HAProxy DataPlane client'
      );

      await this.haproxyClient.initialize(context.haproxyContainerId);

      // Remove frontend using manager
      await haproxyFrontendManager.removeFrontendForDeployment(
        context.configurationId,
        this.haproxyClient
      );

      logger.info(
        {
          deploymentId: context.deploymentId,
          configurationId: context.configurationId
        },
        'HAProxy frontend removed successfully'
      );

      // Send success event
      sendEvent({
        type: 'FRONTEND_REMOVED'
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during frontend removal';

      logger.error(
        {
          deploymentId: context.deploymentId,
          applicationName: context.applicationName,
          configurationId: context.configurationId,
          error: errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined
        },
        'Failed to remove HAProxy frontend'
      );

      // For removal operations, we might want to continue even if frontend removal fails
      // Send success event to allow removal to continue
      logger.warn(
        { deploymentId: context.deploymentId },
        'Continuing removal despite frontend removal error'
      );

      sendEvent({
        type: 'FRONTEND_REMOVED',
        warning: errorMessage
      });
    }
  }
}
