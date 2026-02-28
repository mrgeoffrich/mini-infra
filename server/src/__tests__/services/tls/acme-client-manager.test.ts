/**
 * Unit tests for AcmeClientManager
 */

import { AcmeClientManager } from "../../../services/tls/acme-client-manager";
import { TlsConfigService } from "../../../services/tls/tls-config";
import { AzureStorageCertificateStore } from "../../../services/tls/azure-storage-certificate-store";
import { DnsChallenge01Provider } from "../../../services/tls/dns-challenge-provider";
import * as acme from "acme-client";

// Mock acme-client
vi.mock("acme-client", () => {
  return {
    Client: vi.fn().mockImplementation(function() { return {
      auto: vi.fn(),
      createOrder: vi.fn(),
      finalizeOrder: vi.fn(),
    }; }),
    directory: {
      letsencrypt: {
        production: "https://acme-v02.api.letsencrypt.org/directory",
        staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
      },
      buypass: {
        production: "https://api.buypass.com/acme/directory",
      },
      zerossl: {
        production: "https://acme.zerossl.com/v2/DV90",
      },
    },
    crypto: {
      createPrivateKey: vi.fn().mockResolvedValue({
        toString: vi.fn().mockReturnValue("MOCK_PRIVATE_KEY"),
      }),
      createCsr: vi.fn().mockResolvedValue([
        { toString: vi.fn().mockReturnValue("MOCK_PRIVATE_KEY") },
        "MOCK_CSR",
      ]),
    },
  };
});

