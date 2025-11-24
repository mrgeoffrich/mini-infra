// ====================
// Deployment Configuration Types
// ====================

import { DeploymentDNSRecordInfo } from './dns';

// Port configuration for containers
export interface DeploymentPort {
  containerPort: number;
  hostPort?: number;
  protocol?: 'tcp' | 'udp';
}

// Volume configuration for containers
export interface DeploymentVolume {
  hostPath: string;
  containerPath: string;
  mode?: 'rw' | 'ro';
}

// Environment variable configuration
export interface ContainerEnvVar {
  name: string;
  value: string;
}

// Container configuration
export interface ContainerConfig {
  ports: DeploymentPort[];
  volumes: DeploymentVolume[];
  environment: ContainerEnvVar[];
  labels: Record<string, string>;
  networks: string[];
}

// Health check configuration
export interface HealthCheckConfig {
  endpoint: string;
  method: 'GET' | 'POST';
  expectedStatus: number[];
  responseValidation?: string; // regex pattern
  timeout: number; // milliseconds
  retries: number;
  interval: number; // milliseconds
}

// HAProxy configuration
export interface HAProxyConfig {
  backendName: string;
  frontendName: string;
  hostRule: string;
  pathRule?: string;
  ssl: boolean;
}

// HAProxy Frontend configuration for deployments
export interface HAProxyFrontendConfig {
  frontendName: string;
  backendName: string;
  hostname: string;
  bindPort: number; // typically 80 or 443
  bindAddress: string; // typically "*" or "0.0.0.0"
  useSSL: boolean;
}

// Rollback configuration
export interface RollbackConfig {
  enabled: boolean;
  maxWaitTime: number; // milliseconds
  keepOldContainer: boolean;
}

// Complete deployment configuration
export interface DeploymentConfig {
  applicationName: string;
  dockerImage: string;
  dockerRegistry?: string | null;
  dockerTag: string;
  containerConfig: ContainerConfig;
  healthCheck: HealthCheckConfig;
  rollbackConfig: RollbackConfig;
  listeningPort?: number | null;
  hostname?: string | null;
}

// Database deployment configuration (matches Prisma model)
export interface DeploymentConfiguration {
  id: string;
  applicationName: string;
  dockerImage: string;
  dockerRegistry: string | null;
  containerConfig: ContainerConfig; // JSON field
  healthCheckConfig: HealthCheckConfig; // JSON field
  rollbackConfig: RollbackConfig; // JSON field
  listeningPort: number | null;
  hostname: string | null;
  isActive: boolean;
  environmentId: string; // Required environment assignment (immutable)
  enableSsl: boolean; // Enable SSL/TLS for this deployment
  tlsCertificateId: string | null; // Associated TLS certificate
  certificateStatus: string | null; // Certificate provisioning status
  createdAt: Date;
  updatedAt: Date;
}

// Deployment configuration for API responses (frontend-friendly with date strings)
export interface DeploymentConfigurationInfo {
  id: string;
  applicationName: string;
  dockerImage: string;
  dockerRegistry: string | null;
  containerConfig: ContainerConfig;
  healthCheckConfig: HealthCheckConfig;
  rollbackConfig: RollbackConfig;
  listeningPort: number | null;
  hostname: string | null;
  isActive: boolean;
  environmentId: string; // Required environment assignment (immutable)
  enableSsl: boolean; // Enable SSL/TLS for this deployment
  tlsCertificateId: string | null; // Associated TLS certificate
  certificateStatus: string | null; // Certificate provisioning status
  createdAt: string;
  updatedAt: string;
}

// ====================
// Deployment Types
// ====================

export type DeploymentTriggerType = 'manual' | 'webhook' | 'scheduled' | 'uninstall';
export type DeploymentStatus =
  | 'pending'
  | 'preparing'
  | 'deploying'
  | 'health_checking'
  | 'switching_traffic'
  | 'cleanup'
  | 'completed'
  | 'failed'
  | 'rolling_back'
  | 'rolledback'
  | 'uninstalling'
  | 'removing_from_lb'
  | 'stopping_application'
  | 'removing_application'
  | 'uninstalled';

export type RemovalStatus =
  | 'in_progress'
  | 'removing_from_lb'
  | 'stopping_application'
  | 'removing_application'
  | 'cleanup'
  | 'completed'
  | 'failed';

// Database deployment (matches Prisma model)
export interface Deployment {
  id: string;
  configurationId: string;
  triggerType: DeploymentTriggerType;
  triggeredBy: string | null;
  dockerImage: string;
  status: DeploymentStatus;
  currentState: string; // State machine state
  startedAt: Date;
  completedAt: Date | null;
  oldContainerId: string | null;
  newContainerId: string | null;
  healthCheckPassed: boolean;
  healthCheckLogs: any; // JSON field
  errorMessage: string | null;
  errorDetails: any; // JSON field
  deploymentTime: number | null; // seconds
  downtime: number; // milliseconds
  containers?: DeploymentContainer[]; // Optional relation
}

