/**
 * Shared types for HAProxy state-machine action executors.
 *
 * Actions in this directory are reused across multiple XState machines
 * (initial-deployment, blue-green-deployment, blue-green-update,
 * removal-deployment). Each machine defines its own context and event
 * unions; this file captures the common subset actions depend on.
 *
 * `ActionContext` is the loose superset of fields any action might read.
 * State machine contexts are structurally compatible with it.
 *
 * Per-action emit types (e.g. `ContainerStartupEmit`) define exactly what
 * each action can send back to its caller. `ActionEvent` is the union of
 * all emit types and replaces the previous `any` shortcut.
 */

import type { DeploymentVolume } from '@mini-infra/types';

export interface ActionContext {
    // Deployment identifiers — always set by state machines at context init
    deploymentId: string;
    applicationName: string;
    configurationId?: string;
    dockerImage?: string;

    // User event tracking
    userEventId?: string;

    // Environment context — always set by state machines at context init
    environmentId: string;
    environmentName: string;
    haproxyContainerId: string;
    haproxyNetworkName: string;

    // Container state (single-container / initial deployment)
    containerId?: string;
    containerName?: string;
    containerIpAddress?: string;
    containerPort?: number;

    // Blue-green container state
    oldContainerId?: string;
    newContainerId?: string;
    containersToRemove?: string[];

    // Deployment progress flags
    applicationReady?: boolean;
    haproxyConfigured?: boolean;
    healthChecksPassed?: boolean;
    frontendConfigured?: boolean;
    trafficEnabled?: boolean;
    trafficValidated?: boolean;
    blueHealthy?: boolean;
    greenHealthy?: boolean;
    blueDraining?: boolean;
    blueDrained?: boolean;
    lbRemovalComplete?: boolean;
    frontendRemoved?: boolean;
    dnsConfigured?: boolean;
    dnsSkipped?: boolean;
    dnsRemoved?: boolean;
    applicationStopped?: boolean;
    applicationRemoved?: boolean;

    // Metrics / counters
    validationErrors?: number;
    retryCount?: number;
    activeConnections?: number;
    drainStartTime?: number;
    monitoringStartTime?: number;

    // Frontend / routing
    frontendName?: string;
    hostname?: string;
    enableSsl?: boolean;
    tlsCertificateId?: string;
    certificateStatus?: string;
    networkType?: string;
    sourceType?: 'stack' | 'manual';

    // Health check tuning
    healthCheckEndpoint?: string;
    healthCheckInterval?: number;
    healthCheckRetries?: number;

    // Deployment metadata
    triggerType?: string;
    triggeredBy?: string;
    startTime?: number;
    error?: string;
    currentState?: string;

    // Container spec (source-agnostic)
    containerPorts?: { containerPort: number; hostPort: number; protocol: 'tcp' | 'udp' }[];
    containerVolumes?: DeploymentVolume[];
    containerEnvironment?: Record<string, string>;
    containerLabels?: Record<string, string>;
    containerNetworks?: string[];

    // Free-form configuration fallback (DB-derived)
    config?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Per-action emit types
//
// Each action's execute() method uses one of these as its sendEvent parameter
// type. This makes it clear exactly which events each action can emit and
// lets TypeScript verify machine event unions stay compatible.
// ---------------------------------------------------------------------------

export type ContainerDeploymentEmit =
    | { type: 'DEPLOYMENT_SUCCESS'; containerId: string; containerName?: string }
    | { type: 'DEPLOYMENT_ERROR'; error: string };

export type ContainerStartupEmit =
    | { type: 'CONTAINERS_RUNNING'; containerIpAddress: string; containerPort?: number; containerName?: string }
    | { type: 'STARTUP_TIMEOUT'; error?: string };

export type LBConfigEmit =
    | { type: 'LB_CONFIGURED' }
    | { type: 'LB_CONFIG_ERROR'; error: string };

export type HealthCheckEmit =
    | { type: 'SERVERS_HEALTHY' }
    | { type: 'HEALTH_CHECK_TIMEOUT'; error?: string };

export type FrontendConfigEmit =
    | { type: 'FRONTEND_CONFIGURED'; frontendName?: string; hostname?: string; backendName?: string }
    | { type: 'FRONTEND_CONFIG_SKIPPED'; message?: string }
    | { type: 'FRONTEND_CONFIG_ERROR'; error: string };

export type TrafficEnableEmit =
    | { type: 'TRAFFIC_ENABLED' }
    | { type: 'TRAFFIC_ENABLE_FAILED'; error: string };

export type TrafficValidationEmit =
    | { type: 'TRAFFIC_STABLE' }
    | { type: 'CRITICAL_ISSUES'; error: string };

export type DrainInitiateEmit =
    | { type: 'DRAIN_INITIATED' }
    | { type: 'DRAIN_ISSUES'; error: string };

export type DrainMonitorEmit =
    | { type: 'DRAIN_COMPLETE' }
    | { type: 'DRAIN_TIMEOUT'; error?: string }
    | { type: 'DRAIN_ISSUES'; error: string };

export type LBRemovalEmit =
    | { type: 'LB_REMOVAL_SUCCESS' }
    | { type: 'LB_REMOVAL_FAILED'; error: string };

export type FrontendRemovalEmit =
    | { type: 'FRONTEND_REMOVED'; frontendName?: string }
    | { type: 'FRONTEND_REMOVAL_SKIPPED'; message?: string }
    | { type: 'FRONTEND_REMOVAL_ERROR'; error: string };

export type AppStopEmit =
    | { type: 'STOP_SUCCESS'; stoppedContainers?: string[] }
    | { type: 'STOP_FAILED'; error: string };

export type AppRemovalEmit =
    | { type: 'REMOVAL_SUCCESS'; removedContainers?: string[] }
    | { type: 'REMOVAL_FAILED'; error: string };

export type DnsConfigEmit =
    | { type: 'DNS_CONFIGURED'; hostname: string }
    | { type: 'DNS_CONFIG_SKIPPED'; message?: string; networkType?: string }
    | { type: 'DNS_CONFIG_ERROR'; error: string };

export type DnsRemovalEmit =
    | { type: 'DNS_REMOVED'; hostname: string }
    | { type: 'DNS_REMOVAL_SKIPPED'; message?: string }
    | { type: 'DNS_REMOVAL_ERROR'; error: string };

export type TrafficDisableEmit =
    | { type: 'ROLLBACK_GREEN_TRAFFIC_DISABLED' }
    | { type: 'ROLLBACK_ERROR'; error: string };

// ---------------------------------------------------------------------------
// ActionEvent — union of all per-action emit types.
// Used as the SendEvent parameter type and as a general event type where
// the specific action is not known.
// ---------------------------------------------------------------------------
export type ActionEvent =
    | ContainerDeploymentEmit
    | ContainerStartupEmit
    | LBConfigEmit
    | HealthCheckEmit
    | FrontendConfigEmit
    | TrafficEnableEmit
    | TrafficValidationEmit
    | DrainInitiateEmit
    | DrainMonitorEmit
    | LBRemovalEmit
    | FrontendRemovalEmit
    | AppStopEmit
    | AppRemovalEmit
    | DnsConfigEmit
    | DnsRemovalEmit
    | TrafficDisableEmit;

export type SendEvent = (event: ActionEvent) => void;
