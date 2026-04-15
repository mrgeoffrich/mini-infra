import { HttpError } from '../lib/http-client';
import { HAProxyDataPlaneClient, BackendConfig, ServerConfig, FrontendConfig } from '../services/haproxy/haproxy-dataplane-client';
import DockerService from '../services/docker';

// Hoist the prisma findFirst mock so we can reference it in both vi.mock and beforeEach
const { mockFindFirst } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
}));

// Mock dependencies
vi.mock('../services/docker');
vi.mock('../services/self-update', () => ({
  getOwnContainerId: vi.fn(() => 'mock-self-container-id'),
}));
vi.mock('../lib/logger-factory', () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    createLogger: vi.fn(function() { return mockLoggerInstance; }),
    getLogger: vi.fn(function() { return mockLoggerInstance; }),
    clearLoggerCache: vi.fn(),
    createChildLogger: vi.fn(function() { return mockLoggerInstance; }),
    selfBackupLogger: vi.fn(function() { return mockLoggerInstance; }),
    serializeError: (e: unknown) => e,
    appLogger: vi.fn(function() { return mockLoggerInstance; }),
    httpLogger: vi.fn(function() { return mockLoggerInstance; }),
    prismaLogger: vi.fn(function() { return mockLoggerInstance; }),
    servicesLogger: vi.fn(function() { return mockLoggerInstance; }),
    dockerExecutorLogger: vi.fn(function() { return mockLoggerInstance; }),
    deploymentLogger: vi.fn(function() { return mockLoggerInstance; }),
    loadbalancerLogger: vi.fn(function() { return mockLoggerInstance; }),
    tlsLogger: vi.fn(function() { return mockLoggerInstance; }),
    agentLogger: vi.fn(function() { return mockLoggerInstance; }),
    selfBackupLogger: vi.fn(function() { return mockLoggerInstance; }),
  };
});
vi.mock('../lib/prisma', () => ({
  default: {
    systemSettings: {
      findFirst: mockFindFirst,
    },
  },
}));

const MockedDockerService = DockerService as MockedClass<typeof DockerService>;

/** Helper: get the mock httpClient from the client instance */
function getMockHttpClient(client: HAProxyDataPlaneClient) {
  return (client as any).httpClient as {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    defaults: { baseURL: string; auth: any; timeout: number; headers: Record<string, string> };
  };
}

/** Standard mock container info with Networks for initialization */
const MOCK_CONTAINER_INFO = {
  Name: '/test-haproxy',
  NetworkSettings: {
    Ports: {
      '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: '5555' }]
    },
    Networks: {
      'haproxy_network': { IPAddress: '172.18.0.2' }
    }
  }
};