// Deployment for API responses
export interface DeploymentInfo {
  id: string;
  configurationId: string;
  triggerType: DeploymentTriggerType;
  triggeredBy: string | null;
  dockerImage: string;
  status: DeploymentStatus;
  currentState: string;
  startedAt: string;
  completedAt: string | null;
  oldContainerId: string | null;
  newContainerId: string | null;
  healthCheckPassed: boolean;
  healthCheckLogs: any;
  errorMessage: string | null;
  errorDetails: any;
  deploymentTime: number | null;
  downtime: number;
  containers?: DeploymentContainerInfo[]; // Optional relation
}

// ====================
// Deployment Step Types
// ====================

export type DeploymentStepStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface DeploymentStep {
  id: string;
  deploymentId: string;
  stepName: string; // 'pull_image', 'create_container', etc.
  status: DeploymentStepStatus;
  startedAt: Date;
  completedAt: Date | null;
  duration: number | null; // milliseconds
  output: string | null;
  errorMessage: string | null;
}

export interface DeploymentStepInfo {
  id: string;
  deploymentId: string;
  stepName: string;
  status: DeploymentStepStatus;
  startedAt: string;
  completedAt: string | null;
  duration: number | null;
  output: string | null;
  errorMessage: string | null;
}

// ====================
// API Request Types
// ====================

export interface CreateDeploymentConfigRequest {
  applicationName: string;
  dockerImage: string;
  dockerRegistry?: string;
  containerConfig: ContainerConfig;
  healthCheckConfig: HealthCheckConfig;
  rollbackConfig: RollbackConfig;
  listeningPort?: number;
  hostname?: string;
  environmentId: string; // Required environment assignment
  enableSsl?: boolean; // Enable SSL/TLS for this deployment
}

export interface UpdateDeploymentConfigRequest {
  applicationName?: string;
  dockerImage?: string;
  dockerRegistry?: string;
  containerConfig?: ContainerConfig;
  healthCheckConfig?: HealthCheckConfig;
  rollbackConfig?: RollbackConfig;
  listeningPort?: number;
  hostname?: string;
  isActive?: boolean;
  enableSsl?: boolean; // Enable SSL/TLS for this deployment
}

export interface TriggerDeploymentRequest {
  applicationName: string;
  tag?: string; // Optional, uses configured default
  force?: boolean; // Skip health checks
}

// ====================
// API Response Types
// ====================

export interface DeploymentConfigResponse {
  success: boolean;
  data: DeploymentConfigurationInfo;
  message?: string;
}

export interface DeploymentConfigListResponse {
  success: boolean;
  data: DeploymentConfigurationInfo[];
  message?: string;
  pagination?: {
    page: number;
    limit: number;
    totalCount: number;
    hasMore: boolean;
  };
}

export interface DeploymentResponse {
  success: boolean;
  data: DeploymentInfo;
  message?: string;
}

export interface DeploymentListResponse {
  success: boolean;
  data: DeploymentInfo[];
  message?: string;
  pagination?: {
    page: number;
    limit: number;
    totalCount: number;
    hasMore: boolean;
  };
}

// ====================
// Validation Types
// ====================

export interface DeploymentConfigValidationResult {
  isValid: boolean;
  message: string;
  errors?: {
    field: string;
    message: string;
  }[];
}

// Hostname validation types
export interface HostnameValidationRequest {
  hostname: string;
  excludeConfigId?: string;
}

export interface HostnameValidationResult {
  isValid: boolean;
  isAvailable: boolean;
  message: string;
  conflictDetails?: {
    existsInCloudflare: boolean;
    existsInDeploymentConfigs: boolean;
    cloudflareZone?: string;
    conflictingConfigId?: string;
    conflictingConfigName?: string;
  };
  suggestions?: string[];
}

export interface HostnameValidationResponse {
  success: boolean;
  data: HostnameValidationResult;
  message?: string;
}

// ====================
// Filter and Sort Types
// ====================

export interface DeploymentConfigFilter {
  applicationName?: string;
  dockerImage?: string;
  isActive?: boolean;
  environmentId?: string;
}

export interface DeploymentFilter {
  configurationId?: string;
  status?: DeploymentStatus;
  triggerType?: DeploymentTriggerType;
  startDate?: Date;
  endDate?: Date;
}

export interface DeploymentConfigSortOptions {
  field: keyof DeploymentConfigurationInfo;
  order: 'asc' | 'desc';
}

