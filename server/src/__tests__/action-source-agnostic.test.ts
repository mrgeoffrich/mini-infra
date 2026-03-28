import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the logger
vi.mock('../lib/logger-factory', () => ({
  loadbalancerLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock the ContainerLifecycleManager
const mockCreateContainer = vi.fn().mockResolvedValue('new-container-id');
const mockStartContainer = vi.fn().mockResolvedValue(undefined);
const mockCaptureContainerForDeployment = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/container', () => {
  return {
    ContainerLifecycleManager: class {
      createContainer = mockCreateContainer;
      startContainer = mockStartContainer;
      captureContainerForDeployment = mockCaptureContainerForDeployment;
    },
  };
});

vi.mock('../lib/prisma', () => ({
  default: {
    userEvent: { findUnique: vi.fn(), update: vi.fn() },
    hAProxyBackend: { upsert: vi.fn().mockResolvedValue({ id: 'backend-1' }) },
    hAProxyServer: { upsert: vi.fn().mockResolvedValue({ id: 'server-1' }) },
    hAProxyFrontend: { findUnique: vi.fn().mockResolvedValue(null) },
    deploymentConfiguration: { findUnique: vi.fn().mockResolvedValue(null) },
    deploymentDNSRecord: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('../services/user-events', () => {
  return {
    UserEventService: class {
      appendLogs = vi.fn().mockResolvedValue(undefined);
    },
  };
});

// Mock HAProxyDataPlaneClient
const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockGetBackend = vi.fn().mockResolvedValue(null);
const mockCreateBackend = vi.fn().mockResolvedValue(undefined);
const mockAddServer = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/haproxy/haproxy-dataplane-client', () => {
  return {
    HAProxyDataPlaneClient: class {
      initialize = mockInitialize;
      getBackend = mockGetBackend;
      createBackend = mockCreateBackend;
      addServer = mockAddServer;
    },
  };
});

// Mock haproxyFrontendManager
vi.mock('../services/haproxy/haproxy-frontend-manager', () => ({
  haproxyFrontendManager: {
    getOrCreateSharedFrontend: vi.fn().mockResolvedValue({
      id: 'shared-fe-1',
      frontendName: 'fe_env1_http',
    }),
    addRouteToSharedFrontend: vi.fn().mockResolvedValue({
      id: 'route-1',
    }),
  },
}));

// Mock DNS dependencies
vi.mock('../services/cloudflare', () => ({
  cloudflareDNSService: {
    upsertARecord: vi.fn().mockResolvedValue(undefined),
    findZoneForHostname: vi.fn().mockResolvedValue({ id: 'zone-1' }),
  },
}));

vi.mock('../services/network-utils', () => ({
  networkUtils: {
    getAppropriateIPForEnvironment: vi.fn().mockResolvedValue('192.168.1.100'),
  },
}));

// Mock deployment DNS manager
vi.mock('../services/deployment-dns-manager', () => ({
  deploymentDNSManager: {
    createDNSRecordForDeployment: vi.fn().mockResolvedValue(null),
  },
}));

import { DeployApplicationContainers } from '../services/haproxy/actions/deploy-application-containers';
import { AddContainerToLB } from '../services/haproxy/actions/add-container-to-lb';
import { ConfigureFrontend } from '../services/haproxy/actions/configure-frontend';
import { ConfigureDNS } from '../services/haproxy/actions/configure-dns';
import { cloudflareDNSService } from '../services/cloudflare';
import { haproxyFrontendManager } from '../services/haproxy/haproxy-frontend-manager';

describe('DeployApplicationContainers - source-agnostic', () => {
  let action: DeployApplicationContainers;

  beforeEach(() => {
    vi.clearAllMocks();
    action = new DeployApplicationContainers();
  });

  it('should use containerNetworks from context when config.containerConfig is absent', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      dockerImage: 'myapp/web:1.0.0',
      environmentId: 'env-1',
      environmentName: 'prod',
      haproxyNetworkName: 'haproxy-net',
      haproxyContainerId: 'haproxy-abc123',
      containerNetworks: ['haproxy-net', 'app-network'],
      containerEnvironment: { NODE_ENV: 'production' },
      containerLabels: { 'mini-infra.stack-id': 'stack-1' },
      containerPorts: [{ containerPort: 3000, hostPort: 0, protocol: 'tcp' }],
      containerVolumes: [],
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('DEPLOYMENT_SUCCESS');
    expect(events[0].containerId).toBe('new-container-id');

    // Verify the createContainer call used context fields
    const createCall = mockCreateContainer.mock.calls[0][0];
    expect(createCall.config.networks).toContain('haproxy-net');
    expect(createCall.config.networks).toContain('app-network');
  });

  it('should fall back to config.containerConfig when context fields are absent', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'legacy-app',
      dockerImage: 'legacy/app:2.0',
      environmentId: 'env-1',
      environmentName: 'prod',
      haproxyNetworkName: 'haproxy-net',
      haproxyContainerId: 'haproxy-abc123',
      config: {
        containerConfig: {
          ports: [],
          volumes: [],
          environment: [],
          labels: {},
          networks: ['haproxy-net'],
        },
      },
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('DEPLOYMENT_SUCCESS');
  });
});

describe('AddContainerToLB - source-agnostic', () => {
  let action: AddContainerToLB;

  beforeEach(() => {
    vi.clearAllMocks();
    action = new AddContainerToLB();
  });

  it('should use healthCheck fields from context when config.healthCheck is absent', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      containerId: 'container-abc12345',
      containerName: 'prod-myapp-web',
      containerPort: 3000,
      environmentId: 'env-1',
      environmentName: 'prod',
      haproxyNetworkName: 'haproxy-net',
      haproxyContainerId: 'haproxy-abc123',
      healthCheckEndpoint: '/healthz',
      healthCheckInterval: 5000,
      healthCheckRetries: 3,
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('LB_CONFIGURED');

    // Verify the addServer call used context health check fields
    const serverConfig = mockAddServer.mock.calls[0][1];
    expect(serverConfig.check_path).toBe('/healthz');
    expect(serverConfig.inter).toBe(5000);
    expect(serverConfig.rise).toBe(3);
  });
});

