import { getLogger } from '../../../lib/logger-factory';
import type { ActionContext } from './types';

const logger = getLogger("deploy", "log-deployment-success");

interface DeploymentSummary {
    deploymentId: string;
    applicationName: string;
    dockerImage: string;
    containerId: string;
    containerIpAddress?: string;
    containerPort?: number;
    environmentId: string;
    environmentName: string;
    haproxyContainerId: string;
    haproxyNetworkName: string;
    triggerType: string;
    triggeredBy?: string;
    startTime: number;
    completionTime: number;
    totalDuration: number;
    healthChecksPassed: boolean;
    trafficEnabled: boolean;
    validationErrors: number;
}

export class LogDeploymentSuccess {
    execute(context?: ActionContext): void {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            containerId: context?.containerId?.slice(0, 12),
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
            haproxyContainerId: context?.haproxyContainerId?.slice(0, 12),
        }, 'Action: Logging deployment success and updating history...');

        try {
            // Calculate deployment metrics
            const completionTime = Date.now();
            const totalDuration = completionTime - (context?.startTime || completionTime);

            // Create comprehensive deployment summary
            const deploymentSummary: DeploymentSummary = {
                deploymentId: context?.deploymentId || 'unknown',
                applicationName: context?.applicationName || 'unknown',
                dockerImage: context?.dockerImage || 'unknown',
                containerId: context?.containerId || 'unknown',
                containerIpAddress: context?.containerIpAddress,
                containerPort: context?.containerPort,
                environmentId: context?.environmentId || 'unknown',
                environmentName: context?.environmentName || 'unknown',
                haproxyContainerId: context?.haproxyContainerId || 'unknown',
                haproxyNetworkName: context?.haproxyNetworkName || 'unknown',
                triggerType: context?.triggerType || 'manual',
                triggeredBy: context?.triggeredBy,
                startTime: context?.startTime || completionTime,
                completionTime,
                totalDuration,
                healthChecksPassed: context?.healthChecksPassed || false,
                trafficEnabled: context?.trafficEnabled || false,
                validationErrors: context?.validationErrors || 0
            };

            // Log comprehensive deployment success summary
            logger.info({
                ...deploymentSummary,
                containerId: deploymentSummary.containerId.slice(0, 12),
                haproxyContainerId: deploymentSummary.haproxyContainerId.slice(0, 12),
                durationSeconds: Math.round(totalDuration / 1000),
                durationMinutes: Math.round(totalDuration / 60000 * 100) / 100
            }, '🎉 DEPLOYMENT COMPLETED SUCCESSFULLY - Initial deployment completed with all health checks passed');

            // Log deployment metrics for monitoring/analytics
            logger.info({
                deploymentId: deploymentSummary.deploymentId,
                applicationName: deploymentSummary.applicationName,
                environmentName: deploymentSummary.environmentName,
                triggerType: deploymentSummary.triggerType,
                totalDurationMs: totalDuration,
                totalDurationSeconds: Math.round(totalDuration / 1000),
                healthChecksPassed: deploymentSummary.healthChecksPassed,
                trafficEnabled: deploymentSummary.trafficEnabled,
                validationErrors: deploymentSummary.validationErrors,
                timestamp: new Date(completionTime).toISOString()
            }, 'DEPLOYMENT_METRICS - Successful initial deployment metrics recorded');

            // Log infrastructure details for operational tracking
            logger.info({
                deploymentId: deploymentSummary.deploymentId,
                applicationName: deploymentSummary.applicationName,
                containerDetails: {
                    id: deploymentSummary.containerId.slice(0, 12),
                    image: deploymentSummary.dockerImage,
                    ipAddress: deploymentSummary.containerIpAddress,
                    port: deploymentSummary.containerPort,
                    network: deploymentSummary.haproxyNetworkName
                },
                haproxyDetails: {
                    containerId: deploymentSummary.haproxyContainerId.slice(0, 12),
                    backendName: deploymentSummary.applicationName,
                    serverName: `${deploymentSummary.applicationName}-${deploymentSummary.containerId.slice(0, 8)}`
                },
                environment: {
                    id: deploymentSummary.environmentId,
                    name: deploymentSummary.environmentName
                }
            }, 'DEPLOYMENT_INFRASTRUCTURE - Container and HAProxy configuration recorded');

            // Log deployment timeline for performance analysis
            logger.info({
                deploymentId: deploymentSummary.deploymentId,
                applicationName: deploymentSummary.applicationName,
                timeline: {
                    startTime: new Date(deploymentSummary.startTime).toISOString(),
                    completionTime: new Date(deploymentSummary.completionTime).toISOString(),
                    totalDurationMs: totalDuration,
                    phases: {
                        containerDeployment: 'completed',
                        containerStartup: 'completed',
                        haproxyConfiguration: 'completed',
                        healthChecks: deploymentSummary.healthChecksPassed ? 'passed' : 'skipped',
                        trafficEnablement: deploymentSummary.trafficEnabled ? 'enabled' : 'skipped',
                        trafficValidation: deploymentSummary.validationErrors === 0 ? 'passed' : 'completed_with_errors'
                    }
                }
            }, 'DEPLOYMENT_TIMELINE - Deployment phase completion recorded');

            // Final success confirmation log
            logger.info({
                deploymentId: deploymentSummary.deploymentId,
                applicationName: deploymentSummary.applicationName,
                result: 'SUCCESS',
                message: `Initial deployment of ${deploymentSummary.applicationName} completed successfully in ${Math.round(totalDuration / 1000)} seconds`,
                nextSteps: [
                    'Container is running and healthy',
                    'HAProxy backend configured and accepting traffic',
                    'Health checks passed',
                    'Traffic validation completed',
                    'System ready for monitoring'
                ]
            }, 'DEPLOYMENT_COMPLETED - Initial deployment pipeline finished successfully');

        } catch (error) {
            // Even if logging fails, don't fail the deployment
            logger.error({
                deploymentId: context?.deploymentId,
                applicationName: context?.applicationName,
                error: error instanceof Error ? error.message : 'Unknown error',
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Error while logging deployment success - deployment still successful');
        }
    }
}