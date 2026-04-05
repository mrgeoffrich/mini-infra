// ====================
// Container Primitive Types (shared by stacks)
// ====================

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

// HAProxy Frontend configuration
export interface HAProxyFrontendConfig {
  frontendName: string;
  backendName: string;
  hostname: string;
  bindPort: number; // typically 80 or 443
  bindAddress: string; // typically "*" or "0.0.0.0"
  useSSL: boolean;
}

// ====================
// HAProxy Frontend Types
// ====================

export type FrontendType = 'manual' | 'shared';

export interface HAProxyFrontend {
  id: string;
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
  sharedFrontendName?: string | null; // Name of parent shared frontend (for display)
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

export interface SyncFrontendResponse {
  success: boolean;
  message: string;
  data?: HAProxyFrontendInfo;
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
  needsNetworkJoin?: boolean;
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
  healthCheckPath?: string;
  needsNetworkJoin?: boolean;
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

export interface ForceDeleteFrontendResponse {
  success: boolean;
  message: string;
  deletedRoutes: number;
  frontendName: string;
}

export interface ForceDeleteBackendResponse {
  success: boolean;
  message: string;
  deletedServers: number;
  backendName: string;
}

export interface ForceDeleteServerResponse {
  success: boolean;
  message: string;
  backendName: string;
  serverName: string;
}

// ====================
// Async Manual Frontend Setup Types
// ====================

export interface ManualFrontendSetupStep {
  step: string;
  status: 'completed' | 'failed' | 'skipped';
  detail?: string;
}

export interface ManualFrontendSetupResult {
  success: boolean;
  steps: ManualFrontendSetupStep[];
  errors: string[];
  frontendId?: string;
  certificateId?: string;
}

// ====================
// HAProxy Route Types (Shared Frontend)
// ====================

export type RouteSourceType = 'manual' | 'stack';

export interface HAProxyRoute {
  id: string;
  sharedFrontendId: string;
  hostname: string;
  aclName: string;
  backendName: string;
  sourceType: RouteSourceType;
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
// HAProxy Backend & Server Types
// ====================

export type BackendSourceType = 'manual' | 'stack';
export type BackendStatus = 'active' | 'failed';
export type ServerStatus = 'active' | 'draining';

export interface HAProxyBackendInfo {
  id: string;
  name: string;
  environmentId: string;
  mode: string;
  balanceAlgorithm: string;
  checkTimeout: number | null;
  connectTimeout: number | null;
  serverTimeout: number | null;
  sourceType: BackendSourceType;
  manualFrontendId: string | null;
  status: BackendStatus;
  errorMessage: string | null;
  serversCount: number;
  servers?: HAProxyServerInfo[];
  createdAt: string;
  updatedAt: string;
}

export interface HAProxyServerInfo {
  id: string;
  name: string;
  backendId: string;
  backendName?: string;
  address: string;
  port: number;
  check: string;
  checkPath: string | null;
  inter: number | null;
  rise: number | null;
  fall: number | null;
  weight: number;
  enabled: boolean;
  maintenance: boolean;
  containerId: string | null;
  containerName: string | null;
  status: ServerStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HAProxyBackendListResponse {
  success: boolean;
  data: HAProxyBackendInfo[];
  message?: string;
}

export interface HAProxyBackendResponse {
  success: boolean;
  data: HAProxyBackendInfo;
  message?: string;
}

export interface HAProxyServerListResponse {
  success: boolean;
  data: HAProxyServerInfo[];
  message?: string;
}

export interface HAProxyServerResponse {
  success: boolean;
  data: HAProxyServerInfo;
  message?: string;
}

export interface UpdateBackendRequest {
  balanceAlgorithm?: string;
  checkTimeout?: number;
  connectTimeout?: number;
  serverTimeout?: number;
}

export interface UpdateServerRequest {
  weight?: number;
  enabled?: boolean;
  maintenance?: boolean;
  checkPath?: string;
  inter?: number;
  rise?: number;
  fall?: number;
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
    manualFrontends: Array<{ frontendName: string; hostname: string; containerName: string | null }>;
    routes: Array<{ hostname: string; backend: string; ssl: boolean }>;
    backends: string[];
  };
  changes: {
    frontendsToCreate: string[];
    backendsToRecreate: string[];
    routesToAdd: string[];
  };
}

export interface RemediateHAProxyStep {
  step: string;
  status: 'completed' | 'failed' | 'skipped';
  detail?: string;
}

export interface RemediateHAProxyResponse {
  success: boolean;
  data: {
    steps: RemediateHAProxyStep[];
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
    manualFrontendsCount?: number;
    totalRoutesCount?: number;
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

// HAProxy Migration Types (legacy → stack-managed)

export interface MigrationPreview {
  needsMigration: boolean;
  legacyContainer: {
    name: string;
    id: string;
    status: string;
  } | null;
  stackStatus: {
    id: string;
    name: string;
    status: string;
  } | null;
  legacyVolumes: string[];
  certificateCount: number;
  backendCount: number;
  serverCount: number;
  postMigration: {
    newContainerName: string;
    newVolumes: string[];
    networkReused: string;
    remediationNeeded: boolean;
  };
}

export interface MigrationPreviewResponse {
  success: boolean;
  data: MigrationPreview;
}

export interface MigrationStep {
  step: string;
  status: 'completed' | 'failed' | 'skipped';
  detail?: string;
}

export interface MigrationResult {
  success: boolean;
  steps: MigrationStep[];
  errors: string[];
}

export interface MigrationResultResponse {
  success: boolean;
  data: MigrationResult;
  message: string;
}
