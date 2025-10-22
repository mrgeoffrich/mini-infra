import { deploymentLogger } from '../../../lib/logger-factory';
import { HAProxyDataPlaneClient } from '../haproxy-dataplane-client';
import { haproxyFrontendManager } from '../haproxy-frontend-manager';
import prisma from '../../../lib/prisma';

const logger = deploymentLogger();

export class ConfigureFrontend {
  private haproxyClient: HAProxyDataPlaneClient;

  constructor() {
    this.haproxyClient = new HAProxyDataPlaneClient();
  }

  async execute(context: any, sendEvent: (event: any) => void): Promise<void> {
    logger.info(
      {
        deploymentId: context?.deploymentId,
        applicationName: context?.applicationName,
        configurationId: context?.configurationId,
        hostname: context?.config?.hostname
      },
      'Action: Configuring HAProxy frontend for deployment...'
    );

    try {
      // Validate required context
      if (!context.configurationId) {
        throw new Error('Configuration ID is required for frontend configuration');
      }

      if (!context.haproxyContainerId) {
        throw new Error('HAProxy container ID is required for frontend configuration');
      }

      if (!context.config?.hostname) {
        logger.info(
          { deploymentId: context.deploymentId },
          'No hostname configured, skipping frontend configuration'
        );
        sendEvent({ type: 'FRONTEND_CONFIGURED' });
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

      // Initialize HAProxy DataPlane client
      logger.info(
        {
          deploymentId: context.deploymentId,
          haproxyContainerId: context.haproxyContainerId.slice(0, 12)
        },
        'Initializing HAProxy DataPlane client'
      );

      await this.haproxyClient.initialize(context.haproxyContainerId);

      // Determine backend name (should match the backend created by AddContainerToLB)
      const backendName = context.applicationName;

      logger.info(
        {
          deploymentId: context.deploymentId,
          applicationName: context.applicationName,
          backendName,
          hostname: deploymentConfig.hostname
        },
        'Creating HAProxy frontend with hostname routing'
      );

      // Create frontend with hostname routing
      const frontendName = await haproxyFrontendManager.createFrontendForDeployment(
        deploymentConfig,
        backendName,
        this.haproxyClient
      );

      logger.info(
        {
          deploymentId: context.deploymentId,
          frontendName,
          hostname: deploymentConfig.hostname,
          backendName
        },
        'HAProxy frontend configured successfully'
      );

      // Update context with frontend name
      context.frontendName = frontendName;
      context.frontendConfigured = true;

      // Send success event
      sendEvent({
        type: 'FRONTEND_CONFIGURED',
        frontendName
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during frontend configuration';

      logger.error(
        {
          deploymentId: context.deploymentId,
          applicationName: context.applicationName,
          configurationId: context.configurationId,
          error: errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined
        },
        'Failed to configure HAProxy frontend'
      );

      // Send error event
      sendEvent({
        type: 'FRONTEND_CONFIG_ERROR',
        error: errorMessage
      });
    }
  }
}
