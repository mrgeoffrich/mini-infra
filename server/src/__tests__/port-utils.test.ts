import { PortUtils } from '../services/port-utils';
import prisma from '../lib/prisma';

// Mock prisma
jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    environment: {
      findUnique: jest.fn(),
    },
    systemSettings: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

describe('PortUtils', () => {
  let portUtils: PortUtils;
  const mockUserId = 'test-user-123';

  beforeEach(() => {
    portUtils = new PortUtils();
    jest.clearAllMocks();
  });

  describe('getHAProxyPortsForEnvironment', () => {
    it('should return local network default ports (80/443) for local environment', async () => {
      // Mock environment with local network type
      (prisma.environment.findUnique as jest.Mock).mockResolvedValue({
        id: 'env-1',
        networkType: 'local',
      });

      // Mock no port overrides
      (prisma.systemSettings.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await portUtils.getHAProxyPortsForEnvironment('env-1');

      expect(result).toEqual({
        httpPort: 80,
        httpsPort: 443,
        source: 'network-type',
        networkType: 'local',
      });

      expect(prisma.environment.findUnique).toHaveBeenCalledWith({
        where: { id: 'env-1' },
      });
    });

    it('should return internet network default ports (8111/8443) for internet environment', async () => {
      // Mock environment with internet network type
      (prisma.environment.findUnique as jest.Mock).mockResolvedValue({
        id: 'env-2',
        networkType: 'internet',
      });

      // Mock no port overrides
      (prisma.systemSettings.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await portUtils.getHAProxyPortsForEnvironment('env-2');

      expect(result).toEqual({
        httpPort: 8111,
        httpsPort: 8443,
        source: 'network-type',
        networkType: 'internet',
      });
    });

    it('should return override ports when configured', async () => {
      // Mock environment
      (prisma.environment.findUnique as jest.Mock).mockResolvedValue({
        id: 'env-3',
        networkType: 'local',
      });

      // Mock port overrides
      (prisma.systemSettings.findFirst as jest.Mock)
        .mockResolvedValueOnce({ value: '9080' }) // HTTP override
        .mockResolvedValueOnce({ value: '9443' }); // HTTPS override

      const result = await portUtils.getHAProxyPortsForEnvironment('env-3');

      expect(result).toEqual({
        httpPort: 9080,
        httpsPort: 9443,
        source: 'override',
      });
    });

    it('should throw error if environment not found', async () => {
      (prisma.environment.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        portUtils.getHAProxyPortsForEnvironment('nonexistent')
      ).rejects.toThrow('Environment not found: nonexistent');
    });

    it('should use internet defaults for unknown network type', async () => {
      // Mock environment with unknown network type
      (prisma.environment.findUnique as jest.Mock).mockResolvedValue({
        id: 'env-4',
        networkType: 'unknown',
      });

      // Mock no port overrides
      (prisma.systemSettings.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await portUtils.getHAProxyPortsForEnvironment('env-4');

      expect(result.httpPort).toBe(8111);
      expect(result.httpsPort).toBe(8443);
    });
  });

  describe('validateHAProxyPorts', () => {
    it('should validate correct port numbers', async () => {
      const result = await portUtils.validateHAProxyPorts(8080, 8443);

      expect(result.isValid).toBe(true);
      expect(result.httpPortAvailable).toBe(true);
      expect(result.httpsPortAvailable).toBe(true);
    });

    it('should reject invalid HTTP port number', async () => {
      const result = await portUtils.validateHAProxyPorts(0, 443);

      expect(result.isValid).toBe(false);
      expect(result.httpPortAvailable).toBe(false);
      expect(result.conflicts.httpPort).toContain('Invalid port number');
    });

    it('should reject invalid HTTPS port number', async () => {
      const result = await portUtils.validateHAProxyPorts(80, 70000);

      expect(result.isValid).toBe(false);
      expect(result.httpsPortAvailable).toBe(false);
      expect(result.conflicts.httpsPort).toContain('Invalid port number');
    });

    it('should reject when HTTP and HTTPS ports are the same', async () => {
      const result = await portUtils.validateHAProxyPorts(8080, 8080);

      expect(result.isValid).toBe(false);
      expect(result.conflicts.httpPort).toContain('cannot be the same');
      expect(result.conflicts.httpsPort).toContain('cannot be the same');
    });

    it('should provide suggested ports when validation fails', async () => {
      // Mock port availability to return false
      jest.spyOn(portUtils, 'isPortAvailable').mockResolvedValue(false);

      const result = await portUtils.validateHAProxyPorts(80, 443);

      expect(result.isValid).toBe(false);
      expect(result.suggestedPorts).toEqual({
        httpPort: 8111,
        httpsPort: 8443,
      });
    });
  });

  describe('isPortAvailable', () => {
    it('should check if port is available', async () => {
      // This test will check an available port
      // Using a high port number that's likely to be available
      const result = await portUtils.isPortAvailable(59999);

      expect(typeof result).toBe('boolean');
    });
  });

  describe('setPortOverride', () => {
    it('should create new HTTP port override', async () => {
      // Mock no existing setting
      (prisma.systemSettings.findFirst as jest.Mock).mockResolvedValue(null);

      // Mock create
      (prisma.systemSettings.create as jest.Mock).mockResolvedValue({
        id: 'setting-1',
        category: 'haproxy',
        key: 'haproxy_http_port',
        value: '9080',
      });

      await portUtils.setPortOverride('http', 9080, mockUserId);

      expect(prisma.systemSettings.create).toHaveBeenCalledWith({
        data: {
          category: 'haproxy',
          key: 'haproxy_http_port',
          value: '9080',
          isEncrypted: false,
          isActive: true,
          createdBy: mockUserId,
          updatedBy: mockUserId,
        },
      });
    });

    it('should update existing HTTP port override', async () => {
      // Mock existing setting
      (prisma.systemSettings.findFirst as jest.Mock).mockResolvedValue({
        id: 'setting-1',
        category: 'haproxy',
        key: 'haproxy_http_port',
        value: '8080',
      });

      // Mock update
      (prisma.systemSettings.update as jest.Mock).mockResolvedValue({
        id: 'setting-1',
        value: '9080',
      });

      await portUtils.setPortOverride('http', 9080, mockUserId);

      expect(prisma.systemSettings.update).toHaveBeenCalledWith({
        where: { id: 'setting-1' },
        data: {
          value: '9080',
          isActive: true,
          updatedBy: mockUserId,
        },
      });
    });

    it('should create new HTTPS port override', async () => {
      // Mock no existing setting
      (prisma.systemSettings.findFirst as jest.Mock).mockResolvedValue(null);

      // Mock create
      (prisma.systemSettings.create as jest.Mock).mockResolvedValue({
        id: 'setting-2',
        category: 'haproxy',
        key: 'haproxy_https_port',
        value: '9443',
      });

      await portUtils.setPortOverride('https', 9443, mockUserId);

      expect(prisma.systemSettings.create).toHaveBeenCalledWith({
        data: {
          category: 'haproxy',
          key: 'haproxy_https_port',
          value: '9443',
          isEncrypted: false,
          isActive: true,
          createdBy: mockUserId,
          updatedBy: mockUserId,
        },
      });
    });

    it('should delete port override when setting null', async () => {
      // Mock existing setting
      (prisma.systemSettings.findFirst as jest.Mock).mockResolvedValue({
        id: 'setting-1',
        category: 'haproxy',
        key: 'haproxy_http_port',
        value: '9080',
      });

      // Mock delete
      (prisma.systemSettings.delete as jest.Mock).mockResolvedValue({
        id: 'setting-1',
      });

      await portUtils.setPortOverride('http', null, mockUserId);

      expect(prisma.systemSettings.delete).toHaveBeenCalledWith({
        where: { id: 'setting-1' },
      });
    });

    it('should reject invalid port number', async () => {
      await expect(
        portUtils.setPortOverride('http', 70000, mockUserId)
      ).rejects.toThrow('Invalid port number');

      expect(prisma.systemSettings.create).not.toHaveBeenCalled();
      expect(prisma.systemSettings.update).not.toHaveBeenCalled();
    });
  });

  describe('getPortOverrides', () => {
    it('should return both port overrides when set', async () => {
      (prisma.systemSettings.findFirst as jest.Mock)
        .mockResolvedValueOnce({ value: '9080' }) // HTTP
        .mockResolvedValueOnce({ value: '9443' }); // HTTPS

      const result = await portUtils.getPortOverrides();

      expect(result).toEqual({
        httpPort: 9080,
        httpsPort: 9443,
      });
    });

    it('should return null for unset overrides', async () => {
      (prisma.systemSettings.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await portUtils.getPortOverrides();

      expect(result).toEqual({
        httpPort: null,
        httpsPort: null,
      });
    });
  });

  describe('arePortOverridesConfigured', () => {
    it('should return true when both overrides are set', async () => {
      (prisma.systemSettings.findFirst as jest.Mock)
        .mockResolvedValueOnce({ value: '9080' })
        .mockResolvedValueOnce({ value: '9443' });

      const result = await portUtils.arePortOverridesConfigured();

      expect(result).toBe(true);
    });

    it('should return false when only HTTP override is set', async () => {
      (prisma.systemSettings.findFirst as jest.Mock)
        .mockResolvedValueOnce({ value: '9080' })
        .mockResolvedValueOnce(null);

      const result = await portUtils.arePortOverridesConfigured();

      expect(result).toBe(false);
    });

    it('should return false when no overrides are set', async () => {
      (prisma.systemSettings.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await portUtils.arePortOverridesConfigured();

      expect(result).toBe(false);
    });
  });
});
