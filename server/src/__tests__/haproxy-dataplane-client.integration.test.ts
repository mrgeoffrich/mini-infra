import {
  HAProxyDataPlaneClient,
  BackendConfig,
  ServerConfig,
  TransactionManager,
  RetryableHAProxyClient
} from '../services/haproxy/haproxy-dataplane-client';
import DockerService from '../services/docker';
import { testPrisma, createTestUser } from './setup';
import { DockerConfigService } from '../services/docker-config';

// Integration tests for HAProxy DataPlane Client
// These tests require a running HAProxy container with DataPlane API enabled

describe('HAProxyDataPlaneClient Integration Tests', () => {
  let client: HAProxyDataPlaneClient;
  let testContainerId: string;
  let dockerService: DockerService;

  // Test configuration
  const TEST_BACKEND_NAME = 'test-integration-backend';
  const TEST_SERVER_NAME = 'test-integration-server';
  const TEST_FRONTEND_NAME = 'test-integration-frontend';

  beforeAll(async () => {
    // Skip integration tests if not in integration test environment
    if (!process.env.RUN_INTEGRATION_TESTS) {
      console.log('Skipping integration tests. Set RUN_INTEGRATION_TESTS=true to run them.');
      return;
    }

    // Set up Docker configuration for test environment
    const testUser = await createTestUser();

    // Configure Docker host setting in test database
    await testPrisma.systemSettings.upsert({
      where: {
        category_key: {
          category: 'docker',
          key: 'host'
        }
      },
      create: {
        category: 'docker',
        key: 'host',
        value: 'unix:///var/run/docker.sock',
        isEncrypted: false,
        isActive: true,
        createdBy: testUser.id,
        updatedBy: testUser.id
      },
      update: {
        value: 'unix:///var/run/docker.sock',
        isActive: true,
        updatedBy: testUser.id
      }
    });

    // Verify the configuration was saved correctly
    const savedConfig = await testPrisma.systemSettings.findUnique({
      where: {
        category_key: {
          category: 'docker',
          key: 'host'
        }
      }
    });
    console.log('Saved Docker configuration:', savedConfig);

    // Reset Docker service singleton for test
    (DockerService as any).instance = null;
    dockerService = DockerService.getInstance();

    console.log('Initializing Docker service...');
    try {
      await dockerService.initialize();
      console.log('Docker service initialized successfully');
    } catch (error) {
      console.error('Docker service initialization failed:', error);
      throw error;
    }

    // Override the Docker config service to use test database AFTER initialization
    console.log('Overriding Docker config service with test database...');
    (dockerService as any).dockerConfigService = new DockerConfigService(testPrisma);

    // Now try to create the Docker client with correct config
    console.log('Attempting to create Docker client with test config...');
    try {
      await (dockerService as any).createDockerClientFromSettings();
      await (dockerService as any).connect(false);
      console.log('Docker client creation and connection succeeded');
    } catch (clientError) {
      console.error('Docker client creation failed:', clientError);
      throw clientError;
    }

    // Check if Docker service is connected
    console.log('Checking Docker connection status...');
    try {
      // Try to access the Docker service directly to see if it's connected
      const isConnected = (dockerService as any).connected;
      console.log('Docker service connected status:', isConnected);

      if (!isConnected) {
        console.log('Docker service not connected, attempting manual connection...');
        // Let's try to force a connection
        await (dockerService as any).connect(false);
        console.log('Manual connection attempt completed');
      }
    } catch (error) {
      console.error('Error checking/establishing Docker connection:', error);
    }

    // Find running HAProxy container for testing
    console.log('Looking for HAProxy container...');
    testContainerId = await findHAProxyContainer();
    console.log('HAProxy container ID:', testContainerId);

    if (!testContainerId) {
      throw new Error('No running HAProxy container found for integration tests');
    }

    client = new HAProxyDataPlaneClient();
    await client.initialize(testContainerId);
  }, 30000);

  afterAll(async () => {
    if (!process.env.RUN_INTEGRATION_TESTS) {
      return;
    }

    // Cleanup test resources
    try {
      if (client && client.isInitialized()) {
        await cleanupTestResources();
      }

      // Clean up Docker configuration from test database
      await testPrisma.systemSettings.deleteMany({
        where: {
          category: 'docker',
          key: 'host'
        }
      });
    } catch (error) {
      console.warn('Cleanup failed:', error);
    }
  }, 15000);

  // Helper function to find HAProxy container
  async function findHAProxyContainer(): Promise<string> {
    try {
      console.log('Attempting to list containers...');
      const containers = await dockerService.listContainers();
      console.log('Successfully listed containers, count:', containers.length);

      const haproxyContainer = containers.find((container: any) => {
        const labels = container.labels || {};
        return (
          labels['mini-infra.service'] === 'haproxy' &&
          container.status === 'running'
        );
      });

      if (!haproxyContainer) {
        // Try to find container by image name as fallback
        const fallbackContainer = containers.find((container: any) => {
          return container.image?.includes('haproxy') && container.status === 'running';
        });

        if (fallbackContainer) {
          console.warn('Found HAProxy container by image name, consider adding proper labels');
          return fallbackContainer.id;
        }
      }

      return haproxyContainer?.id || '';
    } catch (error) {
      console.error('Failed to find HAProxy container:', error);
      return '';
    }
  }

  // Helper function to cleanup test resources
  async function cleanupTestResources(): Promise<void> {
    try {
      // Remove test server
      await client.deleteServer(TEST_BACKEND_NAME, TEST_SERVER_NAME).catch(() => { });

      // Remove test backend
      await client.deleteBackend(TEST_BACKEND_NAME).catch(() => { });

      console.log('Test resources cleaned up successfully');
    } catch (error) {
      console.error('Failed to cleanup test resources:', error);
    }
  }

  describe('initialization', () => {
    it('should initialize client successfully', () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      expect(client.isInitialized()).toBe(true);
      expect(client.getConnectionInfo()).toBeTruthy();
      expect(client.getConnectionInfo()?.containerId).toBe(testContainerId);
    });

    it('should have valid connection info', () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const connectionInfo = client.getConnectionInfo();

      expect(connectionInfo).toBeTruthy();
      expect(connectionInfo!.baseUrl).toMatch(/^https?:\/\/.+:\d+\/v3$/);
      expect(connectionInfo!.containerName).toBeTruthy();
      expect(connectionInfo!.containerId).toBe(testContainerId);
    });
  });

  describe('backend operations', () => {
    beforeEach(async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        return;
      }

      // Cleanup any existing test backend
      try {
        await client.deleteBackend(TEST_BACKEND_NAME);
      } catch (error) {
        // Ignore if backend doesn't exist
      }
    });

    it('should create, retrieve, and delete backend', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const backendConfig: BackendConfig = {
        name: TEST_BACKEND_NAME,
        mode: 'http',
        balance: 'roundrobin',
        check_timeout: 5000,
        connect_timeout: 3000
      };

      // Create backend
      await client.createBackend(backendConfig);

      // Verify backend exists
      const retrievedBackend = await client.getBackend(TEST_BACKEND_NAME);
      expect(retrievedBackend).toBeTruthy();
      expect(retrievedBackend!.name).toBe(TEST_BACKEND_NAME);
      expect(retrievedBackend!.mode).toBe('http');

      // List backends should include our test backend
      const backends = await client.listBackends();
      const testBackend = backends.find(b => b.name === TEST_BACKEND_NAME);
      expect(testBackend).toBeTruthy();

      // Delete backend
      await client.deleteBackend(TEST_BACKEND_NAME);

      // Verify backend is deleted
      const deletedBackend = await client.getBackend(TEST_BACKEND_NAME);
      expect(deletedBackend).toBeNull();
    }, 15000);

    it('should handle duplicate backend creation gracefully', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const backendConfig: BackendConfig = {
        name: TEST_BACKEND_NAME,
        mode: 'http'
      };

      // Create backend first time
      await client.createBackend(backendConfig);

      // Try to create same backend again - should throw error
      await expect(client.createBackend(backendConfig)).rejects.toThrow();

      // Cleanup
      await client.deleteBackend(TEST_BACKEND_NAME);
    }, 10000);
  });

  describe('server operations', () => {
    beforeEach(async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        return;
      }

      // Cleanup and create fresh backend for server tests
      try {
        await client.deleteBackend(TEST_BACKEND_NAME);
      } catch (error) {
        // Ignore if backend doesn't exist
      }

      const backendConfig: BackendConfig = {
        name: TEST_BACKEND_NAME,
        mode: 'http'
      };

      await client.createBackend(backendConfig);
    });

    afterEach(async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        return;
      }

      // Cleanup backend after each test
      try {
        await client.deleteBackend(TEST_BACKEND_NAME);
      } catch (error) {
        // Ignore cleanup errors
      }
    });

    it('should add, manage, and remove server', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const serverConfig: ServerConfig = {
        name: TEST_SERVER_NAME,
        address: '127.0.0.1',
        port: 8080,
        check: 'enabled',
        check_path: '/health',
        inter: 5000,
        rise: 2,
        fall: 3,
        weight: 100,
        enabled: false // Start disabled
      };

      // Add server
      await client.addServer(TEST_BACKEND_NAME, serverConfig);

      // Enable server
      await client.enableServer(TEST_BACKEND_NAME, TEST_SERVER_NAME);

      // Check server stats (should exist even if server is down)
      const stats = await client.getServerStats(TEST_BACKEND_NAME, TEST_SERVER_NAME);
      expect(stats).toBeTruthy();
      expect(stats!.name).toBe(TEST_SERVER_NAME);

      // Set server to maintenance mode
      await client.setServerState(TEST_BACKEND_NAME, TEST_SERVER_NAME, 'maint');

      // Disable server
      await client.disableServer(TEST_BACKEND_NAME, TEST_SERVER_NAME);

      // Delete server
      await client.deleteServer(TEST_BACKEND_NAME, TEST_SERVER_NAME);

      // Verify server is deleted (stats should return null)
      const deletedStats = await client.getServerStats(TEST_BACKEND_NAME, TEST_SERVER_NAME);
      expect(deletedStats).toBeNull();
    }, 15000);

    it('should handle server state transitions', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const serverConfig: ServerConfig = {
        name: TEST_SERVER_NAME,
        address: '127.0.0.1',
        port: 8080,
        enabled: false
      };

      await client.addServer(TEST_BACKEND_NAME, serverConfig);

      // Test different server states
      await client.setServerState(TEST_BACKEND_NAME, TEST_SERVER_NAME, 'ready');
      await client.setServerState(TEST_BACKEND_NAME, TEST_SERVER_NAME, 'maint');
      await client.setServerState(TEST_BACKEND_NAME, TEST_SERVER_NAME, 'drain');
      await client.setServerState(TEST_BACKEND_NAME, TEST_SERVER_NAME, 'ready');

      // Each state change should succeed without throwing
      expect(true).toBe(true); // If we reach here, all state changes succeeded
    }, 10000);
  });

  describe('frontend operations', () => {
    afterEach(async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        return;
      }

      // Note: Frontend deletion might not be supported in all HAProxy versions
      // We'll rely on HAProxy restart for cleanup in real scenarios
    });

    it('should create frontend and add bind', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      // Create a backend first (required for frontend)
      const backendConfig: BackendConfig = {
        name: TEST_BACKEND_NAME,
        mode: 'http'
      };
      await client.createBackend(backendConfig);

      // Create frontend
      await client.createFrontend({
        name: TEST_FRONTEND_NAME,
        mode: 'http',
        default_backend: TEST_BACKEND_NAME
      });

      // Add bind to frontend (use high port to avoid conflicts)
      await client.addFrontendBind(TEST_FRONTEND_NAME, '*', 9999);

      // If we reach here without throwing, the operations succeeded
      expect(true).toBe(true);

      // Cleanup
      await client.deleteBackend(TEST_BACKEND_NAME);
    }, 10000);
  });

  describe('statistics operations', () => {
    beforeEach(async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        return;
      }

      // Create backend and server for stats testing
      try {
        await client.deleteBackend(TEST_BACKEND_NAME);
      } catch (error) {
        // Ignore if backend doesn't exist
      }

      const backendConfig: BackendConfig = {
        name: TEST_BACKEND_NAME,
        mode: 'http'
      };
      await client.createBackend(backendConfig);

      const serverConfig: ServerConfig = {
        name: TEST_SERVER_NAME,
        address: '127.0.0.1',
        port: 8080,
        enabled: true
      };
      await client.addServer(TEST_BACKEND_NAME, serverConfig);
    });

    afterEach(async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        return;
      }

      try {
        await client.deleteBackend(TEST_BACKEND_NAME);
      } catch (error) {
        // Ignore cleanup errors
      }
    });

    it('should retrieve server statistics', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const stats = await client.getServerStats(TEST_BACKEND_NAME, TEST_SERVER_NAME);

      expect(stats).toBeTruthy();
      expect(stats!.name).toBe(TEST_SERVER_NAME);
      expect(typeof stats!.current_sessions).toBe('number');
      expect(typeof stats!.total_sessions).toBe('number');
      expect(typeof stats!.bytes_in).toBe('number');
      expect(typeof stats!.bytes_out).toBe('number');
      expect(['UP', 'DOWN', 'MAINT', 'DRAIN']).toContain(stats!.status);
    }, 10000);

    it('should retrieve backend statistics', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const stats = await client.getBackendStats(TEST_BACKEND_NAME);

      expect(stats).toBeTruthy();
      expect(stats!.name).toBe(TEST_BACKEND_NAME);
      expect(typeof stats!.current_sessions).toBe('number');
      expect(typeof stats!.total_sessions).toBe('number');
      expect(typeof stats!.bytes_in).toBe('number');
      expect(typeof stats!.bytes_out).toBe('number');
      expect(typeof stats!.act_servers).toBe('number');
      expect(typeof stats!.bck_servers).toBe('number');
    }, 10000);

    it('should return null for non-existent server stats', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const stats = await client.getServerStats(TEST_BACKEND_NAME, 'nonexistent-server');
      expect(stats).toBeNull();
    }, 5000);

    it('should return null for non-existent backend stats', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const stats = await client.getBackendStats('nonexistent-backend');
      expect(stats).toBeNull();
    }, 5000);
  });

  describe('transaction management', () => {
    it('should create, commit, and rollback transactions', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      // Test transaction commit
      const transactionId1 = await client.beginTransaction();
      expect(transactionId1).toBeTruthy();
      expect(typeof transactionId1).toBe('string');

      await client.commitTransaction(transactionId1);

      // Test transaction rollback
      const transactionId2 = await client.beginTransaction();
      expect(transactionId2).toBeTruthy();
      expect(transactionId2).not.toBe(transactionId1); // Should be different

      await client.rollbackTransaction(transactionId2);
    }, 10000);

    it('should handle multiple concurrent transactions', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      // Create multiple transactions
      const [txn1, txn2, txn3] = await Promise.all([
        client.beginTransaction(),
        client.beginTransaction(),
        client.beginTransaction()
      ]);

      expect(txn1).toBeTruthy();
      expect(txn2).toBeTruthy();
      expect(txn3).toBeTruthy();

      // All should be unique
      expect(new Set([txn1, txn2, txn3]).size).toBe(3);

      // Clean up transactions
      await Promise.all([
        client.rollbackTransaction(txn1),
        client.rollbackTransaction(txn2),
        client.rollbackTransaction(txn3)
      ]);
    }, 10000);
  });

  describe('error handling', () => {
    it('should handle network timeouts gracefully', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      // Create a client with very short timeout for testing
      const timeoutClient = new HAProxyDataPlaneClient();
      await timeoutClient.initialize(testContainerId);

      // Override axios timeout to very short value
      (timeoutClient as any).axiosInstance.defaults.timeout = 1; // 1ms - should timeout

      await expect(timeoutClient.listBackends()).rejects.toThrow();
    }, 10000);

    it('should handle invalid operations gracefully', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      // Try to delete non-existent backend
      await expect(client.deleteBackend('definitely-does-not-exist')).rejects.toThrow();

      // Try to add server to non-existent backend
      const serverConfig: ServerConfig = {
        name: 'test-server',
        address: '127.0.0.1',
        port: 8080
      };

      await expect(client.addServer('nonexistent-backend', serverConfig)).rejects.toThrow();
    }, 10000);
  });

  describe('version management', () => {
    it('should get configuration version', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const version = await client.getVersion();
      expect(typeof version).toBe('number');
      expect(version).toBeGreaterThan(0);
    }, 5000);

    it('should include version in configuration operations', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const backendConfig: BackendConfig = {
        name: 'version-test-backend',
        mode: 'http'
      };

      try {
        // Version should be automatically included in create operation
        await client.createBackend(backendConfig);

        // Verify backend was created
        const backend = await client.getBackend('version-test-backend');
        expect(backend).toBeTruthy();
        expect(backend!.name).toBe('version-test-backend');
      } finally {
        // Cleanup
        try {
          await client.deleteBackend('version-test-backend');
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    }, 10000);
  });

  describe('transaction manager', () => {
    it('should execute atomic operations', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const tm = new TransactionManager(client);
      const backendName = 'transaction-test-backend';
      const serverName = 'transaction-test-server';

      try {
        await tm.executeInTransaction(async () => {
          // All operations here should be atomic
          await client.createBackend({
            name: backendName,
            mode: 'http',
            balance: 'roundrobin'
          });

          await client.addServer(backendName, {
            name: serverName,
            address: '127.0.0.1',
            port: 8080,
            check: 'enabled'
          });

          return 'success';
        });

        // Verify both backend and server were created
        const backend = await client.getBackend(backendName);
        expect(backend).toBeTruthy();

        const stats = await client.getServerStats(backendName, serverName);
        expect(stats).toBeTruthy();
      } finally {
        // Cleanup
        try {
          await client.deleteServer(backendName, serverName);
          await client.deleteBackend(backendName);
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    }, 15000);

    it('should rollback on transaction failure', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const tm = new TransactionManager(client);
      const backendName = 'rollback-test-backend';

      try {
        await expect(tm.executeInTransaction(async () => {
          // Create backend
          await client.createBackend({
            name: backendName,
            mode: 'http'
          });

          // Force an error to trigger rollback
          throw new Error('Simulated failure');
        })).rejects.toThrow('Simulated failure');

        // Backend should not exist due to rollback
        const backend = await client.getBackend(backendName);
        expect(backend).toBeNull();
      } finally {
        // Cleanup just in case
        try {
          await client.deleteBackend(backendName);
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    }, 15000);
  });

  describe('retryable client', () => {
    it('should handle basic operations with retry logic', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const retryableClient = new RetryableHAProxyClient();
      await retryableClient.initialize(testContainerId);

      const backendName = 'retry-test-backend';

      try {
        // This should work normally (no retries needed)
        await retryableClient.createBackend({
          name: backendName,
          mode: 'http'
        });

        // Verify backend was created
        const backend = await retryableClient.getBackend(backendName);
        expect(backend).toBeTruthy();
        expect(backend!.name).toBe(backendName);
      } finally {
        // Cleanup
        try {
          await retryableClient.deleteBackend(backendName);
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    }, 10000);
  });

  describe('error handling improvements', () => {
    it('should provide specific error messages for different status codes', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      // Test 404 error
      await expect(client.getBackend('definitely-does-not-exist-404')).resolves.toBeNull();

      // Test duplicate creation (should give specific error)
      const backendName = 'duplicate-test-backend';

      try {
        await client.createBackend({
          name: backendName,
          mode: 'http'
        });

        // Try to create same backend again
        await expect(client.createBackend({
          name: backendName,
          mode: 'http'
        })).rejects.toThrow();
      } finally {
        // Cleanup
        try {
          await client.deleteBackend(backendName);
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    }, 10000);
  });

  describe('real-world scenarios', () => {
    it('should handle complete deployment scenario', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      const backendName = 'app-backend';
      const serverName = 'app-server-1';

      try {
        // 1. Create backend for application
        await client.createBackend({
          name: backendName,
          mode: 'http',
          balance: 'roundrobin'
        });

        // 2. Add server in maintenance mode
        await client.addServer(backendName, {
          name: serverName,
          address: '127.0.0.1',
          port: 3000,
          check: 'enabled',
          check_path: '/health',
          inter: 2000,
          rise: 2,
          fall: 3,
          enabled: false
        });

        // 3. Enable server (simulating successful health checks)
        await client.enableServer(backendName, serverName);

        // 4. Verify server is active
        const stats = await client.getServerStats(backendName, serverName);
        expect(stats).toBeTruthy();

        // 5. Put server in drain mode (simulating graceful shutdown)
        await client.setServerState(backendName, serverName, 'drain');

        // 6. Remove server and backend (cleanup)
        await client.deleteServer(backendName, serverName);
        await client.deleteBackend(backendName);

        // If we reach here, the complete scenario succeeded
        expect(true).toBe(true);
      } catch (error) {
        // Ensure cleanup even if test fails
        try {
          await client.deleteServer(backendName, serverName);
          await client.deleteBackend(backendName);
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
        throw error;
      }
    }, 20000);
  });
});

// Test utility to run integration tests
if (require.main === module) {
  console.log('To run integration tests, set RUN_INTEGRATION_TESTS=true and ensure HAProxy is running');
  console.log('Example: RUN_INTEGRATION_TESTS=true npm test -- haproxy-dataplane-client.integration.test.ts');
}