export interface DeploymentSortOptions {
  field: keyof DeploymentInfo;
  order: 'asc' | 'desc';
}

// ====================
// Deployment Container Types
// ====================

export interface DeploymentContainer {
  id: string;
  deploymentId: string;
  containerId: string; // Docker container ID
  containerName: string; // Container name
  containerRole: string; // 'old', 'new', 'blue', 'green'
  dockerImage: string; // Full image:tag
  imageId: string | null; // Docker image ID (sha256:...)
  containerConfig: any; // Container config excluding environment variables (JSON)
  status: string; // Container status when captured
  ipAddress: string | null; // Container IP address
  createdAt: Date; // When container was created
  startedAt: Date | null; // When container started
  capturedAt: Date; // When this record was created
}

export interface DeploymentContainerInfo {
  id: string;
  deploymentId: string;
  containerId: string;
  containerName: string;
  containerRole: string;
  dockerImage: string;
  imageId: string | null;
  containerConfig: any;
  status: string;
  ipAddress: string | null;
  createdAt: string;
  startedAt: string | null;
  capturedAt: string;
}

// ====================
// Deployment Removal Types
// ====================

export interface RemovalOperationStep {
  id: string;
  stepName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string | null;
  completedAt: string | null;
  duration: number | null;
  errorMessage: string | null;
}

