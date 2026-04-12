/**
 * Azure Storage Certificate Store
 *
 * This service manages certificate storage and retrieval in Azure Blob Storage.
 * Certificates are stored as blobs with metadata tags for searching and filtering.
 */

import { BlobServiceClient } from "@azure/storage-blob";
import { Logger } from "pino";
import { tlsLogger } from "../../lib/logger-factory";
import {
  CertificateMetadata,
  CertificateInfo,
  KeyVaultStorageResult,
  KeyVaultCertificateResult,
} from "./types";

/**
 * Storage result for Azure Blob Storage (matching Key Vault interface)
 */
export interface BlobStorageResult {
  version: string; // ETag serves as version
  secretId: string; // Blob URL serves as secret ID
}

/**
 * Service for storing and retrieving certificates from Azure Blob Storage
 */
export class AzureStorageCertificateStore {
  private blobServiceClient: BlobServiceClient;
  private containerName: string;
  private logger: Logger;

  constructor(connectionString: string, containerName: string) {
    this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    this.containerName = containerName;
    this.logger = tlsLogger();
  }

  /**
   * Store certificate in Azure Blob Storage
   *
   * Certificates are stored as blobs with the combined PEM format (certificate + private key).
   * Metadata is stored as blob metadata tags for searching and filtering.
   *
   * @param name - Blob name (should be cert_{certificateId}.pem for uniqueness)
   * @param certificatePem - PEM-encoded certificate
   * @param privateKeyPem - PEM-encoded private key
   * @param metadata - Certificate metadata for tags
   * @returns Storage result with ETag (as version) and blob URL (as secretId)
   */
  async storeCertificate(
    name: string,
    certificatePem: string,
    privateKeyPem: string,
    metadata: CertificateMetadata
  ): Promise<KeyVaultStorageResult> {
    this.logger.info({ blobName: name, domains: metadata.domains }, "Storing certificate in Azure Storage");

    try {
      // Combine certificate and private key (HAProxy format)
      const combinedPem = certificatePem + privateKeyPem;

      // Get blob client
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      const blobClient = containerClient.getBlockBlobClient(name);

      // Prepare metadata (Azure Storage requires string values only)
      const blobMetadata: Record<string, string> = {
        domains: metadata.domains.join(","),
        notBefore: metadata.notBefore.toISOString(),
        notAfter: metadata.notAfter.toISOString(),
        issuer: metadata.issuer,
        fingerprint: metadata.fingerprint,
        certificateType: "tls-certificate",
      };

      // Upload blob with metadata
      const uploadResponse = await blobClient.upload(
        combinedPem,
        Buffer.byteLength(combinedPem),
        {
          metadata: blobMetadata,
          blobHTTPHeaders: {
            blobContentType: "application/x-pem-file",
          },
        }
      );

      const result: KeyVaultStorageResult = {
        version: uploadResponse.etag || "",
        secretId: blobClient.url,
      };

      this.logger.info(
        { blobName: name, etag: result.version },
        "Certificate stored successfully in Azure Storage"
      );

      return result;
    } catch (error) {
      this.logger.error(
        { blobName: name, error: error instanceof Error ? error.message : String(error) },
        "Failed to store certificate in Azure Storage"
      );
      throw error;
    }
  }

  /**
   * Retrieve certificate with private key from Azure Blob Storage
   *
   * @param name - Blob name
   * @param version - Optional ETag (not commonly used for blob retrieval)
   * @returns Certificate, private key, and metadata
   */
  async getCertificate(name: string, version?: string): Promise<KeyVaultCertificateResult> {
    this.logger.info({ blobName: name, version }, "Retrieving certificate from Azure Storage");

    try {
      // Get blob client
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      const blobClient = containerClient.getBlockBlobClient(name);

      // Download blob
      const downloadResponse = await blobClient.download();

      if (!downloadResponse.readableStreamBody) {
        throw new Error(`Failed to download certificate blob: ${name}`);
      }

      // Read stream to buffer
      const chunks: Buffer[] = [];
      for await (const chunk of downloadResponse.readableStreamBody) {
        chunks.push(Buffer.from(chunk));
      }
      const combinedPem = Buffer.concat(chunks).toString("utf-8");

      // Get metadata
      const properties = await blobClient.getProperties();
      const blobMetadata = properties.metadata || {};

      // Parse certificate and private key from combined PEM
      const { certificate, privateKey } = this.splitCombinedPem(combinedPem);

      // Extract metadata from blob tags
      const metadata: CertificateMetadata = {
        domains: blobMetadata.domains ? blobMetadata.domains.split(",") : [],
        issuer: blobMetadata.issuer || "Unknown",
        notBefore: blobMetadata.notBefore ? new Date(blobMetadata.notBefore) : new Date(),
        notAfter: blobMetadata.notAfter ? new Date(blobMetadata.notAfter) : new Date(),
        fingerprint: blobMetadata.fingerprint || "",
      };

      this.logger.info({ blobName: name, domains: metadata.domains }, "Certificate retrieved successfully");

      return {
        certificate,
        privateKey,
        metadata,
      };
    } catch (error) {
      this.logger.error(
        { blobName: name, error: error instanceof Error ? error.message : String(error) },
        "Failed to retrieve certificate from Azure Storage"
      );
      throw error;
    }
  }

