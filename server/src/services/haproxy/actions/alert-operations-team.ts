import { getLogger } from '../../../lib/logger-factory';
import type { ActionContext } from './types';

const logger = getLogger("deploy", "alert-operations-team");

interface DeploymentFailureDetails {
    deploymentId: string;
    applicationName: string;
    dockerImage: string;
    containerId?: string;
    containerIpAddress?: string;
    containerPort?: number;
    environmentId: string;
    environmentName: string;
    haproxyContainerId: string;
    haproxyNetworkName: string;
    triggerType: string;
    triggeredBy?: string;
    startTime: number;
    failureTime: number;
    totalDuration: number;
    currentState: string;
    errorMessage?: string;
    applicationReady: boolean;
    haproxyConfigured: boolean;
    healthChecksPassed: boolean;
    trafficEnabled: boolean;
    validationErrors: number;
    retryCount: number;
}

interface FailureAnalysis {
    failurePhase: string;
    possibleCauses: string[];
    recommendedActions: string[];
    urgencyLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    requiresImmediateAction: boolean;
}

export class AlertOperationsTeam {
    execute(context?: ActionContext): void {
        logger.info({
            deploymentId: context?.deploymentId,
            applicationName: context?.applicationName,
            containerId: context?.containerId?.slice(0, 12),
            environmentId: context?.environmentId,
            environmentName: context?.environmentName,
            error: context?.error,
        }, 'Action: Alerting operations team of failure...');

        try {
            // Calculate failure metrics
            const failureTime = Date.now();
            const totalDuration = failureTime - (context?.startTime || failureTime);

            // Create comprehensive failure details
            const failureDetails: DeploymentFailureDetails = {
                deploymentId: context?.deploymentId || 'unknown',
                applicationName: context?.applicationName || 'unknown',
                dockerImage: context?.dockerImage || 'unknown',
                containerId: context?.containerId,
                containerIpAddress: context?.containerIpAddress,
                containerPort: context?.containerPort,
                environmentId: context?.environmentId || 'unknown',
                environmentName: context?.environmentName || 'unknown',
                haproxyContainerId: context?.haproxyContainerId || 'unknown',
                haproxyNetworkName: context?.haproxyNetworkName || 'unknown',
                triggerType: context?.triggerType || 'manual',
                triggeredBy: context?.triggeredBy,
                startTime: context?.startTime || failureTime,
                failureTime,
                totalDuration,
                currentState: context?.currentState || 'unknown',
                errorMessage: context?.error,
                applicationReady: context?.applicationReady || false,
                haproxyConfigured: context?.haproxyConfigured || false,
                healthChecksPassed: context?.healthChecksPassed || false,
                trafficEnabled: context?.trafficEnabled || false,
                validationErrors: context?.validationErrors || 0,
                retryCount: context?.retryCount || 0
            };

            // Analyze the failure to provide actionable insights
            const failureAnalysis = this.analyzeFailure(failureDetails);

            // Log critical failure alert for operations team
            logger.error({
                ...failureDetails,
                containerId: failureDetails.containerId?.slice(0, 12),
                haproxyContainerId: failureDetails.haproxyContainerId.slice(0, 12),
                durationSeconds: Math.round(totalDuration / 1000),
                durationMinutes: Math.round(totalDuration / 60000 * 100) / 100,
                ...failureAnalysis
            }, '🚨 DEPLOYMENT FAILED - Operations team intervention required');

            // Log detailed failure context for debugging
            logger.error({
                deploymentId: failureDetails.deploymentId,
                applicationName: failureDetails.applicationName,
                environmentName: failureDetails.environmentName,
                failureContext: {
                    phase: failureAnalysis.failurePhase,
                    errorMessage: failureDetails.errorMessage,
                    currentState: failureDetails.currentState,
                    retryCount: failureDetails.retryCount
                },
                deploymentProgress: {
                    applicationReady: failureDetails.applicationReady,
                    haproxyConfigured: failureDetails.haproxyConfigured,
                    healthChecksPassed: failureDetails.healthChecksPassed,
                    trafficEnabled: failureDetails.trafficEnabled,
                    validationErrors: failureDetails.validationErrors
                },
                infrastructure: {
                    containerDetails: {
                        id: failureDetails.containerId?.slice(0, 12),
                        image: failureDetails.dockerImage,
                        ipAddress: failureDetails.containerIpAddress,
                        port: failureDetails.containerPort,
                        network: failureDetails.haproxyNetworkName
                    },
                    haproxyDetails: {
                        containerId: failureDetails.haproxyContainerId.slice(0, 12),
                        expectedBackend: failureDetails.applicationName,
                        expectedServer: failureDetails.containerId ?
                            `${failureDetails.applicationName}-${failureDetails.containerId.slice(0, 8)}` :
                            'unknown'
                    },
                    environment: {
                        id: failureDetails.environmentId,
                        name: failureDetails.environmentName
                    }
                }
            }, 'DEPLOYMENT_FAILURE_CONTEXT - Detailed failure information for debugging');

            // Log actionable recommendations for operations team
            logger.error({
                deploymentId: failureDetails.deploymentId,
                applicationName: failureDetails.applicationName,
                urgencyLevel: failureAnalysis.urgencyLevel,
                requiresImmediateAction: failureAnalysis.requiresImmediateAction,
                investigation: {
                    failurePhase: failureAnalysis.failurePhase,
                    possibleCauses: failureAnalysis.possibleCauses,
                    recommendedActions: failureAnalysis.recommendedActions,
                    nextSteps: [
                        'Review deployment logs for detailed error information',
                        'Check container and HAProxy status manually',
                        'Verify environment configuration and resources',
                        'Consider manual rollback if previous version available',
                        'Contact development team if issue persists'
                    ]
                },
                troubleshooting: {
                    checkContainerLogs: failureDetails.containerId ?
                        `docker logs ${failureDetails.containerId.slice(0, 12)}` :
                        'Container not created',
                    checkHAProxyStatus: `docker exec ${failureDetails.haproxyContainerId.slice(0, 12)} cat /etc/haproxy/haproxy.cfg`,
                    checkNetworkConnectivity: `docker network inspect ${failureDetails.haproxyNetworkName}`,
                    manualHealthCheck: failureDetails.containerIpAddress && failureDetails.containerPort ?
                        `curl http://${failureDetails.containerIpAddress}:${failureDetails.containerPort}/health` :
                        'Container network info not available'
                }
            }, 'DEPLOYMENT_FAILURE_ACTIONS - Operations team action plan and troubleshooting guide');

            // Log failure metrics for monitoring and analytics
            logger.error({
                deploymentId: failureDetails.deploymentId,
                applicationName: failureDetails.applicationName,
                environmentName: failureDetails.environmentName,
                triggerType: failureDetails.triggerType,
                failureMetrics: {
                    totalDurationMs: totalDuration,
                    totalDurationSeconds: Math.round(totalDuration / 1000),
                    failurePhase: failureAnalysis.failurePhase,
                    retryCount: failureDetails.retryCount,
                    validationErrors: failureDetails.validationErrors,
                    urgencyLevel: failureAnalysis.urgencyLevel
                },
                timestamp: new Date(failureTime).toISOString(),
                failureTimestamp: new Date(failureTime).toISOString(),
                startTimestamp: new Date(failureDetails.startTime).toISOString()
            }, 'DEPLOYMENT_FAILURE_METRICS - Failure metrics for monitoring systems');

            // Future: Send notifications if configured
            // this.sendNotifications(failureDetails, failureAnalysis);

        } catch (error) {
            // Even if alerting fails, log the original issue
            logger.error({
                deploymentId: context?.deploymentId,
                applicationName: context?.applicationName,
                originalError: context?.error,
                alertingError: error instanceof Error ? error.message : 'Unknown error',
                errorStack: error instanceof Error ? error.stack : undefined
            }, 'Error while alerting operations team - original deployment failure still needs attention');
        }
    }

