/**
 * Azure Key Vault Certificate Store
 *
 * This service manages certificate storage and retrieval in Azure Key Vault.
 * It handles both certificate metadata (via Certificate API) and private keys (via Secret API).
 */

import { CertificateClient } from "@azure/keyvault-certificates";
import { SecretClient } from "@azure/keyvault-secrets";
import { TokenCredential } from "@azure/identity";
import { Logger } from "pino";
import { tlsLogger } from "../../lib/logger-factory";
import {
  CertificateMetadata,
  CertificateInfo,
  KeyVaultStorageResult,
  KeyVaultCertificateResult,
} from "./types";

/**
 * Service for storing and retrieving certificates from Azure Key Vault
 */
export class AzureKeyVaultCertificateStore {
  private certificateClient: CertificateClient;
  private secretClient: SecretClient;
  private logger: Logger;

  constructor(keyVaultUrl: string, credential: TokenCredential) {
    this.certificateClient = new CertificateClient(keyVaultUrl, credential);
    this.secretClient = new SecretClient(keyVaultUrl, credential);
    this.logger = tlsLogger();
  }

  /**
   * Store certificate in Key Vault
   *
   * Certificates are stored as secrets to preserve the private key in PEM format.
   * The certificate and private key are combined into a single PEM file (HAProxy format).
   *
   * @param name - Certificate name (must be unique in Key Vault)
   * @param certificatePem - PEM-encoded certificate
   * @param privateKeyPem - PEM-encoded private key
   * @param metadata - Certificate metadata for tags
   * @returns Storage result with version and secret ID
   */
  async storeCertificate(
    name: string,
    certificatePem: string,
    privateKeyPem: string,
    metadata: CertificateMetadata
  ): Promise<KeyVaultStorageResult> {
    this.logger.info({ certificateName: name, domains: metadata.domains }, "Storing certificate in Key Vault");

    try {
      // Combine certificate and private key (HAProxy format)
      const combinedPem = certificatePem + privateKeyPem;

      // Store as secret (includes private key)
      const secretResponse = await this.secretClient.setSecret(name, combinedPem, {
        contentType: "application/x-pem-file",
        tags: {
          domains: metadata.domains.join(","),
          notBefore: metadata.notBefore.toISOString(),
          notAfter: metadata.notAfter.toISOString(),
          issuer: metadata.issuer,
          fingerprint: metadata.fingerprint,
        },
      });

      const result: KeyVaultStorageResult = {
        version: secretResponse.properties.version || "",
        secretId: secretResponse.properties.id || "",
      };

      this.logger.info(
        { certificateName: name, version: result.version },
        "Certificate stored successfully in Key Vault"
      );

      return result;
    } catch (error) {
      this.logger.error(
        { certificateName: name, error: error instanceof Error ? error.message : String(error) },
        "Failed to store certificate in Key Vault"
      );
      throw error;
    }
  }

  /**
   * Retrieve certificate with private key from Key Vault
   *
   * @param name - Certificate name
   * @param version - Optional specific version (defaults to latest)
   * @returns Certificate, private key, and metadata
   */
  async getCertificate(name: string, version?: string): Promise<KeyVaultCertificateResult> {
    this.logger.info({ certificateName: name, version }, "Retrieving certificate from Key Vault");

    try {
      // Retrieve secret (contains combined PEM)
      const secret = await this.secretClient.getSecret(name, { version });

      if (!secret.value) {
        throw new Error(`Certificate secret has no value: ${name}`);
      }

      const combinedPem = secret.value;
      const tags = secret.properties.tags || {};

      // Parse certificate and private key from combined PEM
      const { certificate, privateKey } = this.splitCombinedPem(combinedPem);

      // Extract metadata from tags
      const metadata: CertificateMetadata = {
        domains: tags.domains ? tags.domains.split(",") : [],
        issuer: tags.issuer || "Unknown",
        notBefore: tags.notBefore ? new Date(tags.notBefore) : new Date(),
        notAfter: tags.notAfter ? new Date(tags.notAfter) : new Date(),
        fingerprint: tags.fingerprint || "",
      };

      this.logger.info({ certificateName: name, domains: metadata.domains }, "Certificate retrieved successfully");

      return {
        certificate,
        privateKey,
        metadata,
      };
    } catch (error) {
      this.logger.error(
        { certificateName: name, error: error instanceof Error ? error.message : String(error) },
        "Failed to retrieve certificate from Key Vault"
      );
      throw error;
    }
  }

