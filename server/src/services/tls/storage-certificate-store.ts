/**
 * Provider-agnostic certificate store backed by `StorageBackend`.
 *
 * Replaces the old `AzureStorageCertificateStore`. The certificate managers
 * (lifecycle, distributor, ACME) now depend on this class directly — same
 * `storeCertificate` / `getCertificate` / `storeAccountKey` / etc. surface,
 * but the underlying I/O is whatever provider the operator picked. Drive
 * support lands in Phase 3 with no additional changes here.
 *
 * The store keys cert blobs as `cert_{certificateId}.pem` and ACME account
 * keys as `acme-account-{sanitised-email}.key`, exactly as before, so a
 * future migration tool can move blobs across providers byte-for-byte.
 */

import type {
  StorageBackend,
  StorageLocationRef,
} from "@mini-infra/types";
import { Logger } from "pino";
import { getLogger } from "../../lib/logger-factory";
import {
  CertificateMetadata,
  CertificateInfo,
  KeyVaultStorageResult,
  KeyVaultCertificateResult,
} from "./types";

/**
 * Storage result for the generic store. The `version` field is the backend's
 * authoritative etag (Azure: blob ETag) and `secretId` is the public URL
 * (Azure: blob URL). Drive populates these analogously.
 */
export type BlobStorageResult = KeyVaultStorageResult;

/**
 * Service for storing and retrieving certificates via the active
 * `StorageBackend`. Replaces `AzureStorageCertificateStore`.
 */
export class StorageCertificateStore {
  private backend: StorageBackend;
  private locationRef: StorageLocationRef;
  private logger: Logger;

  /**
   * @param backend - active StorageBackend (Azure Blob, Drive, ...)
   * @param locationId - opaque location id (Azure container name; Drive folder ID)
   */
  constructor(backend: StorageBackend, locationId: string) {
    this.backend = backend;
    this.locationRef = { id: locationId, displayName: locationId };
    this.logger = getLogger("tls", "storage-certificate-store");
  }

