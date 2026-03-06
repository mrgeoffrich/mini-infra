import { ServiceRegistry } from '../services/environment';
import { HAProxyService } from '../services/haproxy/haproxy-service';

describe('ServiceRegistry', () => {
  let serviceRegistry: ServiceRegistry;

  beforeEach(() => {
    // Get a fresh instance for each test
    serviceRegistry = ServiceRegistry.getInstance();
  });

  afterEach(() => {
    // Reset singleton instance for clean tests
    (ServiceRegistry as any).instance = undefined;
  });

  describe('getInstance', () => {
    it('should return a singleton instance', () => {
      const instance1 = ServiceRegistry.getInstance();
      const instance2 = ServiceRegistry.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('default services registration', () => {
    it('should register HAProxy service by default', () => {
      expect(serviceRegistry.isServiceTypeAvailable('haproxy')).toBe(true);
    });

    it('should have haproxy in available service types', () => {
      const availableTypes = serviceRegistry.getAvailableServiceTypes();
      expect(availableTypes).toContain('haproxy');
    });

    it('should return HAProxy service definition', () => {
      const definition = serviceRegistry.getServiceDefinition('haproxy');

      expect(definition).toBeDefined();
      expect(definition!.serviceType).toBe('haproxy');
      expect(definition!.implementation).toBe(HAProxyService);
      expect(definition!.description).toBe('HAProxy load balancer with DataPlane API');
    });

    it('should return HAProxy metadata', () => {
      const metadata = serviceRegistry.getServiceMetadata('haproxy');

      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe('haproxy');
      expect(metadata!.version).toBe('3.2.0');
      expect(metadata!.dependencies).toContain('docker');
      expect(metadata!.requiredNetworks).toHaveLength(1);
      expect(metadata!.requiredVolumes).toHaveLength(4);
      expect(metadata!.exposedPorts).toHaveLength(4);
    });
  });

  describe('service type operations', () => {
    it('should return false for unknown service type', () => {
      expect(serviceRegistry.isServiceTypeAvailable('unknown')).toBe(false);
    });

    it('should return undefined for unknown service definition', () => {
      const definition = serviceRegistry.getServiceDefinition('unknown');
      expect(definition).toBeUndefined();
    });

    it('should return undefined for unknown service metadata', () => {
      const metadata = serviceRegistry.getServiceMetadata('unknown');
      expect(metadata).toBeUndefined();
    });

    it('should return all service definitions', () => {
      const definitions = serviceRegistry.getAllServiceDefinitions();

      expect(definitions).toHaveLength(2);
      expect(definitions.map(d => d.serviceType)).toContain('haproxy');
      expect(definitions.map(d => d.serviceType)).toContain('monitoring');
    });

    it('should return all service metadata with service type', () => {
      const metadata = serviceRegistry.getAllServiceMetadata();

      expect(metadata).toHaveLength(2);
      const haproxyMeta = metadata.find(m => m.serviceType === 'haproxy');
      expect(haproxyMeta).toBeDefined();
      expect(haproxyMeta!.description).toBe('HAProxy load balancer with DataPlane API');
      expect(haproxyMeta!.name).toBe('haproxy');
      const monitoringMeta = metadata.find(m => m.serviceType === 'monitoring');
      expect(monitoringMeta).toBeDefined();
      expect(monitoringMeta!.name).toBe('monitoring');
    });
  });

  describe('service configuration validation', () => {
    it('should validate known service type configuration', () => {
      const isValid = serviceRegistry.validateServiceConfiguration('haproxy', {
        setting1: 'value1',
        setting2: 'value2'
      });

      expect(isValid).toBe(true);
    });

    it('should reject unknown service type configuration', () => {
      const isValid = serviceRegistry.validateServiceConfiguration('unknown', {});

      expect(isValid).toBe(false);
    });
  });

  describe('dependency resolution', () => {
    it('should return dependencies for haproxy service', () => {
      const dependencies = serviceRegistry.getServiceDependencies('haproxy');

      expect(dependencies).toEqual(['docker']);
    });

    it('should return empty array for unknown service dependencies', () => {
      const dependencies = serviceRegistry.getServiceDependencies('unknown');

      expect(dependencies).toEqual([]);
    });

    it('should resolve dependency order for single service', () => {
      const order = serviceRegistry.resolveDependencyOrder(['haproxy']);

      expect(order).toEqual(['haproxy']);
    });

    it('should handle empty service list', () => {
      const order = serviceRegistry.resolveDependencyOrder([]);

      expect(order).toEqual([]);
    });
  });

  describe('service requirements', () => {
    it('should return network requirements for haproxy', () => {
      const networks = serviceRegistry.getServiceNetworkRequirements('haproxy');

      expect(networks).toHaveLength(1);
      expect(networks[0].name).toBe('haproxy_network');
      expect(networks[0].driver).toBe('bridge');
    });

    it('should return volume requirements for haproxy', () => {
      const volumes = serviceRegistry.getServiceVolumeRequirements('haproxy');

      expect(volumes).toHaveLength(4);
      expect(volumes.map(v => v.name)).toContain('haproxy_data');
      expect(volumes.map(v => v.name)).toContain('haproxy_run');
      expect(volumes.map(v => v.name)).toContain('haproxy_config');
      expect(volumes.map(v => v.name)).toContain('haproxy_certs');
    });

    it('should return empty arrays for unknown service requirements', () => {
      const networks = serviceRegistry.getServiceNetworkRequirements('unknown');
      const volumes = serviceRegistry.getServiceVolumeRequirements('unknown');

      expect(networks).toEqual([]);
      expect(volumes).toEqual([]);
    });
  });

  describe('registerService', () => {
    it('should register a new service type', () => {
      const mockMetadata = {
        name: 'test-service',
        version: '1.0.0',
        description: 'Test service',
        dependencies: [],
        tags: ['test'],
        requiredNetworks: [],
        requiredVolumes: [],
        exposedPorts: []
      };

      serviceRegistry.registerService({
        serviceType: 'test-service',
        implementation: class TestService {} as any,
        metadata: mockMetadata,
        description: 'Test service description'
      });

      expect(serviceRegistry.isServiceTypeAvailable('test-service')).toBe(true);
      expect(serviceRegistry.getServiceMetadata('test-service')).toEqual(mockMetadata);
    });

    it('should overwrite existing service type', () => {
      const newMetadata = {
        name: 'haproxy',
        version: '4.0.0',
        description: 'Updated HAProxy',
        dependencies: ['docker', 'network'],
        tags: ['proxy', 'updated'],
        requiredNetworks: [],
        requiredVolumes: [],
        exposedPorts: []
      };

      serviceRegistry.registerService({
        serviceType: 'haproxy',
        implementation: class NewHAProxy {} as any,
        metadata: newMetadata,
        description: 'Updated HAProxy service'
      });

      const metadata = serviceRegistry.getServiceMetadata('haproxy');
      expect(metadata?.version).toBe('4.0.0');
      expect(metadata?.dependencies).toEqual(['docker', 'network']);
    });
  });
});