// Mock prisma
vi.mock("../../../lib/prisma", () => ({
  default: {
    tlsCertificate: {
      findUnique: vi.fn(),
    },
    acmeAccount: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

// Mock logger
vi.mock("../../../lib/logger-factory", () => {
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
  };
});

describe("AcmeClientManager", () => {
  let acmeClientManager: AcmeClientManager;
  let mockTlsConfig: Mocked<TlsConfigService>;
  let mockKeyVaultStore: Mocked<AzureStorageCertificateStore>;
  let mockDnsChallenge: Mocked<DnsChallenge01Provider>;

  beforeEach(() => {
    // Create mocks
    mockTlsConfig = {
      get: vi.fn(),
      getAll: vi.fn(),
      getAcmeAccountConfig: vi.fn().mockResolvedValue({
        email: "test@example.com",
        provider: "letsencrypt-staging",
      }),
      getCertificateContainerName: vi.fn().mockResolvedValue("certificates"),
    } as any;

    mockKeyVaultStore = {
      getAccountKey: vi.fn(),
      storeAccountKey: vi.fn(),
      storeCertificate: vi.fn(),
      getCertificate: vi.fn(),
    } as any;

    mockDnsChallenge = {
      createChallenge: vi.fn(),
      removeChallenge: vi.fn(),
    } as any;

    acmeClientManager = new AcmeClientManager(mockTlsConfig, mockKeyVaultStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("initialize", () => {
    it("should initialize ACME client with existing account key", async () => {
      const mockAccountKey = Buffer.from("MOCK_ACCOUNT_KEY");
      mockKeyVaultStore.getAccountKey.mockResolvedValue(mockAccountKey);

      await acmeClientManager.initialize();

      expect(mockTlsConfig.getAcmeAccountConfig).toHaveBeenCalled();
      expect(mockKeyVaultStore.getAccountKey).toHaveBeenCalledWith("test@example.com");
    });

    it("should create new account if no account key exists", async () => {
      mockKeyVaultStore.getAccountKey.mockRejectedValue(new Error("Not found"));

      const mockPrivateKey = { toString: vi.fn().mockReturnValue("NEW_KEY") };
      acme.crypto.createPrivateKey.mockResolvedValue(mockPrivateKey);

      await acmeClientManager.initialize();

      expect(acme.crypto.createPrivateKey).toHaveBeenCalled();
      expect(mockKeyVaultStore.storeAccountKey).toHaveBeenCalledWith(
        "test@example.com",
        "NEW_KEY"
      );
    });
  });

  describe("requestCertificate", () => {
    it("should request certificate with DNS-01 challenge", async () => {
      const domains = ["test.example.com"];

      // Mock successful certificate request
      const mockCertificate = "-----BEGIN CERTIFICATE-----\nMOCK_CERT\n-----END CERTIFICATE-----";
      const mockClient = {
        auto: vi.fn().mockResolvedValue(mockCertificate),
      };
      acme.Client.mockImplementation(function() { return mockClient; });

      // Initialize first
      mockKeyVaultStore.getAccountKey.mockResolvedValue(Buffer.from("MOCK_KEY"));
      await acmeClientManager.initialize();

      // Request certificate
      const result = await acmeClientManager.requestCertificate(domains, mockDnsChallenge);

      expect(acme.crypto.createCsr).toHaveBeenCalledWith({
        altNames: domains,
      });

      expect(mockClient.auto).toHaveBeenCalledWith(
        expect.objectContaining({
          csr: "MOCK_CSR",
          termsOfServiceAgreed: true,
          challengePriority: ["dns-01"],
        })
      );

      expect(result).toEqual({
        certificate: mockCertificate,
        privateKey: "MOCK_PRIVATE_KEY",
        chain: mockCertificate,
      });
    });

    it("should handle ACME errors gracefully", async () => {
      const domains = ["test.example.com"];

      const mockClient = {
        auto: vi.fn().mockRejectedValue(new Error("ACME rate limit exceeded")),
      };
      acme.Client.mockImplementation(function() { return mockClient; });

      mockKeyVaultStore.getAccountKey.mockResolvedValue(Buffer.from("MOCK_KEY"));
      await acmeClientManager.initialize();

      await expect(
        acmeClientManager.requestCertificate(domains, mockDnsChallenge)
      ).rejects.toThrow("ACME rate limit exceeded");
    });

    it("should call DNS challenge create and remove functions", async () => {
      const domains = ["test.example.com"];

      let challengeCreateFn: any;
      let challengeRemoveFn: any;

      const mockClient = {
        auto: vi.fn().mockImplementation((config) => {
          challengeCreateFn = config.challengeCreateFn;
          challengeRemoveFn = config.challengeRemoveFn;
          return "MOCK_CERT";
        }),
      };
      acme.Client.mockImplementation(function() { return mockClient; });

      mockKeyVaultStore.getAccountKey.mockResolvedValue(Buffer.from("MOCK_KEY"));
      await acmeClientManager.initialize();

      await acmeClientManager.requestCertificate(domains, mockDnsChallenge);

      // Test challenge functions were passed correctly
      expect(challengeCreateFn).toBeDefined();
      expect(challengeRemoveFn).toBeDefined();

      // Test calling the challenge functions
      const mockAuthz = { identifier: { value: "test.example.com" } };
      const mockChallenge = { type: "dns-01" };
      const mockKeyAuth = "MOCK_KEY_AUTH";

      await challengeCreateFn(mockAuthz, mockChallenge, mockKeyAuth);
      expect(mockDnsChallenge.createChallenge).toHaveBeenCalledWith(
        mockAuthz,
        mockChallenge,
        mockKeyAuth
      );

      await challengeRemoveFn(mockAuthz, mockChallenge, mockKeyAuth);
      expect(mockDnsChallenge.removeChallenge).toHaveBeenCalledWith(
        mockAuthz,
        mockChallenge,
        mockKeyAuth
      );
    });
  });

  describe("renewCertificate", () => {
    it("should renew certificate using existing domains", async () => {
      const certificateId = "cert-123";

      const mockCertificate = "-----BEGIN CERTIFICATE-----\nRENEWED_CERT\n-----END CERTIFICATE-----";
      const mockClient = {
        auto: vi.fn().mockResolvedValue(mockCertificate),
      };
      acme.Client.mockImplementation(function() { return mockClient; });

      mockKeyVaultStore.getAccountKey.mockResolvedValue(Buffer.from("MOCK_KEY"));
      await acmeClientManager.initialize();

      // Mock prisma to return existing certificate for renewal
      const prisma = (await import("../../../lib/prisma")).default;
      (prisma.tlsCertificate.findUnique as any).mockResolvedValue({
        id: certificateId,
        domains: ["test.example.com"],
      });

      // For this test, we're testing the ACME renewal flow
      const result = await acmeClientManager.renewCertificate(certificateId, mockDnsChallenge);

      expect(result).toEqual({
        certificate: mockCertificate,
        privateKey: "MOCK_PRIVATE_KEY",
        chain: mockCertificate,
      });
    });
  });

  describe("createAccount", () => {
    it("should create new ACME account and store key in Key Vault", async () => {
      const email = "newuser@example.com";

      const mockPrivateKey = { toString: vi.fn().mockReturnValue("NEW_ACCOUNT_KEY") };
      acme.crypto.createPrivateKey.mockResolvedValue(mockPrivateKey);

      // Make getAccountKey reject so initialize() creates a new key
      mockKeyVaultStore.getAccountKey.mockRejectedValue(new Error("Not found"));

      const mockAccountUrl = "https://acme-v02.api.letsencrypt.org/acme/acct/12345";
      const mockClient = {
        createAccount: vi.fn().mockResolvedValue({ url: mockAccountUrl }),
        getAccountUrl: vi.fn().mockResolvedValue(mockAccountUrl),
      };
      acme.Client.mockImplementation(function() { return mockClient; });

      const result = await acmeClientManager.createAccount(email);

      expect(acme.crypto.createPrivateKey).toHaveBeenCalled();
      // storeAccountKey is called during initialize() with the config email
      expect(mockKeyVaultStore.storeAccountKey).toHaveBeenCalledWith("test@example.com", "NEW_ACCOUNT_KEY");
      // createAccount returns the raw account object from the ACME client
      expect(result).toEqual({ url: mockAccountUrl });
    });
  });

  describe("error handling", () => {
    it("should throw error if ACME client initialization fails", async () => {
      const failingConfig = {
        ...mockTlsConfig,
        getAcmeAccountConfig: vi.fn().mockRejectedValue(new Error("Config not available")),
      } as any;
      const freshManager = new AcmeClientManager(failingConfig, mockKeyVaultStore);
      const domains = ["test.example.com"];

      await expect(
        freshManager.requestCertificate(domains, mockDnsChallenge)
      ).rejects.toThrow("Config not available");
    });

    it("should handle invalid domain names", async () => {
      const invalidDomains = [""];

      mockKeyVaultStore.getAccountKey.mockResolvedValue(Buffer.from("MOCK_KEY"));
      await acmeClientManager.initialize();

      acme.crypto.createCsr.mockRejectedValue(new Error("Invalid domain"));

      await expect(
        acmeClientManager.requestCertificate(invalidDomains, mockDnsChallenge)
      ).rejects.toThrow("Invalid domain");
    });
  });
});
