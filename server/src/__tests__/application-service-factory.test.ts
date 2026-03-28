import { ApplicationServiceFactory } from '../services/application-service-factory';
import { IApplicationService } from '../services/interfaces/application-service';
import { ServiceStatusValues } from '@mini-infra/types';

describe('ApplicationServiceFactory', () => {
  let serviceFactory: ApplicationServiceFactory;
  let mockService: Mocked<IApplicationService>;

  beforeEach(() => {
    // Reset singletons
    (ApplicationServiceFactory as any).instance = undefined;

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
      initialize: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue({ success: true, message: 'Started', duration: 1000 }),
      stopAndCleanup: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockResolvedValue({
        status: ServiceStatusValues.RUNNING,
        health: { status: 'healthy' as any, lastChecked: new Date() },
        metadata: {} as any
      }),
      isReadyToStart: vi.fn().mockResolvedValue(true)
    };

    // Create factory instance
    serviceFactory = ApplicationServiceFactory.getInstance();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getInstance', () => {
    it('should return a singleton instance', () => {
      const instance1 = ApplicationServiceFactory.getInstance();
      const instance2 = ApplicationServiceFactory.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('createService', () => {
    it('should return failure because service creation via factory is no longer supported', async () => {
      const result = await serviceFactory.createService({
        serviceName: 'test-haproxy',
        serviceType: 'haproxy',
        config: { setting: 'value' },
        projectName: 'test-project'
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('no longer supported');
    });
  });

  describe('service management (with manually registered services)', () => {
    beforeEach(() => {
      // Manually inject a service into the factory's private map for testing
      (serviceFactory as any).activeServices.set('test-service', mockService);
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

  describe('service operations (with manually registered services)', () => {
    beforeEach(() => {
      (serviceFactory as any).activeServices.set('test-service', mockService);
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

    it('should not throw when stopping non-existent service', async () => {
      // stopService no longer throws for non-existent services - it logs and returns
      await serviceFactory.stopService('non-existent');
      // Should not throw
    });

    it('should get service status', async () => {
      const status = await serviceFactory.getServiceStatus('test-service');

      expect(status).toBeDefined();
      expect(status?.status).toBe(ServiceStatusValues.RUNNING);
      expect(mockService.getStatus).toHaveBeenCalled();
    });

    it('should return null for non-existent service status', async () => {
      const status = await serviceFactory.getServiceStatus('non-existent');

      expect(status).toBeNull();
    });
  });

  describe('service destruction (with manually registered services)', () => {
    beforeEach(() => {
      (serviceFactory as any).activeServices.set('test-service', mockService);
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
      const mockService2 = { ...mockService, stopAndCleanup: vi.fn().mockResolvedValue(undefined) } as any;
      (serviceFactory as any).activeServices.set('test-service-2', mockService2);

      expect(serviceFactory.getServiceCount()).toBe(2);

      await serviceFactory.destroyAllServices();

      expect(serviceFactory.getServiceCount()).toBe(0);
    });
  });
});