  /**
   * Store certificate (cert + private key combined PEM) plus metadata tags.
   */
  async storeCertificate(
    name: string,
    certificatePem: string,
    privateKeyPem: string,
    metadata: CertificateMetadata,
  ): Promise<KeyVaultStorageResult> {
    this.logger.info(
      { blobName: name, domains: metadata.domains },
      "Storing certificate",
    );
    try {
      const combinedPem = certificatePem + privateKeyPem;
      const body = Buffer.from(combinedPem, "utf-8");
      const objectMetadata: Record<string, string> = {
        domains: metadata.domains.join(","),
        notBefore: metadata.notBefore.toISOString(),
        notAfter: metadata.notAfter.toISOString(),
        issuer: metadata.issuer,
        fingerprint: metadata.fingerprint,
        certificateType: "tls-certificate",
      };
      const result = await this.backend.upload(
        this.locationRef,
        name,
        body,
        body.byteLength,
        {
          contentType: "application/x-pem-file",
          metadata: objectMetadata,
        },
      );
      const out: KeyVaultStorageResult = {
        version: result.etag ?? "",
        secretId: result.objectUrl ?? "",
      };
      this.logger.info(
        { blobName: name, etag: out.version },
        "Certificate stored successfully",
      );
      return out;
    } catch (error) {
      this.logger.error(
        {
          blobName: name,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to store certificate",
      );
      throw error;
    }
  }

  /**
   * Retrieve a certificate (combined PEM) and re-parse the on-disk metadata
   * tags into a `CertificateMetadata`.
   */
  async getCertificate(
    name: string,
    version?: string,
  ): Promise<KeyVaultCertificateResult> {
    this.logger.info({ blobName: name, version }, "Retrieving certificate");
    try {
      const download = await this.backend.getDownloadStream(
        this.locationRef,
        name,
      );
      const stream = download.stream as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const combinedPem = Buffer.concat(chunks).toString("utf-8");

      const head = await this.backend.head(this.locationRef, name);
      const blobMetadata = head?.metadata ?? {};

      const { certificate, privateKey } = this.splitCombinedPem(combinedPem);
      const metadata: CertificateMetadata = {
        domains: blobMetadata.domains ? blobMetadata.domains.split(",") : [],
        issuer: blobMetadata.issuer || "Unknown",
        notBefore: blobMetadata.notBefore
          ? new Date(blobMetadata.notBefore)
          : new Date(),
        notAfter: blobMetadata.notAfter
          ? new Date(blobMetadata.notAfter)
          : new Date(),
        fingerprint: blobMetadata.fingerprint || "",
      };
      this.logger.info(
        { blobName: name, domains: metadata.domains },
        "Certificate retrieved successfully",
      );
      return { certificate, privateKey, metadata };
    } catch (error) {
      this.logger.error(
        {
          blobName: name,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to retrieve certificate",
      );
      throw error;
    }
  }

  async storeAccountKey(email: string, accountKey: string): Promise<void> {
    const blobName = `acme-account-${email.replace(/[^a-zA-Z0-9-]/g, "-")}.key`;
    this.logger.info({ email, blobName }, "Storing ACME account key");
    try {
      const body = Buffer.from(accountKey, "utf-8");
      await this.backend.upload(
        this.locationRef,
        blobName,
        body,
        body.byteLength,
        {
          contentType: "application/pkcs8",
          metadata: { email, type: "acme-account-key" },
        },
      );
      this.logger.info(
        { email, blobName },
        "ACME account key stored successfully",
      );
    } catch (error) {
      this.logger.error(
        {
          email,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to store ACME account key",
      );
      throw error;
    }
  }

  async getAccountKey(email: string): Promise<Buffer> {
    const blobName = `acme-account-${email.replace(/[^a-zA-Z0-9-]/g, "-")}.key`;
    this.logger.info({ email, blobName }, "Retrieving ACME account key");
    try {
      const download = await this.backend.getDownloadStream(
        this.locationRef,
        blobName,
      );
      const stream = download.stream as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const out = Buffer.concat(chunks);
      this.logger.info({ email }, "ACME account key retrieved successfully");
      return out;
    } catch (error) {
      this.logger.error(
        {
          email,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to retrieve ACME account key",
      );
      throw error;
    }
  }

  async listCertificates(): Promise<CertificateInfo[]> {
    this.logger.info("Listing certificates from storage backend");
    try {
      const list = await this.backend.list(this.locationRef, {
        prefix: "cert_",
      });
      return list.objects.map((obj) => ({
        name: obj.name,
        version: obj.etag,
        enabled: true,
        created: obj.createdAt,
        updated: obj.lastModified,
        tags: obj.metadata ?? {},
      }));
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to list certificates",
      );
      throw error;
    }
  }

  async deleteCertificate(name: string): Promise<void> {
    this.logger.info({ blobName: name }, "Deleting certificate");
    try {
      await this.backend.delete(this.locationRef, name);
      this.logger.info({ blobName: name }, "Certificate deleted successfully");
    } catch (error) {
      this.logger.error(
        {
          blobName: name,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to delete certificate",
      );
      throw error;
    }
  }

  /** Parity shim with old store. Soft-delete is a Key Vault concept. */
  async purgeCertificate(name: string): Promise<void> {
    this.logger.info(
      { blobName: name },
      "Purge operation called (no-op for storage backend without soft-delete)",
    );
  }

  private splitCombinedPem(combinedPem: string): {
    certificate: string;
    privateKey: string;
  } {
    const certMatch = combinedPem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
    );
    const keyMatch = combinedPem.match(
      /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/,
    );
    if (!certMatch || !keyMatch) {
      throw new Error(
        "Invalid combined PEM format: missing certificate or private key",
      );
    }
    return { certificate: certMatch[0], privateKey: keyMatch[0] };
  }
}