describe('HAProxyDataPlaneClient', () => {
  let client: HAProxyDataPlaneClient;
  let mockDockerService: Mocked<DockerService>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFindFirst.mockResolvedValue({
      id: 'setting-1',
      category: 'system',
      key: 'docker_host_ip',
      value: '192.168.1.100',
      isActive: true,
    });

    // Mock DockerService
    mockDockerService = {
      getInstance: vi.fn().mockReturnThis(),
      initialize: vi.fn().mockResolvedValue(undefined),
      getDockerInstance: vi.fn()
    } as any;

    MockedDockerService.getInstance.mockReturnValue(mockDockerService);

    client = new HAProxyDataPlaneClient();

    // Replace httpClient methods with mocks (preserving defaults object)
    const hc = getMockHttpClient(client);
    hc.get = vi.fn();
    hc.post = vi.fn();
    hc.put = vi.fn();
    hc.delete = vi.fn();
  });

  /** Helper: set up Docker mocks + successful initialization */
  async function initializeClient(containerInfo = MOCK_CONTAINER_INFO) {
    const mockSelfInfo = {
      NetworkSettings: { Networks: { 'haproxy_network': { IPAddress: '172.18.0.3' } } }
    };
    const mockContainer = { inspect: vi.fn().mockResolvedValue(containerInfo) };
    const mockSelfContainer = { inspect: vi.fn().mockResolvedValue(mockSelfInfo) };
    const mockDocker = {
      getContainer: vi.fn().mockImplementation((id: string) => {
        return id === 'mock-self-container-id' ? mockSelfContainer : mockContainer;
      })
    };
    mockDockerService.getDockerInstance.mockResolvedValue(mockDocker);

    const hc = getMockHttpClient(client);
    hc.get.mockResolvedValue({ status: 200, data: { api: { version: '2.4' }, haproxy: { version: '2.6' } } });

    await client.initialize('container123');

    return { mockContainer, mockDocker, hc };
  }

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      const { mockDocker, mockContainer, hc } = await initializeClient();

      expect(mockDockerService.initialize).toHaveBeenCalled();
      expect(mockDocker.getContainer).toHaveBeenCalledWith('container123');
      expect(mockContainer.inspect).toHaveBeenCalled();
      expect(hc.defaults.baseURL).toBe('http://172.18.0.2:5555/v3');
      expect(hc.defaults.auth).toEqual({ username: 'admin', password: 'adminpwd' });
      expect(hc.get).toHaveBeenCalledWith('/info');
    });

    it('should throw error when container not found', async () => {
      const mockContainer = { inspect: vi.fn().mockResolvedValue(null) };
      const mockDocker = { getContainer: vi.fn().mockReturnValue(mockContainer) };
      mockDockerService.getDockerInstance.mockResolvedValue(mockDocker);

      await expect(client.initialize('container123')).rejects.toThrow(
        'HAProxy container not found or not accessible'
      );
    });

    it('should throw error when no networks', async () => {
      const mockContainer = { inspect: vi.fn().mockResolvedValue({
        Name: '/test-haproxy',
        NetworkSettings: { Ports: {}, Networks: {} }
      }) };
      const mockDocker = { getContainer: vi.fn().mockReturnValue(mockContainer) };
      mockDockerService.getDockerInstance.mockResolvedValue(mockDocker);

      await expect(client.initialize('container123')).rejects.toThrow(
        'HAProxy container has no network connections'
      );
    });

    it('should throw error when API connection test fails', async () => {
      const mockSelfInfo = {
        NetworkSettings: { Networks: { 'haproxy_network': { IPAddress: '172.18.0.3' } } }
      };
      const mockContainer = { inspect: vi.fn().mockResolvedValue(MOCK_CONTAINER_INFO) };
      const mockSelfContainer = { inspect: vi.fn().mockResolvedValue(mockSelfInfo) };
      const mockDocker = {
        getContainer: vi.fn().mockImplementation((id: string) =>
          id === 'mock-self-container-id' ? mockSelfContainer : mockContainer
        )
      };
      mockDockerService.getDockerInstance.mockResolvedValue(mockDocker);

      const hc = getMockHttpClient(client);
      hc.get.mockRejectedValue(new HttpError('Connection refused', { code: 'ECONNREFUSED' }));

      await expect(client.initialize('container123')).rejects.toThrow(
        'DataPlane API connection failed: Connection refused'
      );
    });
  });

  describe('backend management', () => {
    let hc: ReturnType<typeof getMockHttpClient>;

    beforeEach(async () => {
      ({ hc } = await initializeClient());
      // Clear init call counts but keep the mock functions
      hc.get.mockClear();
      hc.post.mockClear();
      hc.put.mockClear();
      hc.delete.mockClear();
    });

    describe('createBackend', () => {
      it('should create backend with default configuration', async () => {
        hc.get.mockResolvedValue({ status: 200, data: 1 });
        hc.post.mockResolvedValue({ status: 201 });

        await client.createBackend({ name: 'test-backend' });

        expect(hc.post).toHaveBeenCalledWith(
          '/services/haproxy/configuration/backends?version=1',
          { name: 'test-backend', mode: 'http', balance: { algorithm: 'roundrobin' } }
        );
      });

      it('should create backend with custom configuration', async () => {
        hc.get.mockResolvedValue({ status: 200, data: 1 });
        hc.post.mockResolvedValue({ status: 201 });

        await client.createBackend({
          name: 'test-backend', mode: 'tcp', balance: 'leastconn',
          check_timeout: 5000, connect_timeout: 3000, server_timeout: 30000
        });

        expect(hc.post).toHaveBeenCalledWith(
          '/services/haproxy/configuration/backends?version=1',
          {
            name: 'test-backend', mode: 'tcp', balance: { algorithm: 'leastconn' },
            check_timeout: 5000, connect_timeout: 3000, server_timeout: 30000
          }
        );
      });

      it('should handle API errors', async () => {
        hc.get.mockResolvedValue({ status: 200, data: 1 });
        hc.post.mockRejectedValue(new HttpError('Backend already exists', {
          response: { status: 400, data: { message: 'Backend already exists' } }
        }));

        await expect(client.createBackend({ name: 'test-backend' })).rejects.toThrow(
          'Bad request: Backend already exists'
        );
      });
    });

    describe('getBackend', () => {
      it('should return backend when it exists', async () => {
        const mockBackend = { name: 'test-backend', mode: 'http', balance: { algorithm: 'roundrobin' } };
        hc.get.mockResolvedValue({ status: 200, data: { data: mockBackend } });

        const result = await client.getBackend('test-backend');
        expect(result).toEqual(mockBackend);
        expect(hc.get).toHaveBeenCalledWith('/services/haproxy/configuration/backends/test-backend');
      });

      it('should return null when backend does not exist', async () => {
        hc.get.mockRejectedValue(new HttpError('Not found', { response: { status: 404, data: {} } }));
        const result = await client.getBackend('nonexistent-backend');
        expect(result).toBeNull();
      });
    });

    describe('deleteBackend', () => {
      it('should delete backend successfully', async () => {
        hc.get.mockResolvedValue({ status: 200, data: 1 });
        hc.delete.mockResolvedValue({ status: 204 });
        await client.deleteBackend('test-backend');
        expect(hc.delete).toHaveBeenCalledWith('/services/haproxy/configuration/backends/test-backend?version=1');
      });
    });

    describe('listBackends', () => {
      it('should return list of backends', async () => {
        const mockBackends = [{ name: 'backend1', mode: 'http' }, { name: 'backend2', mode: 'tcp' }];
        hc.get.mockResolvedValue({ status: 200, data: { data: mockBackends } });
        const result = await client.listBackends();
        expect(result).toEqual(mockBackends);
      });

      it('should return empty array on error', async () => {
        hc.get.mockRejectedValue(new HttpError('API Error', { response: { status: 500, data: {} } }));
        const result = await client.listBackends();
        expect(result).toEqual([]);
      });
    });
  });

  describe('server management', () => {
    let hc: ReturnType<typeof getMockHttpClient>;

    beforeEach(async () => {
      ({ hc } = await initializeClient());
      hc.get.mockClear(); hc.post.mockClear(); hc.put.mockClear(); hc.delete.mockClear();
    });

    describe('addServer', () => {
      it('should add server with minimal configuration via transaction', async () => {
        hc.get.mockResolvedValue({ status: 200, data: 1 });
        hc.post
          .mockResolvedValueOnce({ status: 201, data: { id: 'txn-add-1' } })
          .mockResolvedValueOnce({ status: 201 });
        hc.put.mockResolvedValue({ status: 200 });

        await client.addServer('test-backend', { name: 'server1', address: '192.168.1.100', port: 8080 });

        expect(hc.post).toHaveBeenCalledWith(
          expect.stringContaining('/services/haproxy/configuration/backends/test-backend/servers'),
          { name: 'server1', address: '192.168.1.100', port: 8080, maintenance: 'disabled', enabled: true }
        );
      });

      it('should add server with full configuration via transaction', async () => {
        hc.get.mockResolvedValue({ status: 200, data: 1 });
        hc.post
          .mockResolvedValueOnce({ status: 201, data: { id: 'txn-add-2' } })
          .mockResolvedValueOnce({ status: 201 });
        hc.put.mockResolvedValue({ status: 200 });

        await client.addServer('test-backend', {
          name: 'server1', address: '192.168.1.100', port: 8080,
          check: 'enabled', check_path: '/health', inter: 5000,
          rise: 2, fall: 3, weight: 100, maintenance: false, enabled: false
        });

        expect(hc.post).toHaveBeenCalledWith(
          expect.stringContaining('/services/haproxy/configuration/backends/test-backend/servers'),
          {
            name: 'server1', address: '192.168.1.100', port: 8080,
            check: 'enabled', check_path: '/health', inter: 5000,
            rise: 2, fall: 3, weight: 100, maintenance: 'disabled', enabled: false
          }
        );
      });
    });

    describe('enableServer', () => {
      it('should enable server successfully', async () => {
        hc.put.mockResolvedValue({ status: 200 });
        await client.enableServer('test-backend', 'server1');
        expect(hc.put).toHaveBeenCalledWith(
          '/services/haproxy/runtime/backends/test-backend/servers/server1',
          { admin_state: 'ready' }
        );
      });
    });

    describe('disableServer', () => {
      it('should disable server successfully', async () => {
        hc.put.mockResolvedValue({ status: 200 });
        await client.disableServer('test-backend', 'server1');
        expect(hc.put).toHaveBeenCalledWith(
          '/services/haproxy/runtime/backends/test-backend/servers/server1',
          { admin_state: 'maint' }
        );
      });
    });

    describe('setServerState', () => {
      it('should set server state successfully', async () => {
        hc.put.mockResolvedValue({ status: 200 });
        await client.setServerState('test-backend', 'server1', 'drain');
        expect(hc.put).toHaveBeenCalledWith(
          '/services/haproxy/runtime/backends/test-backend/servers/server1',
          { admin_state: 'drain' }
        );
      });
    });

    describe('deleteServer', () => {
      it('should delete server successfully', async () => {
        hc.get.mockResolvedValue({ status: 200, data: 1 });
        hc.delete.mockResolvedValue({ status: 204 });
        await client.deleteServer('test-backend', 'server1');
        expect(hc.delete).toHaveBeenCalledWith(
          '/services/haproxy/configuration/backends/test-backend/servers/server1?version=1'
        );
      });
    });
  });

  describe('frontend management', () => {
    let hc: ReturnType<typeof getMockHttpClient>;

    beforeEach(async () => {
      ({ hc } = await initializeClient());
      hc.get.mockClear(); hc.post.mockClear(); hc.put.mockClear(); hc.delete.mockClear();
    });

    describe('createFrontend', () => {
      it('should create frontend with minimal configuration', async () => {
        hc.get.mockResolvedValue({ status: 200, data: 1 });
        hc.post.mockResolvedValue({ status: 201 });
        await client.createFrontend({ name: 'test-frontend' });
        expect(hc.post).toHaveBeenCalledWith(
          '/services/haproxy/configuration/frontends?version=1',
          { name: 'test-frontend', mode: 'http' }
        );
      });

      it('should create frontend with full configuration', async () => {
        hc.get.mockResolvedValue({ status: 200, data: 1 });
        hc.post.mockResolvedValue({ status: 201 });
        await client.createFrontend({ name: 'test-frontend', mode: 'tcp', default_backend: 'test-backend' });
        expect(hc.post).toHaveBeenCalledWith(
          '/services/haproxy/configuration/frontends?version=1',
          { name: 'test-frontend', mode: 'tcp', default_backend: 'test-backend' }
        );
      });
    });

    describe('addFrontendBind', () => {
      it('should add bind to frontend successfully', async () => {
        hc.get.mockResolvedValue({ status: 200, data: 1 });
        hc.post.mockResolvedValue({ status: 201 });
        await client.addFrontendBind('test-frontend', '*', 80);
        expect(hc.post).toHaveBeenCalledWith(
          '/services/haproxy/configuration/frontends/test-frontend/binds?version=1',
          { name: 'bind_80', address: '*', port: 80 }
        );
      });
    });
  });

  describe('statistics', () => {
    let hc: ReturnType<typeof getMockHttpClient>;

    beforeEach(async () => {
      ({ hc } = await initializeClient());
      hc.get.mockClear(); hc.post.mockClear(); hc.put.mockClear(); hc.delete.mockClear();
    });

    describe('getServerStats', () => {
      it('should return server statistics', async () => {
        hc.get.mockResolvedValue({
          status: 200, data: { stats: [{ name: 'server1', stats: {
            status: 'UP', check_status: 'L7OK', check_duration: 1, weight: 1,
            scur: 5, smax: 10, stot: 100, bin: 1024, bout: 2048,
            dreq: 0, econ: 0, eresp: 0, wretr: 0, wredis: 0
          }}]}
        });

        const result = await client.getServerStats('test-backend', 'server1');
        expect(result).toEqual({
          name: 'server1', status: 'UP', check_status: 'L7OK', check_duration: 1, weight: 1,
          current_sessions: 5, max_sessions: 10, total_sessions: 100,
          bytes_in: 1024, bytes_out: 2048, denied_requests: 0,
          errors_con: 0, errors_resp: 0, warnings_retr: 0, warnings_redis: 0
        });
      });

      it('should return null when server not found', async () => {
        hc.get.mockRejectedValue(new HttpError('Not found', { response: { status: 404, data: {} } }));
        const result = await client.getServerStats('test-backend', 'server1');
        expect(result).toBeNull();
      });
    });

    describe('getBackendStats', () => {
      it('should return backend statistics', async () => {
        hc.get.mockResolvedValue({
          status: 200, data: { stats: [{ name: 'test-backend', stats: {
            status: 'UP', scur: 10, smax: 20, stot: 200, bin: 2048, bout: 4096,
            dreq: 0, econ: 0, eresp: 0, weight: 1, act: 2, bck: 0
          }}]}
        });

        const result = await client.getBackendStats('test-backend');
        expect(result).toEqual({
          name: 'test-backend', status: 'UP', current_sessions: 10, max_sessions: 20,
          total_sessions: 200, bytes_in: 2048, bytes_out: 4096, denied_requests: 0,
          errors_con: 0, errors_resp: 0, weight: 1, act_servers: 2, bck_servers: 0
        });
      });
    });
  });

  describe('transaction management', () => {
    let hc: ReturnType<typeof getMockHttpClient>;

    beforeEach(async () => {
      ({ hc } = await initializeClient());
      hc.get.mockClear(); hc.post.mockClear(); hc.put.mockClear(); hc.delete.mockClear();
    });

    it('should begin transaction and return transaction ID', async () => {
      hc.get.mockResolvedValue({ status: 200, data: 1 });
      hc.post.mockResolvedValue({ status: 201, data: { id: 'txn-123' } });
      const transactionId = await client.beginTransaction();
      expect(transactionId).toBe('txn-123');
      expect(hc.post).toHaveBeenCalledWith('/services/haproxy/transactions?version=1', { version: 1 });
    });

    it('should commit transaction successfully', async () => {
      hc.put.mockResolvedValue({ status: 200 });
      await client.commitTransaction('txn-123');
      expect(hc.put).toHaveBeenCalledWith('/services/haproxy/transactions/txn-123', { force_reload: true });
    });

    it('should rollback transaction successfully', async () => {
      hc.delete.mockResolvedValue({ status: 204 });
      await client.rollbackTransaction('txn-123');
      expect(hc.delete).toHaveBeenCalledWith('/services/haproxy/transactions/txn-123');
    });
  });

  describe('utility methods', () => {
    it('should return connection info after initialization', async () => {
      await initializeClient();
      const connectionInfo = client.getConnectionInfo();
      expect(connectionInfo).toEqual({
        baseUrl: 'http://172.18.0.2:5555/v3',
        containerName: 'test-haproxy',
        containerId: 'container123'
      });
    });

    it('should return null connection info before initialization', () => {
      expect(client.getConnectionInfo()).toBeNull();
    });

    it('should return initialization status', async () => {
      expect(client.isInitialized()).toBe(false);
      await initializeClient();
      expect(client.isInitialized()).toBe(true);
    });
  });
});