    /**
     * Analyze the failure to provide actionable insights
     */
    private analyzeFailure(failureDetails: DeploymentFailureDetails): FailureAnalysis {
        let failurePhase: string;
        let possibleCauses: string[];
        let recommendedActions: string[];
        let urgencyLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
        let requiresImmediateAction = false;

        // Determine failure phase based on progress
        if (!failureDetails.containerId) {
            failurePhase = 'container_deployment';
            possibleCauses = [
                'Docker image not available or corrupted',
                'Insufficient resources (CPU/memory/disk)',
                'Docker daemon not responsive',
                'Network configuration issues',
                'Image pull authentication failure'
            ];
            recommendedActions = [
                'Verify Docker image exists and is accessible',
                'Check Docker daemon status and resources',
                'Review container creation logs',
                'Verify network configuration'
            ];
            urgencyLevel = 'HIGH';
            requiresImmediateAction = true;
        } else if (!failureDetails.applicationReady) {
            failurePhase = 'container_startup';
            possibleCauses = [
                'Application startup failure',
                'Port binding conflicts',
                'Missing environment variables',
                'Application configuration errors',
                'Resource constraints'
            ];
            recommendedActions = [
                'Check container logs for startup errors',
                'Verify application configuration',
                'Check resource availability',
                'Review environment variables'
            ];
            urgencyLevel = 'HIGH';
            requiresImmediateAction = true;
        } else if (!failureDetails.haproxyConfigured) {
            failurePhase = 'haproxy_configuration';
            possibleCauses = [
                'HAProxy DataPlane API not accessible',
                'HAProxy configuration conflicts',
                'Network connectivity issues',
                'HAProxy container not running',
                'Backend/server naming conflicts'
            ];
            recommendedActions = [
                'Check HAProxy container status',
                'Verify HAProxy DataPlane API accessibility',
                'Review HAProxy configuration',
                'Check network connectivity between containers'
            ];
            urgencyLevel = 'HIGH';
        } else if (!failureDetails.healthChecksPassed) {
            failurePhase = 'health_checks';
            possibleCauses = [
                'Application health endpoint not responding',
                'Application still starting up',
                'Health check configuration incorrect',
                'Network connectivity issues',
                'Application runtime errors'
            ];
            recommendedActions = [
                'Test health endpoint manually',
                'Check application logs for errors',
                'Verify health check configuration',
                'Allow more time for application startup'
            ];
            urgencyLevel = 'MEDIUM';
        } else if (!failureDetails.trafficEnabled) {
            failurePhase = 'traffic_enablement';
            possibleCauses = [
                'HAProxy server state change failed',
                'HAProxy runtime API issues',
                'Server marked as down by HAProxy',
                'Configuration validation errors'
            ];
            recommendedActions = [
                'Check HAProxy server status',
                'Verify HAProxy runtime API',
                'Review HAProxy logs',
                'Manual server state verification'
            ];
            urgencyLevel = 'MEDIUM';
        } else if (failureDetails.validationErrors > 0) {
            failurePhase = 'traffic_validation';
            possibleCauses = [
                'High error rates detected',
                'Application performance issues',
                'Load balancer configuration problems',
                'Network latency issues',
                'Application instability'
            ];
            recommendedActions = [
                'Review application performance metrics',
                'Check for application errors',
                'Verify load balancer configuration',
                'Monitor traffic patterns'
            ];
            urgencyLevel = 'MEDIUM';
        } else {
            failurePhase = 'unknown_failure';
            possibleCauses = [
                'Unexpected system error',
                'Resource exhaustion',
                'External dependency failure',
                'Timeout during operation'
            ];
            recommendedActions = [
                'Review all system logs',
                'Check system resources',
                'Verify external dependencies',
                'Consider manual intervention'
            ];
            urgencyLevel = 'CRITICAL';
            requiresImmediateAction = true;
        }

        return {
            failurePhase,
            possibleCauses,
            recommendedActions,
            urgencyLevel,
            requiresImmediateAction
        };
    }

    /**
     * Future method for sending notifications
     */
    private async sendNotifications(failureDetails: DeploymentFailureDetails, failureAnalysis: FailureAnalysis): Promise<void> {
        // TODO: Implement email/slack notifications
        // This would integrate with notification services when configured
        logger.debug({
            deploymentId: failureDetails.deploymentId,
            urgencyLevel: failureAnalysis.urgencyLevel
        }, 'Notification sending not yet implemented');
    }
}