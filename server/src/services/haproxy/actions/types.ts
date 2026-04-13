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
 * `ActionEvent` / `SendEvent` intentionally stay broad: events flow from
 * actions back into XState machines whose event unions differ per
 * machine, so narrowing is done at the state-machine layer, not here.
 */

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
    sourceType?: string;

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
    containerPorts?: { containerPort: number; hostPort: number; protocol: string }[];
    containerVolumes?: string[];
    containerEnvironment?: Record<string, string>;
    containerLabels?: Record<string, string>;
    containerNetworks?: string[];

    // Free-form configuration fallback (DB-derived)
    config?: Record<string, unknown>;
}

// Actions emit heterogeneous events that different state machines narrow
// on. The machine-side event unions stay strictly typed; the action-side
// callback just needs to accept any valid XState event object, so `any`
// is the pragmatic choice here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActionEvent = any;
export type SendEvent = (event: ActionEvent) => void;
