import { ApplicationServiceFactory } from '../services/application-service-factory';
import { ServiceRegistry } from '../services/service-registry';
import { HAProxyService } from '../services/haproxy/haproxy-service';
import { IApplicationService, ServiceStatus } from '../services/interfaces/application-service';

// Mock HAProxyService to avoid Docker dependencies in tests
jest.mock('../services/haproxy/haproxy-service');
const MockHAProxyService = HAProxyService as jest.MockedClass<typeof HAProxyService>;

// Mock ServiceRegistry to control its behavior in tests
jest.mock('../services/service-registry');
const MockServiceRegistry = ServiceRegistry as jest.MockedClass<typeof ServiceRegistry>;

describe('ApplicationServiceFactory', () => {
  let serviceFactory: ApplicationServiceFactory;
  let mockServiceRegistry: jest.Mocked<ServiceRegistry>;
  let mockService: jest.Mocked<IApplicationService>;

  beforeEach(() => {
    // Reset singletons
    (ApplicationServiceFactory as any).instance = undefined;
    (ServiceRegistry as any).instance = undefined;

    // Create mock service instance
    mockService = {
      metadata: {
        name: 'haproxy',
        version: '3.2.0',
        description: 'HAProxy load balancer',
        dependencies: ['docker'],
        tags: ['load-balancer'],
        requiredNetworks: [{ name: 'haproxy_network', driver: 'bridge' }],
        requiredVolumes: [{ name: 'haproxy_data' }],
        exposedPorts: []
      },
      initialize: jest.fn().mockResolvedValue(undefined),
      start: jest.fn().mockResolvedValue({ success: true, message: 'Started', duration: 1000 }),
      stopAndCleanup: jest.fn().mockResolvedValue(undefined),
      getStatus: jest.fn().mockResolvedValue({
        status: ServiceStatus.RUNNING,
        health: { status: 'healthy' as any, lastChecked: new Date() },
        metadata: {} as any
      }),
      isReadyToStart: jest.fn().mockResolvedValue(true)
    };

    // Mock HAProxyService constructor
    MockHAProxyService.mockImplementation(() => mockService);

    // Create mock service registry
    mockServiceRegistry = {
      getServiceDefinition: jest.fn().mockImplementation((serviceType: string) => {
        if (serviceType === 'haproxy') {
          return {
            serviceType: 'haproxy',
            implementation: MockHAProxyService,
            metadata: mockService.metadata,
            description: 'HAProxy load balancer'
          };
        }
        return undefined; // Return undefined for unknown service types
      }),
      validateServiceConfiguration: jest.fn().mockReturnValue(true),
      getAvailableServiceTypes: jest.fn().mockReturnValue(['haproxy'])
    } as any;

    // Mock singleton getInstance
    MockServiceRegistry.getInstance.mockReturnValue(mockServiceRegistry);

    // Create factory instance
    serviceFactory = ApplicationServiceFactory.getInstance();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getInstance', () => {
    it('should return a singleton instance', () => {
      const instance1 = ApplicationServiceFactory.getInstance();
      const instance2 = ApplicationServiceFactory.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('createService', () => {
    it('should create a HAProxy service successfully', async () => {
      const result = await serviceFactory.createService({
        serviceName: 'test-haproxy',
        serviceType: 'haproxy',
        config: { setting: 'value' },
        projectName: 'test-project'
      });

      expect(result.success).toBe(true);
      expect(result.service).toBe(mockService);
      expect(result.message).toBe('Service created successfully');
      expect(MockHAProxyService).toHaveBeenCalledWith('test-project');
    });

    it('should fail for unknown service type', async () => {
      const result = await serviceFactory.createService({
        serviceName: 'unknown-service',
        serviceType: 'unknown',
        config: {}
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('Unknown service type: unknown');
      expect(result.details?.availableTypes).toContain('haproxy');
    });

    it('should return existing service if already created', async () => {
      // Create service first time
      await serviceFactory.createService({
        serviceName: 'test-haproxy',
        serviceType: 'haproxy'
      });

      // Try to create again
      const result = await serviceFactory.createService({
        serviceName: 'test-haproxy',
        serviceType: 'haproxy'
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('Service instance already exists');
      expect(MockHAProxyService).toHaveBeenCalledTimes(1); // Should not create twice
    });

    it('should handle service creation errors', async () => {
      MockHAProxyService.mockImplementation(() => {
        throw new Error('Creation failed');
      });

      const result = await serviceFactory.createService({
        serviceName: 'failing-service',
        serviceType: 'haproxy'
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('Creation failed');
    });
  });

  describe('service management', () => {
    beforeEach(async () => {
      await serviceFactory.createService({
        serviceName: 'test-service',
        serviceType: 'haproxy'
      });
    });

    it('should get existing service', () => {
      const service = serviceFactory.getService('test-service');

      expect(service).toBe(mockService);
    });

    it('should return undefined for non-existent service', () => {
      const service = serviceFactory.getService('non-existent');

      expect(service).toBeUndefined();
    });

    it('should check if service exists', () => {
      expect(serviceFactory.hasService('test-service')).toBe(true);
      expect(serviceFactory.hasService('non-existent')).toBe(false);
    });

    it('should get all services', () => {
      const services = serviceFactory.getAllServices();

      expect(services.size).toBe(1);
      expect(services.get('test-service')).toBe(mockService);
    });

    it('should get services by type', () => {
      const services = serviceFactory.getServicesByType('haproxy');

      expect(services).toHaveLength(1);
      expect(services[0].name).toBe('test-service');
      expect(services[0].service).toBe(mockService);
    });

    it('should get service count', () => {
      expect(serviceFactory.getServiceCount()).toBe(1);
    });

    it('should get service names', () => {
      const names = serviceFactory.getServiceNames();

      expect(names).toEqual(['test-service']);
    });
  });

  describe('service operations', () => {
    beforeEach(async () => {
      await serviceFactory.createService({
        serviceName: 'test-service',
        serviceType: 'haproxy'
      });
    });

    it('should initialize service', async () => {
      const networks = [{ name: 'network1', driver: 'bridge' }];
      const volumes = [{ name: 'volume1' }];

      const result = await serviceFactory.initializeService('test-service', networks, volumes);

      expect(result).toBe(true);
      expect(mockService.initialize).toHaveBeenCalledWith(networks, volumes);
    });

    it('should fail to initialize non-existent service', async () => {
      const result = await serviceFactory.initializeService('non-existent');

      expect(result).toBe(false);
    });

    it('should start service', async () => {
      const result = await serviceFactory.startService('test-service');

      expect(result.success).toBe(true);
      expect(result.duration).toBe(1000);
      expect(mockService.start).toHaveBeenCalled();
    });

    it('should fail to start non-existent service', async () => {
      await expect(serviceFactory.startService('non-existent'))
        .rejects.toThrow('Service not found: non-existent');
    });

    it('should stop service', async () => {
      await serviceFactory.stopService('test-service');

      expect(mockService.stopAndCleanup).toHaveBeenCalled();
    });

    it('should fail to stop non-existent service', async () => {
      await expect(serviceFactory.stopService('non-existent'))
        .rejects.toThrow('Service not found: non-existent');
    });

    it('should get service status', async () => {
      const status = await serviceFactory.getServiceStatus('test-service');

      expect(status).toBeDefined();
      expect(status?.status).toBe(ServiceStatus.RUNNING);
      expect(mockService.getStatus).toHaveBeenCalled();
    });

    it('should return null for non-existent service status', async () => {
      const status = await serviceFactory.getServiceStatus('non-existent');

      expect(status).toBeNull();
    });
  });

  describe('service destruction', () => {
    beforeEach(async () => {
      await serviceFactory.createService({
        serviceName: 'test-service',
        serviceType: 'haproxy'
      });
    });

    it('should destroy service successfully', async () => {
      const result = await serviceFactory.destroyService('test-service');

      expect(result).toBe(true);
      expect(mockService.stopAndCleanup).toHaveBeenCalled();
      expect(serviceFactory.hasService('test-service')).toBe(false);
    });

    it('should return false for non-existent service destruction', async () => {
      const result = await serviceFactory.destroyService('non-existent');

      expect(result).toBe(false);
    });

    it('should handle service destruction errors', async () => {
      mockService.stopAndCleanup.mockRejectedValue(new Error('Stop failed'));

      const result = await serviceFactory.destroyService('test-service');

      expect(result).toBe(false);
      expect(serviceFactory.hasService('test-service')).toBe(true); // Service should still exist
    });

    it('should destroy all services', async () => {
      await serviceFactory.createService({
        serviceName: 'test-service-2',
        serviceType: 'haproxy'
      });

      expect(serviceFactory.getServiceCount()).toBe(2);

      await serviceFactory.destroyAllServices();

      expect(serviceFactory.getServiceCount()).toBe(0);
    });
  });
});