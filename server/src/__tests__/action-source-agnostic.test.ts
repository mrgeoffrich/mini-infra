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

vi.mock('../services/haproxy/haproxy-dataplane-client', () => ({
  HAProxyDataPlaneClient: vi.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    getBackend: mockGetBackend,
    createBackend: mockCreateBackend,
    addServer: mockAddServer,
  })),
}));

// Mock haproxyFrontendManager
const mockGetOrCreateSharedFrontend = vi.fn().mockResolvedValue({
  id: 'shared-fe-1',
  frontendName: 'fe_env1_http',
});
const mockAddRouteToSharedFrontend = vi.fn().mockResolvedValue({
  id: 'route-1',
});

vi.mock('../services/haproxy/haproxy-frontend-manager', () => ({
  haproxyFrontendManager: {
    getOrCreateSharedFrontend: mockGetOrCreateSharedFrontend,
    addRouteToSharedFrontend: mockAddRouteToSharedFrontend,
  },
}));

// Mock DNS dependencies
const mockUpsertARecord = vi.fn().mockResolvedValue(undefined);
const mockFindZoneForHostname = vi.fn().mockResolvedValue({ id: 'zone-1' });

vi.mock('../services/cloudflare', () => ({
  cloudflareDNSService: {
    upsertARecord: mockUpsertARecord,
    findZoneForHostname: mockFindZoneForHostname,
  },
}));

const mockGetAppropriateIPForEnvironment = vi.fn().mockResolvedValue('192.168.1.100');

vi.mock('../services/network-utils', () => ({
  networkUtils: {
    getAppropriateIPForEnvironment: mockGetAppropriateIPForEnvironment,
  },
}));

// Mock deployment DNS manager
vi.mock('../services/deployment-dns-manager', () => ({
  deploymentDNSManager: {
    createDNSRecordForDeployment: vi.fn().mockResolvedValue(null),
  },
}));

import { DeployApplicationContainers } from '../services/haproxy/actions/deploy-application-containers';

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
