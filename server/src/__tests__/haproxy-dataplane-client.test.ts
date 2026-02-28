import axios from 'axios';
import { HAProxyDataPlaneClient, BackendConfig, ServerConfig, FrontendConfig } from '../services/haproxy/haproxy-dataplane-client';
import DockerService from '../services/docker';

// Hoist the prisma findFirst mock so we can reference it in both vi.mock and beforeEach
const { mockFindFirst } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
}));

// Mock dependencies
vi.mock('axios');
vi.mock('../services/docker');
vi.mock('../lib/logger-factory', () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    createLogger: vi.fn(function() { return mockLoggerInstance; }),
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

const mockedAxios = axios as Mocked<typeof axios>;
const MockedDockerService = DockerService as MockedClass<typeof DockerService>;

// Mock axios.isAxiosError function
mockedAxios.isAxiosError = vi.fn((payload): payload is any => {
  return payload && typeof payload === 'object' && payload.isAxiosError === true;
});

describe('HAProxyDataPlaneClient', () => {
  let client: HAProxyDataPlaneClient;
  let mockDockerService: Mocked<DockerService>;
  let mockAxiosInstance: Mocked<any>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up the default prisma mock to return a docker host IP
    mockFindFirst.mockResolvedValue({
      id: 'setting-1',
      category: 'system',
      key: 'docker_host_ip',
      value: '192.168.1.100',
      isActive: true,
    });

    // Mock axios instance
    mockAxiosInstance = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      defaults: {
        baseURL: '',
        auth: {},
        timeout: 10000,
        headers: {}
      }
    };

    mockedAxios.create.mockReturnValue(mockAxiosInstance);

    // Re-setup isAxiosError after clearAllMocks
    mockedAxios.isAxiosError = vi.fn((payload): payload is any => {
      return payload && typeof payload === 'object' && payload.isAxiosError === true;
    });

    // Mock DockerService
    mockDockerService = {
      getInstance: vi.fn().mockReturnThis(),
      initialize: vi.fn().mockResolvedValue(undefined),
      getDockerInstance: vi.fn()
    } as any;

    MockedDockerService.getInstance.mockReturnValue(mockDockerService);

    client = new HAProxyDataPlaneClient();
  });

  describe('initialization', () => {
    const mockContainerInfo = {
      Name: '/test-haproxy',
      NetworkSettings: {
        Ports: {
          '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: '5555' }]
        },
        Networks: {
          'haproxy_network': {
            IPAddress: '172.18.0.2'
          }
        }
      }
    };

    const mockContainer = {
      inspect: vi.fn().mockResolvedValue(mockContainerInfo)
    };

    const mockDocker = {
      getContainer: vi.fn().mockReturnValue(mockContainer)
    };

    beforeEach(() => {
      mockDockerService.getDockerInstance.mockResolvedValue(mockDocker);
      mockAxiosInstance.get.mockResolvedValue({
        status: 200,
        data: {
          api: { version: '2.4' },
          haproxy: { version: '2.6' }
        }
      });
    });

    it('should initialize successfully with host port binding', async () => {
      await client.initialize('container123');

      expect(mockDockerService.initialize).toHaveBeenCalled();
      expect(mockDocker.getContainer).toHaveBeenCalledWith('container123');
      expect(mockContainer.inspect).toHaveBeenCalled();
      expect(mockAxiosInstance.defaults.baseURL).toBe('http://192.168.1.100:5555/v3');
      expect(mockAxiosInstance.defaults.auth).toEqual({
        username: 'admin',
        password: 'adminpwd'
      });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/info');
    });

    it('should throw error when port is not bound to a host port', async () => {
      const mockContainerInfoNoBinding = {
        ...mockContainerInfo,
        NetworkSettings: {
          Ports: {
            '5555/tcp': [{}] // Empty object indicates port exists but no host binding
          },
          Networks: {
            'haproxy_network': {
              IPAddress: '172.18.0.2'
            }
          }
        }
      };

      mockContainer.inspect.mockResolvedValue(mockContainerInfoNoBinding);

      await expect(client.initialize('container123')).rejects.toThrow(
        'DataPlane API port 5555 is not bound to a host port'
      );
    });

    it('should use docker host IP from system settings regardless of networks', async () => {
      const mockContainerInfoMultiNetwork = {
        ...mockContainerInfo,
        NetworkSettings: {
          Ports: {
            '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: '5555' }]
          },
          Networks: {
            'bridge': {
              IPAddress: '172.17.0.2'
            },
            'haproxy_network': {
              IPAddress: '172.18.0.2'
            }
          }
        }
      };

      mockContainer.inspect.mockResolvedValue(mockContainerInfoMultiNetwork);

      await client.initialize('container123');

      // Should use the configured Docker host IP, not container network IPs
      expect(mockAxiosInstance.defaults.baseURL).toBe('http://192.168.1.100:5555/v3');
    });

    it('should throw error when container not found', async () => {
      mockContainer.inspect.mockResolvedValue(null);

      await expect(client.initialize('container123')).rejects.toThrow(
        'HAProxy container not found or not accessible'
      );
    });

    it('should throw error when DataPlane API port not exposed', async () => {
      const mockContainerInfoNoPort = {
        ...mockContainerInfo,
        NetworkSettings: {
          Ports: {},
          Networks: {
            'haproxy_network': {
              IPAddress: '172.18.0.2'
            }
          }
        }
      };

      mockContainer.inspect.mockResolvedValue(mockContainerInfoNoPort);

      await expect(client.initialize('container123')).rejects.toThrow(
        'DataPlane API port 5555 is not exposed on HAProxy container'
      );
    });

    it('should throw error when docker host IP is not configured', async () => {
      // Ensure container info has valid ports so we reach the IP lookup
      mockContainer.inspect.mockResolvedValue(mockContainerInfo);
      // Override prisma mock to return null for this test
      mockFindFirst.mockResolvedValue(null);

      await expect(client.initialize('container123')).rejects.toThrow(
        'Docker host IP not configured'
      );
    });

    it('should throw error when API connection test fails', async () => {
      // First, make sure the container info is valid to get past discovery
      const mockContainerInfoValidForApiTest = {
        Name: '/test-haproxy',
        NetworkSettings: {
          Ports: {
            '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: '5555' }]
          },
          Networks: {
            'haproxy_network': {
              IPAddress: '172.18.0.2'
            }
          }
        }
      };

      mockContainer.inspect.mockResolvedValue(mockContainerInfoValidForApiTest);

      // Mock the API test to fail with axios error
      const axiosError = {
        isAxiosError: true,
        response: undefined,
        message: 'Connection refused'
      };
      mockAxiosInstance.get.mockRejectedValue(axiosError);

      await expect(client.initialize('container123')).rejects.toThrow(
        'DataPlane API connection failed: Connection refused'
      );
    });
  });

  describe('backend management', () => {
    beforeEach(async () => {
      // Mock successful initialization
      const mockContainerInfo = {
        Name: '/test-haproxy',
        NetworkSettings: {
          Ports: {
            '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: '5555' }]
          }
        }
      };

      const mockContainer = {
        inspect: vi.fn().mockResolvedValue(mockContainerInfo)
      };

      const mockDocker = {
        getContainer: vi.fn().mockReturnValue(mockContainer)
      };

      mockDockerService.getDockerInstance.mockResolvedValue(mockDocker);
      mockAxiosInstance.get.mockResolvedValue({ status: 200, data: {} });

      await client.initialize('container123');
      vi.clearAllMocks();
    });

    describe('createBackend', () => {
      it('should create backend with default configuration', async () => {
        // getVersion returns a number via get
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: 1 });
        mockAxiosInstance.post.mockResolvedValue({ status: 201 });

        const config: BackendConfig = {
          name: 'test-backend'
        };

        await client.createBackend(config);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/services/haproxy/configuration/backends?version=1',
          {
            name: 'test-backend',
            mode: 'http',
            balance: {
              algorithm: 'roundrobin'
            }
          }
        );
      });

      it('should create backend with custom configuration', async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: 1 });
        mockAxiosInstance.post.mockResolvedValue({ status: 201 });

        const config: BackendConfig = {
          name: 'test-backend',
          mode: 'tcp',
          balance: 'leastconn',
          check_timeout: 5000,
          connect_timeout: 3000,
          server_timeout: 30000
        };

        await client.createBackend(config);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/services/haproxy/configuration/backends?version=1',
          {
            name: 'test-backend',
            mode: 'tcp',
            balance: {
              algorithm: 'leastconn'
            },
            check_timeout: 5000,
            connect_timeout: 3000,
            server_timeout: 30000
          }
        );
      });

      it('should handle API errors', async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: 1 });
        const apiError = {
          isAxiosError: true,
          response: {
            status: 400,
            data: { message: 'Backend already exists' }
          },
          message: 'Request failed with status code 400'
        };
        mockAxiosInstance.post.mockRejectedValue(apiError);

        const config: BackendConfig = {
          name: 'test-backend'
        };

        await expect(client.createBackend(config)).rejects.toThrow(
          'Bad request: Backend already exists'
        );
      });
    });

    describe('getBackend', () => {
      it('should return backend when it exists', async () => {
        const mockBackend = {
          name: 'test-backend',
          mode: 'http',
          balance: { algorithm: 'roundrobin' }
        };

        mockAxiosInstance.get.mockResolvedValue({
          status: 200,
          data: { data: mockBackend }
        });

        const result = await client.getBackend('test-backend');

        expect(result).toEqual(mockBackend);
        expect(mockAxiosInstance.get).toHaveBeenCalledWith(
          '/services/haproxy/configuration/backends/test-backend'
        );
      });

      it('should return null when backend does not exist', async () => {
        const apiError = {
          isAxiosError: true,
          response: { status: 404 },
          message: 'Request failed with status code 404'
        };
        mockAxiosInstance.get.mockRejectedValue(apiError);

        const result = await client.getBackend('nonexistent-backend');

        expect(result).toBeNull();
      });
    });

    describe('deleteBackend', () => {
      it('should delete backend successfully', async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: 1 });
        mockAxiosInstance.delete.mockResolvedValue({ status: 204 });

        await client.deleteBackend('test-backend');

        expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
          '/services/haproxy/configuration/backends/test-backend?version=1'
        );
      });
    });

    describe('listBackends', () => {
      it('should return list of backends', async () => {
        const mockBackends = [
          { name: 'backend1', mode: 'http' },
          { name: 'backend2', mode: 'tcp' }
        ];

        mockAxiosInstance.get.mockResolvedValue({
          status: 200,
          data: { data: mockBackends }
        });

        const result = await client.listBackends();

        expect(result).toEqual(mockBackends);
        expect(mockAxiosInstance.get).toHaveBeenCalledWith(
          '/services/haproxy/configuration/backends'
        );
      });

      it('should return empty array on error', async () => {
        const apiError = {
          isAxiosError: true,
          response: { status: 500 },
          message: 'API Error'
        };
        mockAxiosInstance.get.mockRejectedValue(apiError);

        const result = await client.listBackends();

        expect(result).toEqual([]);
      });
    });
  });

  describe('server management', () => {
    beforeEach(async () => {
      // Mock successful initialization
      const mockContainerInfo = {
        Name: '/test-haproxy',
        NetworkSettings: {
          Ports: {
            '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: '5555' }]
          }
        }
      };

      const mockContainer = {
        inspect: vi.fn().mockResolvedValue(mockContainerInfo)
      };

      const mockDocker = {
        getContainer: vi.fn().mockReturnValue(mockContainer)
      };

      mockDockerService.getDockerInstance.mockResolvedValue(mockDocker);
      mockAxiosInstance.get.mockResolvedValue({ status: 200, data: {} });

      await client.initialize('container123');
      vi.clearAllMocks();
    });

    describe('addServer', () => {
      it('should add server with minimal configuration via transaction', async () => {
        // getVersion (called by beginTransaction) returns version number
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: 1 });
        // beginTransaction: post returns transaction id, then addServer post
        mockAxiosInstance.post
          .mockResolvedValueOnce({ status: 201, data: { id: 'txn-add-1' } }) // beginTransaction
          .mockResolvedValueOnce({ status: 201 }); // addServer post
        // commitTransaction: put
        mockAxiosInstance.put.mockResolvedValue({ status: 200 });

        const config: ServerConfig = {
          name: 'server1',
          address: '192.168.1.100',
          port: 8080
        };

        await client.addServer('test-backend', config);

        // Verify the server was added via transaction
        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          expect.stringContaining('/services/haproxy/configuration/backends/test-backend/servers'),
          {
            name: 'server1',
            address: '192.168.1.100',
            port: 8080,
            maintenance: 'disabled',
            enabled: true
          }
        );
      });

      it('should add server with full configuration via transaction', async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: 1 });
        mockAxiosInstance.post
          .mockResolvedValueOnce({ status: 201, data: { id: 'txn-add-2' } }) // beginTransaction
          .mockResolvedValueOnce({ status: 201 }); // addServer post
        mockAxiosInstance.put.mockResolvedValue({ status: 200 });

        const config: ServerConfig = {
          name: 'server1',
          address: '192.168.1.100',
          port: 8080,
          check: 'enabled',
          check_path: '/health',
          inter: 5000,
          rise: 2,
          fall: 3,
          weight: 100,
          maintenance: false,
          enabled: false
        };

        await client.addServer('test-backend', config);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          expect.stringContaining('/services/haproxy/configuration/backends/test-backend/servers'),
          {
            name: 'server1',
            address: '192.168.1.100',
            port: 8080,
            check: 'enabled',
            check_path: '/health',
            inter: 5000,
            rise: 2,
            fall: 3,
            weight: 100,
            maintenance: 'disabled',
            enabled: false
          }
        );
      });
    });

    describe('enableServer', () => {
      it('should enable server successfully', async () => {
        mockAxiosInstance.put.mockResolvedValue({ status: 200 });

        await client.enableServer('test-backend', 'server1');

        expect(mockAxiosInstance.put).toHaveBeenCalledWith(
          '/services/haproxy/runtime/backends/test-backend/servers/server1',
          { admin_state: 'ready' }
        );
      });
    });

    describe('disableServer', () => {
      it('should disable server successfully', async () => {
        mockAxiosInstance.put.mockResolvedValue({ status: 200 });

        await client.disableServer('test-backend', 'server1');

        expect(mockAxiosInstance.put).toHaveBeenCalledWith(
          '/services/haproxy/runtime/backends/test-backend/servers/server1',
          { admin_state: 'maint' }
        );
      });
    });

    describe('setServerState', () => {
      it('should set server state successfully', async () => {
        mockAxiosInstance.put.mockResolvedValue({ status: 200 });

        await client.setServerState('test-backend', 'server1', 'drain');

        expect(mockAxiosInstance.put).toHaveBeenCalledWith(
          '/services/haproxy/runtime/backends/test-backend/servers/server1',
          { admin_state: 'drain' }
        );
      });
    });

    describe('deleteServer', () => {
      it('should delete server successfully', async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: 1 });
        mockAxiosInstance.delete.mockResolvedValue({ status: 204 });

        await client.deleteServer('test-backend', 'server1');

        expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
          '/services/haproxy/configuration/backends/test-backend/servers/server1?version=1'
        );
      });
    });
  });

  describe('frontend management', () => {
    beforeEach(async () => {
      // Mock successful initialization
      const mockContainerInfo = {
        Name: '/test-haproxy',
        NetworkSettings: {
          Ports: {
            '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: '5555' }]
          }
        }
      };

      const mockContainer = {
        inspect: vi.fn().mockResolvedValue(mockContainerInfo)
      };

      const mockDocker = {
        getContainer: vi.fn().mockReturnValue(mockContainer)
      };

      mockDockerService.getDockerInstance.mockResolvedValue(mockDocker);
      mockAxiosInstance.get.mockResolvedValue({ status: 200, data: {} });

      await client.initialize('container123');
      vi.clearAllMocks();
    });

    describe('createFrontend', () => {
      it('should create frontend with minimal configuration', async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: 1 });
        mockAxiosInstance.post.mockResolvedValue({ status: 201 });

        const config: FrontendConfig = {
          name: 'test-frontend'
        };

        await client.createFrontend(config);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/services/haproxy/configuration/frontends?version=1',
          {
            name: 'test-frontend',
            mode: 'http'
          }
        );
      });

      it('should create frontend with full configuration', async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: 1 });
        mockAxiosInstance.post.mockResolvedValue({ status: 201 });

        const config: FrontendConfig = {
          name: 'test-frontend',
          mode: 'tcp',
          default_backend: 'test-backend'
        };

        await client.createFrontend(config);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/services/haproxy/configuration/frontends?version=1',
          {
            name: 'test-frontend',
            mode: 'tcp',
            default_backend: 'test-backend'
          }
        );
      });
    });

    describe('addFrontendBind', () => {
      it('should add bind to frontend successfully', async () => {
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: 1 });
        mockAxiosInstance.post.mockResolvedValue({ status: 201 });

        await client.addFrontendBind('test-frontend', '*', 80);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/services/haproxy/configuration/frontends/test-frontend/binds?version=1',
          {
            name: 'bind_80',
            address: '*',
            port: 80
          }
        );
      });
    });
  });

  describe('statistics', () => {
    beforeEach(async () => {
      // Mock successful initialization
      const mockContainerInfo = {
        Name: '/test-haproxy',
        NetworkSettings: {
          Ports: {
            '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: '5555' }]
          }
        }
      };

      const mockContainer = {
        inspect: vi.fn().mockResolvedValue(mockContainerInfo)
      };

      const mockDocker = {
        getContainer: vi.fn().mockReturnValue(mockContainer)
      };

      mockDockerService.getDockerInstance.mockResolvedValue(mockDocker);
      mockAxiosInstance.get.mockResolvedValue({ status: 200, data: {} });

      await client.initialize('container123');
      vi.clearAllMocks();
    });

    describe('getServerStats', () => {
      it('should return server statistics', async () => {
        const mockStatsResponse = {
          stats: [{
            name: 'server1',
            stats: {
              status: 'UP',
              check_status: 'L7OK',
              check_duration: 1,
              weight: 1,
              scur: 5,
              smax: 10,
              stot: 100,
              bin: 1024,
              bout: 2048,
              dreq: 0,
              econ: 0,
              eresp: 0,
              wretr: 0,
              wredis: 0
            }
          }]
        };

        mockAxiosInstance.get.mockResolvedValue({
          status: 200,
          data: mockStatsResponse
        });

        const result = await client.getServerStats('test-backend', 'server1');

        expect(result).toEqual({
          name: 'server1',
          status: 'UP',
          check_status: 'L7OK',
          check_duration: 1,
          weight: 1,
          current_sessions: 5,
          max_sessions: 10,
          total_sessions: 100,
          bytes_in: 1024,
          bytes_out: 2048,
          denied_requests: 0,
          errors_con: 0,
          errors_resp: 0,
          warnings_retr: 0,
          warnings_redis: 0
        });

        expect(mockAxiosInstance.get).toHaveBeenCalledWith(
          '/services/haproxy/stats/native?type=server&parent=test-backend&name=server1'
        );
      });

      it('should return null when server not found', async () => {
        const apiError = {
          isAxiosError: true,
          response: { status: 404 },
          message: 'Request failed with status code 404'
        };
        mockAxiosInstance.get.mockRejectedValue(apiError);

        const result = await client.getServerStats('test-backend', 'server1');

        expect(result).toBeNull();
      });
    });

    describe('getBackendStats', () => {
      it('should return backend statistics', async () => {
        const mockStatsResponse = {
          stats: [{
            name: 'test-backend',
            stats: {
              status: 'UP',
              scur: 10,
              smax: 20,
              stot: 200,
              bin: 2048,
              bout: 4096,
              dreq: 0,
              econ: 0,
              eresp: 0,
              weight: 1,
              act: 2,
              bck: 0
            }
          }]
        };

        mockAxiosInstance.get.mockResolvedValue({
          status: 200,
          data: mockStatsResponse
        });

        const result = await client.getBackendStats('test-backend');

        expect(result).toEqual({
          name: 'test-backend',
          status: 'UP',
          current_sessions: 10,
          max_sessions: 20,
          total_sessions: 200,
          bytes_in: 2048,
          bytes_out: 4096,
          denied_requests: 0,
          errors_con: 0,
          errors_resp: 0,
          weight: 1,
          act_servers: 2,
          bck_servers: 0
        });

        expect(mockAxiosInstance.get).toHaveBeenCalledWith(
          '/services/haproxy/stats/native?type=backend&name=test-backend'
        );
      });
    });
  });

  describe('transaction management', () => {
    beforeEach(async () => {
      // Mock successful initialization
      const mockContainerInfo = {
        Name: '/test-haproxy',
        NetworkSettings: {
          Ports: {
            '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: '5555' }]
          }
        }
      };

      const mockContainer = {
        inspect: vi.fn().mockResolvedValue(mockContainerInfo)
      };

      const mockDocker = {
        getContainer: vi.fn().mockReturnValue(mockContainer)
      };

      mockDockerService.getDockerInstance.mockResolvedValue(mockDocker);
      mockAxiosInstance.get.mockResolvedValue({ status: 200, data: {} });

      await client.initialize('container123');
      vi.clearAllMocks();
    });

    describe('beginTransaction', () => {
      it('should begin transaction and return transaction ID', async () => {
        // getVersion is called first to get current version
        mockAxiosInstance.get.mockResolvedValue({ status: 200, data: 1 });
        mockAxiosInstance.post.mockResolvedValue({
          status: 201,
          data: { id: 'txn-123' }
        });

        const transactionId = await client.beginTransaction();

        expect(transactionId).toBe('txn-123');
        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/services/haproxy/transactions?version=1',
          { version: 1 }
        );
      });
    });

    describe('commitTransaction', () => {
      it('should commit transaction successfully', async () => {
        mockAxiosInstance.put.mockResolvedValue({ status: 200 });

        await client.commitTransaction('txn-123');

        expect(mockAxiosInstance.put).toHaveBeenCalledWith(
          '/services/haproxy/transactions/txn-123',
          { force_reload: true }
        );
      });
    });

    describe('rollbackTransaction', () => {
      it('should rollback transaction successfully', async () => {
        mockAxiosInstance.delete.mockResolvedValue({ status: 204 });

        await client.rollbackTransaction('txn-123');

        expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
          '/services/haproxy/transactions/txn-123'
        );
      });
    });
  });

  describe('utility methods', () => {
    it('should return connection info after initialization', async () => {
      const mockContainerInfo = {
        Name: '/test-haproxy',
        NetworkSettings: {
          Ports: {
            '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: '5555' }]
          }
        }
      };

      const mockContainer = {
        inspect: vi.fn().mockResolvedValue(mockContainerInfo)
      };

      const mockDocker = {
        getContainer: vi.fn().mockReturnValue(mockContainer)
      };

      mockDockerService.getDockerInstance.mockResolvedValue(mockDocker);
      mockAxiosInstance.get.mockResolvedValue({ status: 200, data: {} });

      await client.initialize('container123');

      const connectionInfo = client.getConnectionInfo();

      expect(connectionInfo).toEqual({
        baseUrl: 'http://192.168.1.100:5555/v3',
        containerName: 'test-haproxy',
        containerId: 'container123'
      });
    });

    it('should return null connection info before initialization', () => {
      const connectionInfo = client.getConnectionInfo();
      expect(connectionInfo).toBeNull();
    });

    it('should return initialization status', async () => {
      expect(client.isInitialized()).toBe(false);

      const mockContainerInfo = {
        Name: '/test-haproxy',
        NetworkSettings: {
          Ports: {
            '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: '5555' }]
          }
        }
      };

      const mockContainer = {
        inspect: vi.fn().mockResolvedValue(mockContainerInfo)
      };

      const mockDocker = {
        getContainer: vi.fn().mockReturnValue(mockContainer)
      };

      mockDockerService.getDockerInstance.mockResolvedValue(mockDocker);
      mockAxiosInstance.get.mockResolvedValue({ status: 200, data: {} });

      await client.initialize('container123');

      expect(client.isInitialized()).toBe(true);
    });
  });
});