  /**
   * Store ACME account key in Azure Blob Storage
   *
   * @param email - ACME account email
   * @param accountKey - ACME account private key (PEM format)
   */
  async storeAccountKey(email: string, accountKey: string): Promise<void> {
    const blobName = `acme-account-${email.replace(/[^a-zA-Z0-9-]/g, "-")}.key`;

    this.logger.info({ email, blobName }, "Storing ACME account key in Azure Storage");

    try {
      // Get blob client
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      const blobClient = containerClient.getBlockBlobClient(blobName);

      // Prepare metadata
      const blobMetadata: Record<string, string> = {
        email: email,
        type: "acme-account-key",
      };

      // Upload blob
      await blobClient.upload(
        accountKey,
        Buffer.byteLength(accountKey),
        {
          metadata: blobMetadata,
          blobHTTPHeaders: {
            blobContentType: "application/pkcs8",
          },
        }
      );

      this.logger.info({ email, blobName }, "ACME account key stored successfully");
    } catch (error) {
      this.logger.error(
        { email, error: error instanceof Error ? error.message : String(error) },
        "Failed to store ACME account key"
      );
      throw error;
    }
  }

  /**
   * Retrieve ACME account key from Azure Blob Storage
   *
   * @param email - ACME account email
   * @returns ACME account private key as Buffer
   */
  async getAccountKey(email: string): Promise<Buffer> {
    const blobName = `acme-account-${email.replace(/[^a-zA-Z0-9-]/g, "-")}.key`;

    this.logger.info({ email, blobName }, "Retrieving ACME account key from Azure Storage");

    try {
      // Get blob client
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      const blobClient = containerClient.getBlockBlobClient(blobName);

      // Download blob
      const downloadResponse = await blobClient.download();

      if (!downloadResponse.readableStreamBody) {
        throw new Error(`ACME account key not found for email: ${email}`);
      }

      // Read stream to buffer
      const chunks: Buffer[] = [];
      for await (const chunk of downloadResponse.readableStreamBody) {
        chunks.push(Buffer.from(chunk));
      }
      const accountKey = Buffer.concat(chunks);

      this.logger.info({ email }, "ACME account key retrieved successfully");

      return accountKey;
    } catch (error) {
      this.logger.error(
        { email, error: error instanceof Error ? error.message : String(error) },
        "Failed to retrieve ACME account key"
      );
      throw error;
    }
  }

  /**
   * List all certificates in Azure Blob Storage container
   *
   * @returns Array of certificate information
   */
  async listCertificates(): Promise<CertificateInfo[]> {
    this.logger.info("Listing certificates from Azure Storage");

    try {
      const certificates: CertificateInfo[] = [];
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);

      // List all blobs with prefix "cert_"
      const blobIterator = containerClient.listBlobsFlat({
        prefix: "cert_",
        includeMetadata: true,
      });

      for await (const blob of blobIterator) {
        // Get blob properties for additional details
        const blobClient = containerClient.getBlockBlobClient(blob.name);
        const properties = await blobClient.getProperties();

        certificates.push({
          name: blob.name,
          version: properties.etag,
          enabled: true, // Blobs don't have enabled/disabled state
          created: blob.properties.createdOn,
          updated: blob.properties.lastModified,
          tags: properties.metadata || {},
        });
      }

      this.logger.info({ count: certificates.length }, "Listed certificates from Azure Storage");

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
   * Delete certificate from Azure Blob Storage
   *
   * @param name - Blob name
   */
  async deleteCertificate(name: string): Promise<void> {
    this.logger.info({ blobName: name }, "Deleting certificate from Azure Storage");

    try {
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      const blobClient = containerClient.getBlockBlobClient(name);

      await blobClient.delete();

      this.logger.info({ blobName: name }, "Certificate deleted successfully");
    } catch (error) {
      this.logger.error(
        { blobName: name, error: error instanceof Error ? error.message : String(error) },
        "Failed to delete certificate"
      );
      throw error;
    }
  }

  /**
   * Purge deleted certificate permanently
   * Note: Azure Blob Storage doesn't have soft-delete at the service level by default.
   * This method is included for interface compatibility with Key Vault store.
   *
   * @param name - Blob name
   */
  async purgeCertificate(name: string): Promise<void> {
    this.logger.info({ blobName: name }, "Purge operation called (no-op for Azure Storage without soft-delete)");
    // In Azure Storage, delete is permanent unless soft-delete is configured.
    // For interface compatibility, we'll make this a no-op.
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
