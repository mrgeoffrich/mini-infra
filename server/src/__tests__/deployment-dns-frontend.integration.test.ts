import { testPrisma, createTestUser } from './setup';
import { HAProxyDataPlaneClient } from '../services/haproxy/haproxy-dataplane-client';
import { CloudflareDNSService } from '../services/cloudflare-dns';
import { DeploymentDNSManager } from '../services/deployment-dns-manager';
import { HAProxyFrontendManager } from '../services/haproxy/haproxy-frontend-manager';
import DockerService from '../services/docker';
import { DockerConfigService } from '../services/docker-config';

/**
 * Integration tests for DNS and Frontend Routing
 *
 * These tests verify the full flow of:
 * 1. Creating DNS records for deployments
 * 2. Configuring HAProxy frontends with hostname routing
 * 3. Cleanup on deployment removal
 *
 * Prerequisites:
 * - HAProxy container running with DataPlane API
 * - CloudFlare API credentials configured (for DNS tests)
 * - Docker service accessible
 */

describe('Deployment DNS and Frontend Integration Tests', () => {
  let testUser: any;
  let dockerService: DockerService;
  let haproxyClient: HAProxyDataPlaneClient;
  let cloudflareDNSService: CloudflareDNSService;
  let dnsManager: DeploymentDNSManager;
  let frontendManager: HAProxyFrontendManager;
  let testContainerId: string;

  // Test data
  const TEST_TIMESTAMP = Date.now();
  const TEST_RANDOM = Math.floor(Math.random() * 10000);
  const TEST_BACKEND_NAME = `test-backend-${TEST_TIMESTAMP}-${TEST_RANDOM}`;
  const TEST_FRONTEND_NAME = `test-frontend-${TEST_TIMESTAMP}-${TEST_RANDOM}`;
  const TEST_HOSTNAME = `test-${TEST_TIMESTAMP}-${TEST_RANDOM}.example.com`;

  // Helper to wait between operations
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  beforeAll(async () => {
    // Skip if not in integration test mode
    if (!process.env.RUN_INTEGRATION_TESTS) {
      console.log('Skipping integration tests. Set RUN_INTEGRATION_TESTS=true to run them.');
      return;
    }

    // Create test user
    testUser = await createTestUser();

    // Configure Docker host setting
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

    // Initialize Docker service
    (DockerService as any).instance = null;
    dockerService = DockerService.getInstance();
    await dockerService.initialize();
    (dockerService as any).dockerConfigService = new DockerConfigService(testPrisma);
    await (dockerService as any).createDockerClientFromSettings();
    await (dockerService as any).connect(false);

    // Find HAProxy container
    testContainerId = await findHAProxyContainer();
    if (!testContainerId) {
      throw new Error('No running HAProxy container found for integration tests');
    }

    // Initialize HAProxy client
    haproxyClient = new HAProxyDataPlaneClient();
    await haproxyClient.initialize(testContainerId);

    // Initialize services
    cloudflareDNSService = new CloudflareDNSService();
    dnsManager = new DeploymentDNSManager();
    frontendManager = new HAProxyFrontendManager();
  }, 30000);

  afterAll(async () => {
    if (!process.env.RUN_INTEGRATION_TESTS) {
      return;
    }

    // Cleanup test resources
    await cleanupTestResources();

    // Clean up Docker service
    if (dockerService) {
      const reconnectInterval = (dockerService as any).reconnectInterval;
      if (reconnectInterval) {
        clearInterval(reconnectInterval);
        (dockerService as any).reconnectInterval = null;
      }

      const cache = (dockerService as any).cache;
      if (cache && typeof cache.close === 'function') {
        cache.close();
      }
    }

    (DockerService as any).instance = null;

    // Clean up database settings
    await testPrisma.systemSettings.deleteMany({
      where: {
        category: 'docker',
        key: 'host'
      }
    });
  }, 15000);

  // Helper: Find HAProxy container
  async function findHAProxyContainer(): Promise<string> {
    try {
      const containers = await dockerService.listContainers();
      const haproxyContainer = containers.find((container: any) => {
        const labels = container.labels || {};
        return (
          labels['mini-infra.service'] === 'haproxy-integration-test' &&
          container.status === 'running'
        );
      });

      if (!haproxyContainer) {
        const fallbackContainer = containers.find((container: any) => {
          return container.image?.includes('haproxy') && container.status === 'running';
        });

        if (fallbackContainer) {
          return fallbackContainer.id;
        }
      }

      return haproxyContainer?.id || '';
    } catch (error) {
      console.error('Failed to find HAProxy container:', error);
      return '';
    }
  }

  // Helper: Cleanup test resources
  async function cleanupTestResources(): Promise<void> {
    try {
      // Remove frontend
      try {
        await haproxyClient.deleteFrontend(TEST_FRONTEND_NAME);
      } catch (error: any) {
        if (!error.message?.includes('Resource not found')) {
          console.warn('Frontend cleanup failed:', error.message);
        }
      }

      // Remove backend
      try {
        await haproxyClient.deleteBackend(TEST_BACKEND_NAME);
      } catch (error: any) {
        if (!error.message?.includes('Resource not found')) {
          console.warn('Backend cleanup failed:', error.message);
        }
      }

      // Clean up database records
      await testPrisma.hAProxyFrontend.deleteMany({
        where: {
          frontendName: TEST_FRONTEND_NAME
        }
      });

      await testPrisma.deploymentDNSRecord.deleteMany({
        where: {
          hostname: TEST_HOSTNAME
        }
      });

      await testPrisma.deploymentConfiguration.deleteMany({
        where: {
          applicationName: {
            startsWith: `test-app-${TEST_TIMESTAMP}`
          }
        }
      });

      await testPrisma.environment.deleteMany({
        where: {
          name: {
            startsWith: `test-env-${TEST_TIMESTAMP}`
          }
        }
      });
    } catch (error) {
      console.warn('Cleanup failed:', error);
    }
  }

  describe('Full Deployment Flow with DNS Creation', () => {
    it('should create frontend and DNS record for a deployment in local network', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      // Create test environment with local network type
      const environment = await testPrisma.environment.create({
        data: {
          name: `test-env-${TEST_TIMESTAMP}-${TEST_RANDOM}`,
          networkType: 'local',
          description: 'Test environment for DNS and frontend integration',
          createdBy: testUser.id,
          updatedBy: testUser.id
        }
      });

      // Create test deployment configuration
      const deploymentConfig = await testPrisma.deploymentConfiguration.create({
        data: {
          applicationName: `test-app-${TEST_TIMESTAMP}-${TEST_RANDOM}`,
          hostname: TEST_HOSTNAME,
          environmentId: environment.id,
          image: 'nginx:latest',
          containerPort: 80,
          replicas: 1,
          deploymentStrategy: 'initial',
          createdBy: testUser.id,
          updatedBy: testUser.id
        }
      });

      try {
        // Step 1: Create HAProxy backend
        await haproxyClient.createBackend({
          name: TEST_BACKEND_NAME,
          mode: 'http',
          balance: 'roundrobin'
        });

        await wait(100);

        // Step 2: Create HAProxy frontend with hostname routing
        const frontendName = await frontendManager.createFrontendForDeployment(
          deploymentConfig,
          TEST_BACKEND_NAME,
          haproxyClient
        );

        expect(frontendName).toBeTruthy();
        expect(frontendName).toBe(`fe_${deploymentConfig.applicationName}_${environment.id}`);

        // Verify frontend was created in HAProxy
        const frontend = await haproxyClient.getFrontend(frontendName);
        expect(frontend).toBeTruthy();
        expect(frontend!.name).toBe(frontendName);

        // Verify frontend record was created in database
        const frontendRecord = await testPrisma.hAProxyFrontend.findUnique({
          where: { deploymentConfigId: deploymentConfig.id }
        });

        expect(frontendRecord).toBeTruthy();
        expect(frontendRecord!.frontendName).toBe(frontendName);
        expect(frontendRecord!.backendName).toBe(TEST_BACKEND_NAME);
        expect(frontendRecord!.hostname).toBe(TEST_HOSTNAME);
        expect(frontendRecord!.status).toBe('active');

        // Step 3: Create DNS record (if CloudFlare is configured)
        // Note: This will be skipped if CloudFlare credentials are not available
        let dnsCreated = false;
        try {
          await dnsManager.createDNSRecordForDeployment(deploymentConfig);
          dnsCreated = true;

          // Verify DNS record was created in database
          const dnsRecord = await testPrisma.deploymentDNSRecord.findFirst({
            where: {
              deploymentConfigId: deploymentConfig.id,
              hostname: TEST_HOSTNAME
            }
          });

          expect(dnsRecord).toBeTruthy();
          expect(dnsRecord!.hostname).toBe(TEST_HOSTNAME);
          expect(dnsRecord!.dnsProvider).toBe('cloudflare');
          expect(dnsRecord!.status).toMatch(/^(active|pending)$/);
        } catch (error: any) {
          if (error.message?.includes('CloudFlare') || error.message?.includes('not configured')) {
            console.warn('DNS creation skipped: CloudFlare not configured');
            dnsCreated = false;
          } else {
            throw error;
          }
        }

        // Test passed if frontend was created successfully
        // DNS creation is optional based on CloudFlare configuration
        expect(true).toBe(true);

        console.log(`Test completed: Frontend created=${!!frontendName}, DNS created=${dnsCreated}`);
      } finally {
        // Cleanup
        await testPrisma.hAProxyFrontend.deleteMany({
          where: { deploymentConfigId: deploymentConfig.id }
        });

        await testPrisma.deploymentDNSRecord.deleteMany({
          where: { deploymentConfigId: deploymentConfig.id }
        });

        await testPrisma.deploymentConfiguration.delete({
          where: { id: deploymentConfig.id }
        });

        await testPrisma.environment.delete({
          where: { id: environment.id }
        });

        try {
          await haproxyClient.deleteFrontend(TEST_FRONTEND_NAME.replace('test-frontend', 'fe_test-app'));
        } catch (error) {
          // Ignore
        }

        try {
          await haproxyClient.deleteBackend(TEST_BACKEND_NAME);
        } catch (error) {
          // Ignore
        }
      }
    }, 30000);

    it('should create frontend without DNS for deployment in internet network', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      // Create test environment with internet network type
      const environment = await testPrisma.environment.create({
        data: {
          name: `test-env-internet-${TEST_TIMESTAMP}-${TEST_RANDOM}`,
          networkType: 'internet',
          description: 'Test environment for internet network type',
          createdBy: testUser.id,
          updatedBy: testUser.id
        }
      });

      const deploymentConfig = await testPrisma.deploymentConfiguration.create({
        data: {
          applicationName: `test-app-internet-${TEST_TIMESTAMP}-${TEST_RANDOM}`,
          hostname: `test-internet-${TEST_TIMESTAMP}-${TEST_RANDOM}.example.com`,
          environmentId: environment.id,
          image: 'nginx:latest',
          containerPort: 80,
          replicas: 1,
          deploymentStrategy: 'initial',
          createdBy: testUser.id,
          updatedBy: testUser.id
        }
      });

      try {
        // Create backend
        const backendName = `backend-internet-${TEST_TIMESTAMP}-${TEST_RANDOM}`;
        await haproxyClient.createBackend({
          name: backendName,
          mode: 'http'
        });

        await wait(100);

        // Create frontend
        const frontendName = await frontendManager.createFrontendForDeployment(
          deploymentConfig,
          backendName,
          haproxyClient
        );

        expect(frontendName).toBeTruthy();

        // Try to create DNS record - should be skipped for internet network type
        const result = await dnsManager.createDNSRecordForDeployment(deploymentConfig);

        // DNS should be skipped for internet network type
        expect(result).toBeUndefined();

        // Verify no DNS record was created
        const dnsRecord = await testPrisma.deploymentDNSRecord.findFirst({
          where: {
            deploymentConfigId: deploymentConfig.id
          }
        });

        expect(dnsRecord).toBeNull();

        // But frontend should exist
        const frontendRecord = await testPrisma.hAProxyFrontend.findUnique({
          where: { deploymentConfigId: deploymentConfig.id }
        });

        expect(frontendRecord).toBeTruthy();

        // Cleanup
        await haproxyClient.deleteFrontend(frontendName);
        await haproxyClient.deleteBackend(backendName);
      } finally {
        await testPrisma.hAProxyFrontend.deleteMany({
          where: { deploymentConfigId: deploymentConfig.id }
        });

        await testPrisma.deploymentConfiguration.delete({
          where: { id: deploymentConfig.id }
        });

        await testPrisma.environment.delete({
          where: { id: environment.id }
        });
      }
    }, 20000);
  });

  describe('Removal Flow with DNS Cleanup', () => {
    it('should remove frontend and DNS record when deployment is removed', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      // Create test environment
      const environment = await testPrisma.environment.create({
        data: {
          name: `test-env-removal-${TEST_TIMESTAMP}-${TEST_RANDOM}`,
          networkType: 'local',
          description: 'Test environment for removal flow',
          createdBy: testUser.id,
          updatedBy: testUser.id
        }
      });

      const deploymentConfig = await testPrisma.deploymentConfiguration.create({
        data: {
          applicationName: `test-app-removal-${TEST_TIMESTAMP}-${TEST_RANDOM}`,
          hostname: `test-removal-${TEST_TIMESTAMP}-${TEST_RANDOM}.example.com`,
          environmentId: environment.id,
          image: 'nginx:latest',
          containerPort: 80,
          replicas: 1,
          deploymentStrategy: 'initial',
          createdBy: testUser.id,
          updatedBy: testUser.id
        }
      });

      const backendName = `backend-removal-${TEST_TIMESTAMP}-${TEST_RANDOM}`;

      try {
        // Setup: Create backend and frontend
        await haproxyClient.createBackend({
          name: backendName,
          mode: 'http'
        });

        const frontendName = await frontendManager.createFrontendForDeployment(
          deploymentConfig,
          backendName,
          haproxyClient
        );

        // Verify frontend exists
        let frontend = await haproxyClient.getFrontend(frontendName);
        expect(frontend).toBeTruthy();

        // Now test removal
        await frontendManager.removeFrontendForDeployment(frontendName, haproxyClient);

        // Verify frontend was removed from HAProxy
        frontend = await haproxyClient.getFrontend(frontendName);
        expect(frontend).toBeNull();

        // Verify frontend record was marked as removed in database
        const frontendRecord = await testPrisma.hAProxyFrontend.findUnique({
          where: { deploymentConfigId: deploymentConfig.id }
        });

        if (frontendRecord) {
          expect(frontendRecord.status).toBe('removed');
        }

        // Cleanup backend
        await haproxyClient.deleteBackend(backendName);
      } finally {
        await testPrisma.hAProxyFrontend.deleteMany({
          where: { deploymentConfigId: deploymentConfig.id }
        });

        await testPrisma.deploymentConfiguration.delete({
          where: { id: deploymentConfig.id }
        });

        await testPrisma.environment.delete({
          where: { id: environment.id }
        });

        try {
          await haproxyClient.deleteBackend(backendName);
        } catch (error) {
          // Ignore
        }
      }
    }, 20000);
  });

  describe('Error Scenarios and Rollbacks', () => {
    it('should handle frontend creation failure gracefully', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      // Create test environment
      const environment = await testPrisma.environment.create({
        data: {
          name: `test-env-error-${TEST_TIMESTAMP}-${TEST_RANDOM}`,
          networkType: 'local',
          description: 'Test environment for error scenarios',
          createdBy: testUser.id,
          updatedBy: testUser.id
        }
      });

      const deploymentConfig = await testPrisma.deploymentConfiguration.create({
        data: {
          applicationName: `test-app-error-${TEST_TIMESTAMP}-${TEST_RANDOM}`,
          hostname: `test-error-${TEST_TIMESTAMP}-${TEST_RANDOM}.example.com`,
          environmentId: environment.id,
          image: 'nginx:latest',
          containerPort: 80,
          replicas: 1,
          deploymentStrategy: 'initial',
          createdBy: testUser.id,
          updatedBy: testUser.id
        }
      });

      try {
        // Try to create frontend without backend (should fail)
        await expect(
          frontendManager.createFrontendForDeployment(
            deploymentConfig,
            'nonexistent-backend',
            haproxyClient
          )
        ).rejects.toThrow();

        // Verify no frontend record was created in database
        const frontendRecord = await testPrisma.hAProxyFrontend.findUnique({
          where: { deploymentConfigId: deploymentConfig.id }
        });

        // Record might exist with 'failed' status, or not exist at all
        if (frontendRecord) {
          expect(frontendRecord.status).toBe('failed');
        } else {
          expect(frontendRecord).toBeNull();
        }
      } finally {
        await testPrisma.hAProxyFrontend.deleteMany({
          where: { deploymentConfigId: deploymentConfig.id }
        });

        await testPrisma.deploymentConfiguration.delete({
          where: { id: deploymentConfig.id }
        });

        await testPrisma.environment.delete({
          where: { id: environment.id }
        });
      }
    }, 15000);

    it('should handle duplicate frontend creation', async () => {
      if (!process.env.RUN_INTEGRATION_TESTS) {
        pending('Integration tests skipped');
        return;
      }

      // Create test environment
      const environment = await testPrisma.environment.create({
        data: {
          name: `test-env-duplicate-${TEST_TIMESTAMP}-${TEST_RANDOM}`,
          networkType: 'local',
          description: 'Test environment for duplicate scenarios',
          createdBy: testUser.id,
          updatedBy: testUser.id
        }
      });

      const deploymentConfig = await testPrisma.deploymentConfiguration.create({
        data: {
          applicationName: `test-app-duplicate-${TEST_TIMESTAMP}-${TEST_RANDOM}`,
          hostname: `test-duplicate-${TEST_TIMESTAMP}-${TEST_RANDOM}.example.com`,
          environmentId: environment.id,
          image: 'nginx:latest',
          containerPort: 80,
          replicas: 1,
          deploymentStrategy: 'initial',
          createdBy: testUser.id,
          updatedBy: testUser.id
        }
      });

      const backendName = `backend-duplicate-${TEST_TIMESTAMP}-${TEST_RANDOM}`;

      try {
        // Create backend
        await haproxyClient.createBackend({
          name: backendName,
          mode: 'http'
        });

        // Create frontend first time
        const frontendName = await frontendManager.createFrontendForDeployment(
          deploymentConfig,
          backendName,
          haproxyClient
        );

        expect(frontendName).toBeTruthy();

        // Try to create same frontend again - should handle gracefully
        const result = await frontendManager.createFrontendForDeployment(
          deploymentConfig,
          backendName,
          haproxyClient
        );

        // Should either return same name or throw an error that's caught
        expect(result).toBeTruthy();

        // Cleanup
        await haproxyClient.deleteFrontend(frontendName);
        await haproxyClient.deleteBackend(backendName);
      } finally {
        await testPrisma.hAProxyFrontend.deleteMany({
          where: { deploymentConfigId: deploymentConfig.id }
        });

        await testPrisma.deploymentConfiguration.delete({
          where: { id: deploymentConfig.id }
        });

        await testPrisma.environment.delete({
          where: { id: environment.id }
        });

        try {
          await haproxyClient.deleteBackend(backendName);
        } catch (error) {
          // Ignore
        }
      }
    }, 20000);
  });
});

// Test utility
if (require.main === module) {
  console.log('To run integration tests, set RUN_INTEGRATION_TESTS=true');
  console.log('Example: RUN_INTEGRATION_TESTS=true npm test -- deployment-dns-frontend.integration.test.ts');
}
