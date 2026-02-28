/**
 * Unit tests for AzureKeyVaultCertificateStore
 */

import { AzureKeyVaultCertificateStore } from "../../../services/tls/azure-keyvault-certificate-store";
import { CertificateClient } from "@azure/keyvault-certificates";
import { SecretClient } from "@azure/keyvault-secrets";
import { TokenCredential } from "@azure/identity";

// Mock Azure SDK
vi.mock("@azure/keyvault-certificates");
vi.mock("@azure/keyvault-secrets");

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

describe("AzureKeyVaultCertificateStore", () => {
  let store: AzureKeyVaultCertificateStore;
  let mockCertificateClient: Mocked<CertificateClient>;
  let mockSecretClient: Mocked<SecretClient>;
  let mockCredential: TokenCredential;

  const mockKeyVaultUrl = "https://test-vault.vault.azure.net/";

  beforeEach(() => {
    mockCredential = {} as TokenCredential;

    mockCertificateClient = {
      getCertificate: vi.fn(),
      listPropertiesOfCertificates: vi.fn(),
      deleteCertificate: vi.fn(),
      purgeCertificate: vi.fn(),
    } as any;

    mockSecretClient = {
      setSecret: vi.fn(),
      getSecret: vi.fn(),
      deleteSecret: vi.fn(),
      beginDeleteSecret: vi.fn(),
      purgeDeletedSecret: vi.fn(),
    } as any;

    (CertificateClient as Mock).mockImplementation(function() { return mockCertificateClient; });
    (SecretClient as Mock).mockImplementation(function() { return mockSecretClient; });

    store = new AzureKeyVaultCertificateStore(mockKeyVaultUrl, mockCredential);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("storeCertificate", () => {
    it("should store certificate and private key as secret", async () => {
      const name = "test-cert";
      const certificatePem = "-----BEGIN CERTIFICATE-----\nMOCK_CERT\n-----END CERTIFICATE-----";
      const privateKeyPem = "-----BEGIN PRIVATE KEY-----\nMOCK_KEY\n-----END PRIVATE KEY-----";
      const metadata = {
        domains: ["test.example.com"],
        issuer: "Let's Encrypt",
        notBefore: new Date("2025-01-01"),
        notAfter: new Date("2025-04-01"),
        fingerprint: "abc123",
      };

      const mockSecretResponse = {
        properties: {
          id: "https://test-vault.vault.azure.net/secrets/test-cert/version123",
          version: "version123",
        },
      };

      mockSecretClient.setSecret.mockResolvedValue(mockSecretResponse as any);

      const result = await store.storeCertificate(name, certificatePem, privateKeyPem, metadata);

      expect(mockSecretClient.setSecret).toHaveBeenCalledWith(
        name,
        certificatePem + privateKeyPem,
        expect.objectContaining({
          contentType: "application/x-pem-file",
          tags: expect.objectContaining({
            domains: "test.example.com",
            issuer: "Let's Encrypt",
            fingerprint: "abc123",
          }),
        })
      );

      expect(result).toEqual({
        version: "version123",
        secretId: "https://test-vault.vault.azure.net/secrets/test-cert/version123",
      });
    });

    it("should handle multiple domains in metadata", async () => {
      const metadata = {
        domains: ["example.com", "www.example.com", "*.example.com"],
        issuer: "Let's Encrypt",
        notBefore: new Date("2025-01-01"),
        notAfter: new Date("2025-04-01"),
        fingerprint: "abc123",
      };

      mockSecretClient.setSecret.mockResolvedValue({
        properties: { id: "mock-id", version: "v1" },
      } as any);

      await store.storeCertificate("test", "CERT", "KEY", metadata);

      expect(mockSecretClient.setSecret).toHaveBeenCalledWith(
        "test",
        "CERTKEY",
        expect.objectContaining({
          tags: expect.objectContaining({
            domains: "example.com,www.example.com,*.example.com",
          }),
        })
      );
    });

    it("should handle Key Vault errors", async () => {
      mockSecretClient.setSecret.mockRejectedValue(new Error("Unauthorized"));

      await expect(
        store.storeCertificate("test", "CERT", "KEY", {
          domains: ["test.com"],
          issuer: "Test",
          notBefore: new Date(),
          notAfter: new Date(),
          fingerprint: "abc",
        })
      ).rejects.toThrow("Unauthorized");
    });
  });

  describe("getCertificate", () => {
    it("should retrieve certificate with private key", async () => {
      const name = "test-cert";
      const combinedPem =
        "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----" +
        "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----";

      const mockSecretResponse = {
        value: combinedPem,
        properties: {
          version: "v1",
          tags: {
            domains: "test.com",
            issuer: "Let's Encrypt",
            notBefore: "2025-01-01T00:00:00.000Z",
            notAfter: "2025-04-01T00:00:00.000Z",
            fingerprint: "abc123",
          },
        },
      };

      mockSecretClient.getSecret.mockResolvedValue(mockSecretResponse as any);

      const result = await store.getCertificate(name);

      expect(mockSecretClient.getSecret).toHaveBeenCalledWith(name, { version: undefined });
      expect(result.certificate).toContain("-----BEGIN CERTIFICATE-----");
      expect(result.privateKey).toContain("-----BEGIN PRIVATE KEY-----");
      expect(result.metadata.domains).toEqual(["test.com"]);
      expect(result.metadata.issuer).toBe("Let's Encrypt");
    });

    it("should retrieve specific version of certificate", async () => {
      const name = "test-cert";
      const version = "v2";

      const combinedPem =
        "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----" +
        "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----";

      mockSecretClient.getSecret.mockResolvedValue({
        value: combinedPem,
        properties: { tags: {} },
      } as any);

      await store.getCertificate(name, version);

      expect(mockSecretClient.getSecret).toHaveBeenCalledWith(name, { version: "v2" });
    });

    it("should handle certificate not found", async () => {
      mockSecretClient.getSecret.mockRejectedValue({
        code: "SecretNotFound",
        message: "Secret not found",
      });

      await expect(store.getCertificate("nonexistent")).rejects.toThrow();
    });
  });

  describe("storeAccountKey", () => {
    it("should store ACME account key as secret", async () => {
      const email = "test@example.com";
      const accountKey = "-----BEGIN PRIVATE KEY-----\nACCOUNT_KEY\n-----END PRIVATE KEY-----";

      mockSecretClient.setSecret.mockResolvedValue({
        properties: { id: "mock-id" },
      } as any);

      await store.storeAccountKey(email, accountKey);

      expect(mockSecretClient.setSecret).toHaveBeenCalledWith(
        "acme-account-test-example-com",
        accountKey,
        expect.objectContaining({
          contentType: "application/pkcs8",
          tags: {
            email: "test@example.com",
            type: "acme-account-key",
          },
        })
      );
    });

    it("should sanitize email for secret name", async () => {
      const email = "user+test@example.com";

      mockSecretClient.setSecret.mockResolvedValue({
        properties: { id: "mock-id" },
      } as any);

      await store.storeAccountKey(email, "KEY");

      expect(mockSecretClient.setSecret).toHaveBeenCalledWith(
        expect.stringMatching(/^acme-account-[a-zA-Z0-9-]+$/),
        "KEY",
        expect.any(Object)
      );
    });
  });

  describe("getAccountKey", () => {
    it("should retrieve ACME account key", async () => {
      const email = "test@example.com";
      const accountKey = "MOCK_ACCOUNT_KEY";

      mockSecretClient.getSecret.mockResolvedValue({
        value: accountKey,
      } as any);

      const result = await store.getAccountKey(email);

      expect(mockSecretClient.getSecret).toHaveBeenCalledWith("acme-account-test-example-com");
      expect(result).toEqual(Buffer.from(accountKey));
    });

    it("should throw error if account key not found", async () => {
      mockSecretClient.getSecret.mockRejectedValue({
        code: "SecretNotFound",
        message: "Secret not found",
      });

      await expect(store.getAccountKey("nonexistent@example.com")).rejects.toThrow();
    });
  });

  describe("listCertificates", () => {
    it("should list all certificates", async () => {
      const mockCertificates = [
        {
          name: "cert-1",
          properties: {
            version: "v1",
            createdOn: new Date("2025-01-01"),
            expiresOn: new Date("2025-04-01"),
          },
        },
        {
          name: "cert-2",
          properties: {
            version: "v1",
            createdOn: new Date("2025-01-01"),
            expiresOn: new Date("2025-04-01"),
          },
        },
      ];

      mockCertificateClient.listPropertiesOfCertificates.mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const cert of mockCertificates) {
            yield cert;
          }
        },
      } as any);

      const result = await store.listCertificates();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("cert-1");
      expect(result[1].name).toBe("cert-2");
    });

    it("should return empty array when no certificates", async () => {
      mockCertificateClient.listPropertiesOfCertificates.mockReturnValue({
        [Symbol.asyncIterator]: async function* () {},
      } as any);

      const result = await store.listCertificates();

      expect(result).toEqual([]);
    });
  });

  describe("deleteCertificate", () => {
    it("should soft delete certificate", async () => {
      const name = "test-cert";

      mockSecretClient.beginDeleteSecret.mockResolvedValue({
        properties: { name },
      } as any);

      await store.deleteCertificate(name);

      expect(mockSecretClient.beginDeleteSecret).toHaveBeenCalledWith(name);
    });

    it("should handle delete errors gracefully", async () => {
      mockSecretClient.beginDeleteSecret.mockRejectedValue(new Error("Not found"));

      await expect(store.deleteCertificate("nonexistent")).rejects.toThrow("Not found");
    });
  });

  describe("purgeCertificate", () => {
    it("should permanently delete certificate", async () => {
      const name = "test-cert";

      mockSecretClient.purgeDeletedSecret.mockResolvedValue({} as any);

      await store.purgeCertificate(name);

      expect(mockSecretClient.purgeDeletedSecret).toHaveBeenCalledWith(name);
    });
  });
});