export interface RemovalOperationInfo {
  id: string;
  configurationId: string;
  applicationName: string;
  status: RemovalStatus;
  currentState: string;
  progress: number;
  steps: RemovalOperationStep[];
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export interface RemovalOperationResponse {
  success: boolean;
  data: RemovalOperationInfo;
  message?: string;
}

export interface UninstallDeploymentConfigResponse {
  success: boolean;
  message: string;
  data: {
    removalId: string;
    status: string;
  };
}

// ====================
// HAProxy Frontend Types
// ====================

export type FrontendType = 'deployment' | 'manual';

export interface HAProxyFrontend {
  id: string;
  deploymentConfigId: string | null;
  frontendType: FrontendType;
  containerName: string | null;
  containerId: string | null;
  containerPort: number | null;
  environmentId: string | null;
  frontendName: string;
  backendName: string;
  hostname: string;
  bindPort: number;
  bindAddress: string;
  useSSL: boolean;
  sslBindPort: number;
  status: 'active' | 'pending' | 'failed' | 'removed';
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface HAProxyFrontendInfo {
  id: string;
  deploymentConfigId: string | null;
  frontendType: FrontendType;
  containerName: string | null;
  containerId: string | null;
  containerPort: number | null;
  environmentId: string | null;
  frontendName: string;
  backendName: string;
  hostname: string;
  bindPort: number;
  bindAddress: string;
  useSSL: boolean;
  tlsCertificateId: string | null;
  sslBindPort: number;
  // Shared frontend support
  isSharedFrontend: boolean;
  sharedFrontendId?: string | null; // Reference to parent shared frontend (for manual connections)
  routesCount?: number;
  routeHostnames?: string[]; // Hostnames from routes (for shared frontends)
  status: 'active' | 'pending' | 'failed' | 'removed';
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HAProxyFrontendResponse {
  success: boolean;
  data: HAProxyFrontendInfo;
  message?: string;
}

export interface HAProxyFrontendListResponse {
  success: boolean;
  data: HAProxyFrontendInfo[];
  message?: string;
}

export interface SyncFrontendRequest {
  deploymentConfigId: string;
}

export interface SyncFrontendResponse {
  success: boolean;
  message: string;
  data?: HAProxyFrontendInfo;
}

// ====================
// DNS Sync Types
// ====================

export interface SyncDNSRequest {
  deploymentConfigId: string;
}

export interface SyncDNSResponse {
  success: boolean;
  message: string;
  data?: DeploymentDNSRecordInfo;
}

export interface DeploymentDNSRecordListResponse {
  success: boolean;
  data: DeploymentDNSRecordInfo[];
  message?: string;
}

export interface DeploymentDNSRecordResponse {
  success: boolean;
  data: DeploymentDNSRecordInfo;
  message?: string;
}

// ====================
// HAProxy Port Configuration Types
// ====================

export interface HAProxyPortConfig {
  httpPort: number;
  httpsPort: number;
  statsPort: number;
  dataplanePort: number;
  source: 'override' | 'network-type'; // Whether from manual override or network type
  networkType?: 'local' | 'internet'; // Network type if from environment
}

export interface HAProxyPortValidationResult {
  isValid: boolean;
  httpPortAvailable: boolean;
  httpsPortAvailable: boolean;
  statsPortAvailable: boolean;
  dataplanePortAvailable: boolean;
  conflicts: {
    httpPort?: string; // Description of conflict
    httpsPort?: string; // Description of conflict
    statsPort?: string; // Description of conflict
    dataplanePort?: string; // Description of conflict
  };
  unavailablePorts: Array<{ port: number; name: string; reason: string }>;
  suggestedPorts?: {
    httpPort: number;
    httpsPort: number;
  };
  message: string;
}

export interface HAProxyPortValidationResponse {
  success: boolean;
  data: HAProxyPortValidationResult;
  message?: string;
}

// ====================
// Manual Frontend Types
// ====================

export interface EligibleContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  networks: string[];
  labels: Record<string, string>;
  ports: Array<{ containerPort: number; protocol: string }>;
  canConnect: boolean;
  reason?: string;
}

export interface EligibleContainersResponse {
  success: boolean;
  data: {
    containers: EligibleContainer[];
    haproxyNetwork: string;
  };
  message?: string;
}

export interface CreateManualFrontendRequest {
  environmentId: string;
  containerId: string;
  containerName: string;
  containerPort: number;
  hostname: string;
  enableSsl?: boolean;
  tlsCertificateId?: string;
  healthCheckPath?: string;
}

export interface UpdateManualFrontendRequest {
  hostname?: string;
  enableSsl?: boolean;
  tlsCertificateId?: string;
  healthCheckPath?: string;
}

export interface ManualFrontendValidationResult {
  isValid: boolean;
  errors: Array<{
    field: string;
    message: string;
  }>;
}

export interface ManualFrontendResponse {
  success: boolean;
  data: HAProxyFrontendInfo;
  message?: string;
}

export interface DeleteManualFrontendResponse {
  success: boolean;
  message: string;
}

// ====================
// HAProxy Route Types (Shared Frontend)
// ====================

export type RouteSourceType = 'deployment' | 'manual';

export interface HAProxyRoute {
  id: string;
  sharedFrontendId: string;
  hostname: string;
  aclName: string;
  backendName: string;
  sourceType: RouteSourceType;
  deploymentConfigId: string | null;
  manualFrontendId: string | null;
  useSSL: boolean;
  tlsCertificateId: string | null;
  priority: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface HAProxyRouteInfo {
  id: string;
  hostname: string;
  aclName: string;
  backendName: string;
  sourceType: RouteSourceType;
  deploymentConfigId: string | null;
  manualFrontendId: string | null;
  useSSL: boolean;
  tlsCertificateId: string | null;
  priority: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface HAProxyRoutesListResponse {
  success: boolean;
  data: {
    frontendId: string;
    frontendName: string;
    routes: HAProxyRouteInfo[];
  };
  message?: string;
}

export interface CreateRouteRequest {
  hostname: string;
  backendName: string;
  useSSL?: boolean;
  tlsCertificateId?: string;
}

export interface CreateRouteResponse {
  success: boolean;
  data: {
    id: string;
    hostname: string;
    aclName: string;
    backendName: string;
    sourceType: RouteSourceType;
    useSSL: boolean;
  };
  message?: string;
}

export interface DeleteRouteResponse {
  success: boolean;
  message: string;
}

// ====================
// HAProxy Remediation Types
// ====================

export interface RemediationResult {
  success: boolean;
  frontendsDeleted: number;
  frontendsCreated: number;
  backendsRecreated: number;
  routesConfigured: number;
  errors: string[];
}

export interface RemediationPreview {
  needsRemediation: boolean;
  currentState: {
    frontends: string[];
    backends: string[];
  };
  expectedState: {
    sharedHttpFrontend: string | null;
    sharedHttpsFrontend: string | null;
    routes: Array<{ hostname: string; backend: string; ssl: boolean }>;
    backends: string[];
  };
  changes: {
    frontendsToDelete: string[];
    frontendsToCreate: string[];
    backendsToRecreate: string[];
    routesToAdd: string[];
  };
}

export interface RemediateHAProxyResponse {
  success: boolean;
  data: {
    frontendsDeleted: number;
    frontendsCreated: number;
    backendsRecreated: number;
    routesConfigured: number;
    errors: string[];
  };
  message: string;
}

export interface HAProxyStatusResponse {
  success: boolean;
  data: {
    hasHAProxy: boolean;
    message?: string;
    sharedFrontendsCount?: number;
    legacyFrontendsCount?: number;
    totalRoutesCount?: number;
    deploymentConfigsWithHostnames?: number;
    needsRemediation?: boolean;
    frontends?: Array<{
      id: string;
      frontendName: string;
      frontendType: string;
      isSharedFrontend: boolean;
      hostname: string;
      bindPort: number;
      status: string;
      routesCount: number;
    }>;
  };
}

export interface RemediationPreviewResponse {
  success: boolean;
  data: RemediationPreview;
}