  /**
   * Store ACME account key in Key Vault
   *
   * @param email - ACME account email
   * @param accountKey - ACME account private key (PEM format)
   */
  async storeAccountKey(email: string, accountKey: string): Promise<void> {
    const secretName = `acme-account-${email.replace(/[^a-zA-Z0-9-]/g, "-")}`;

    this.logger.info({ email, secretName }, "Storing ACME account key in Key Vault");

    try {
      await this.secretClient.setSecret(secretName, accountKey, {
        contentType: "application/pkcs8",
        tags: {
          email: email,
          type: "acme-account-key",
        },
      });

      this.logger.info({ email, secretName }, "ACME account key stored successfully");
    } catch (error) {
      this.logger.error(
        { email, error: error instanceof Error ? error.message : String(error) },
        "Failed to store ACME account key"
      );
      throw error;
    }
  }

  /**
   * Retrieve ACME account key from Key Vault
   *
   * @param email - ACME account email
   * @returns ACME account private key as Buffer
   */
  async getAccountKey(email: string): Promise<Buffer> {
    const secretName = `acme-account-${email.replace(/[^a-zA-Z0-9-]/g, "-")}`;

    this.logger.info({ email, secretName }, "Retrieving ACME account key from Key Vault");

    try {
      const secret = await this.secretClient.getSecret(secretName);

      if (!secret.value) {
        throw new Error(`ACME account key not found for email: ${email}`);
      }

      this.logger.info({ email }, "ACME account key retrieved successfully");

      return Buffer.from(secret.value);
    } catch (error) {
      this.logger.error(
        { email, error: error instanceof Error ? error.message : String(error) },
        "Failed to retrieve ACME account key"
      );
      throw error;
    }
  }

  /**
   * List all certificates in Key Vault
   *
   * @returns Array of certificate information
   */
  async listCertificates(): Promise<CertificateInfo[]> {
    this.logger.info("Listing certificates from Key Vault");

    try {
      const certificates: CertificateInfo[] = [];

      for await (const properties of this.certificateClient.listPropertiesOfCertificates()) {
        certificates.push({
          name: properties.name || "unknown",
          version: properties.version,
          enabled: properties.enabled,
          created: properties.createdOn,
          updated: properties.updatedOn,
          tags: properties.tags,
        });
      }

      this.logger.info({ count: certificates.length }, "Listed certificates from Key Vault");

      return certificates;
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to list certificates"
      );
      throw error;
    }
  }

  /**
   * Delete certificate from Key Vault (soft delete)
   *
   * @param name - Certificate name
   */
  async deleteCertificate(name: string): Promise<void> {
    this.logger.info({ certificateName: name }, "Deleting certificate from Key Vault");

    try {
      // Delete both certificate and secret
      await this.secretClient.beginDeleteSecret(name);

      this.logger.info({ certificateName: name }, "Certificate deleted successfully");
    } catch (error) {
      this.logger.error(
        { certificateName: name, error: error instanceof Error ? error.message : String(error) },
        "Failed to delete certificate"
      );
      throw error;
    }
  }

  /**
   * Purge deleted certificate permanently
   *
   * @param name - Certificate name
   */
  async purgeCertificate(name: string): Promise<void> {
    this.logger.info({ certificateName: name }, "Purging deleted certificate from Key Vault");

    try {
      await this.secretClient.purgeDeletedSecret(name);

      this.logger.info({ certificateName: name }, "Certificate purged successfully");
    } catch (error) {
      this.logger.error(
        { certificateName: name, error: error instanceof Error ? error.message : String(error) },
        "Failed to purge certificate"
      );
      throw error;
    }
  }

  /**
   * Split combined PEM into certificate and private key
   *
   * @param combinedPem - Combined PEM string
   * @returns Separated certificate and private key
   * @private
   */
  private splitCombinedPem(combinedPem: string): { certificate: string; privateKey: string } {
    // Find certificate boundaries
    const certMatch = combinedPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
    const keyMatch = combinedPem.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/);

    if (!certMatch || !keyMatch) {
      throw new Error("Invalid combined PEM format: missing certificate or private key");
    }

    return {
      certificate: certMatch[0],
      privateKey: keyMatch[0],
    };
  }
}
