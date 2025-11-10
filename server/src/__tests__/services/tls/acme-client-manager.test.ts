/**
 * Unit tests for AcmeClientManager
 */

import { AcmeClientManager } from "../../../services/tls/acme-client-manager";
import { TlsConfigService } from "../../../services/tls/tls-config";
import { AzureKeyVaultCertificateStore } from "../../../services/tls/azure-keyvault-certificate-store";
import { DnsChallenge01Provider } from "../../../services/tls/dns-challenge-provider";

// Mock acme-client
jest.mock("acme-client", () => {
  return {
    Client: jest.fn().mockImplementation(() => ({
      auto: jest.fn(),
      createOrder: jest.fn(),
      finalizeOrder: jest.fn(),
    })),
    directory: {
      letsencrypt: {
        production: "https://acme-v02.api.letsencrypt.org/directory",
        staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
      },
    },
    crypto: {
      createPrivateKey: jest.fn().mockResolvedValue({
        toString: jest.fn().mockReturnValue("MOCK_PRIVATE_KEY"),
      }),
      createCsr: jest.fn().mockResolvedValue([
        { toString: jest.fn().mockReturnValue("MOCK_PRIVATE_KEY") },
        "MOCK_CSR",
      ]),
    },
  };
});

// Mock logger
jest.mock("../../../lib/logger-factory", () => ({
  tlsLogger: jest.fn(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe("AcmeClientManager", () => {
  let acmeClientManager: AcmeClientManager;
  let mockTlsConfig: jest.Mocked<TlsConfigService>;
  let mockKeyVaultStore: jest.Mocked<AzureKeyVaultCertificateStore>;
  let mockDnsChallenge: jest.Mocked<DnsChallenge01Provider>;

  beforeEach(() => {
    // Create mocks
    mockTlsConfig = {
      get: jest.fn(),
      getAll: jest.fn(),
    } as any;

    mockKeyVaultStore = {
      getAccountKey: jest.fn(),
      storeAccountKey: jest.fn(),
      storeCertificate: jest.fn(),
      getCertificate: jest.fn(),
    } as any;

    mockDnsChallenge = {
      createChallenge: jest.fn(),
      removeChallenge: jest.fn(),
    } as any;

    // Setup default config responses
    mockTlsConfig.get.mockImplementation(async (key: string) => {
      const config: Record<string, string> = {
        default_acme_email: "test@example.com",
        default_acme_provider: "letsencrypt-staging",
      };
      return config[key];
    });

    acmeClientManager = new AcmeClientManager(mockTlsConfig, mockKeyVaultStore);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("initialize", () => {
    it("should initialize ACME client with existing account key", async () => {
      const mockAccountKey = Buffer.from("MOCK_ACCOUNT_KEY");
      mockKeyVaultStore.getAccountKey.mockResolvedValue(mockAccountKey);

      await acmeClientManager.initialize();

      expect(mockTlsConfig.get).toHaveBeenCalledWith("default_acme_email");
      expect(mockKeyVaultStore.getAccountKey).toHaveBeenCalledWith("test@example.com");
    });

    it("should create new account if no account key exists", async () => {
      mockKeyVaultStore.getAccountKey.mockRejectedValue(new Error("Not found"));

      const acme = require("acme-client");
      const mockPrivateKey = { toString: jest.fn().mockReturnValue("NEW_KEY") };
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
      const acme = require("acme-client");

      // Mock successful certificate request
      const mockCertificate = "-----BEGIN CERTIFICATE-----\nMOCK_CERT\n-----END CERTIFICATE-----";
      const mockClient = {
        auto: jest.fn().mockResolvedValue(mockCertificate),
      };
      acme.Client.mockImplementation(() => mockClient);

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
          email: "test@example.com",
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
      const acme = require("acme-client");

      const mockClient = {
        auto: jest.fn().mockRejectedValue(new Error("ACME rate limit exceeded")),
      };
      acme.Client.mockImplementation(() => mockClient);

      mockKeyVaultStore.getAccountKey.mockResolvedValue(Buffer.from("MOCK_KEY"));
      await acmeClientManager.initialize();

      await expect(
        acmeClientManager.requestCertificate(domains, mockDnsChallenge)
      ).rejects.toThrow("ACME rate limit exceeded");
    });

    it("should call DNS challenge create and remove functions", async () => {
      const domains = ["test.example.com"];
      const acme = require("acme-client");

      let challengeCreateFn: any;
      let challengeRemoveFn: any;

      const mockClient = {
        auto: jest.fn().mockImplementation((config) => {
          challengeCreateFn = config.challengeCreateFn;
          challengeRemoveFn = config.challengeRemoveFn;
          return "MOCK_CERT";
        }),
      };
      acme.Client.mockImplementation(() => mockClient);

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
      const acme = require("acme-client");

      const mockCertificate = "-----BEGIN CERTIFICATE-----\nRENEWED_CERT\n-----END CERTIFICATE-----";
      const mockClient = {
        auto: jest.fn().mockResolvedValue(mockCertificate),
      };
      acme.Client.mockImplementation(() => mockClient);

      mockKeyVaultStore.getAccountKey.mockResolvedValue(Buffer.from("MOCK_KEY"));
      await acmeClientManager.initialize();

      // Mock getting existing certificate would happen in CertificateLifecycleManager
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
      const acme = require("acme-client");

      const mockPrivateKey = { toString: jest.fn().mockReturnValue("NEW_ACCOUNT_KEY") };
      acme.crypto.createPrivateKey.mockResolvedValue(mockPrivateKey);

      const mockAccountUrl = "https://acme-v02.api.letsencrypt.org/acme/acct/12345";
      const mockClient = {
        getAccountUrl: jest.fn().mockResolvedValue(mockAccountUrl),
      };
      acme.Client.mockImplementation(() => mockClient);

      const result = await acmeClientManager.createAccount(email);

      expect(acme.crypto.createPrivateKey).toHaveBeenCalled();
      expect(mockKeyVaultStore.storeAccountKey).toHaveBeenCalledWith(email, "NEW_ACCOUNT_KEY");
      expect(result).toEqual({
        email,
        accountUrl: mockAccountUrl,
        provider: "letsencrypt-staging",
      });
    });
  });

  describe("error handling", () => {
    it("should throw error if ACME client not initialized", async () => {
      const freshManager = new AcmeClientManager(mockTlsConfig, mockKeyVaultStore);
      const domains = ["test.example.com"];

      await expect(
        freshManager.requestCertificate(domains, mockDnsChallenge)
      ).rejects.toThrow();
    });

    it("should handle invalid domain names", async () => {
      const invalidDomains = [""];
      const acme = require("acme-client");

      mockKeyVaultStore.getAccountKey.mockResolvedValue(Buffer.from("MOCK_KEY"));
      await acmeClientManager.initialize();

      acme.crypto.createCsr.mockRejectedValue(new Error("Invalid domain"));

      await expect(
        acmeClientManager.requestCertificate(invalidDomains, mockDnsChallenge)
      ).rejects.toThrow("Invalid domain");
    });
  });
});