describe('ConfigureFrontend - source-agnostic', () => {
  let action: ConfigureFrontend;

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock getBackend to return a backend for the check
    mockGetBackend.mockResolvedValue({ name: 'stk-myapp-web' });
    action = new ConfigureFrontend();
  });

  it('should use hostname from context when deploymentConfigId is absent', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      environmentId: 'env-1',
      haproxyContainerId: 'haproxy-abc123',
      hostname: 'app.example.com',
      enableSsl: false,
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('FRONTEND_CONFIGURED');
    expect(events[0].hostname).toBe('app.example.com');
  });

  it('should skip when no hostname in context and no deploymentConfigId', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      environmentId: 'env-1',
      haproxyContainerId: 'haproxy-abc123',
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('FRONTEND_CONFIG_SKIPPED');
  });
});

describe('ConfigureDNS - source-agnostic', () => {
  let action: ConfigureDNS;

  beforeEach(() => {
    vi.clearAllMocks();
    action = new ConfigureDNS();
  });

  it('should configure DNS using context fields when deploymentConfigId is absent', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      environmentId: 'env-1',
      hostname: 'app.example.com',
      networkType: 'local',
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('DNS_CONFIGURED');
    expect(cloudflareDNSService.upsertARecord).toHaveBeenCalledWith('app.example.com', '192.168.1.100', 300, false);
  });

  it('should skip DNS when networkType is internet', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      environmentId: 'env-1',
      hostname: 'app.example.com',
      networkType: 'internet',
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('DNS_CONFIG_SKIPPED');
  });

  it('should skip DNS when no hostname and no deploymentConfigId', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      environmentId: 'env-1',
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('DNS_CONFIG_SKIPPED');
  });
});
