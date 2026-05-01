/**
 * Azure Blob Storage backend for the pluggable Storage provider.
 *
 * Implements `StorageBackend` against `@azure/storage-blob`. All logic was
 * lifted from the now-deleted `AzureStorageService` — the connection string
 * lives encrypted in `(category="storage-azure", key="connection_string")`,
 * the storage-account display name in `storage_account_name`. Connectivity is
 * recorded under `service="storage"` (not `service="azure"`), since the
 * Storage page is provider-agnostic from Phase 1 onwards.
 *
 * Retention is enforced server-side by deleting blobs whose `createdOn` (or
 * `lastModified` fallback) is older than the configured age. Drive will need
 * to do the same client-side with `files.list` + `files.delete` — same
 * interface, different implementation.
 */

import {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import NodeCache from "node-cache";
import {
  ConnectivityStatusType,
  ServiceHealthStatus,
  ValidationResult,
  StorageBackend,
  StorageLocationRef,
  StorageObjectMetadata,
  ListResult,
  LocationInfo,
  UploadHandle,
  UploadOptions,
  UploadResult,
  DownloadHandle,
  DownloadStream,
  ProviderMetadata,
  RetentionEnforcementResult,
  RetentionPolicy,
} from "@mini-infra/types";
import { ConfigurationService } from "../../../configuration-base";
import { PrismaClient } from "../../../../lib/prisma";
import { toServiceError } from "../../../../lib/service-error-mapper";
import { getLogger } from "../../../../lib/logger-factory";
import { azureConfig } from "../../../../lib/config-new";

const log = () => getLogger("platform", "azure-storage-backend");

/**
 * Cache for `testLocationAccess` results — 5 min for hits, 1–2 min for misses.
 * Static so concurrent backend instances share the same window.
 */
const locationAccessCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  useClones: false,
});

export class AzureStorageBackend
  extends ConfigurationService
  implements StorageBackend
{
  readonly providerId = "azure" as const;

  private static readonly CONNECTION_STRING_KEY = "connection_string";
  private static readonly STORAGE_ACCOUNT_KEY = "storage_account_name";

  constructor(prisma: PrismaClient) {
    // Use the storage-azure category for the provider's own settings, but the
    // connectivity row is recorded under "storage" via override below.
    super(prisma, "storage-azure");
  }

  private get timeoutMs(): number {
    return azureConfig.apiTimeout;
  }

  /**
   * Connectivity rows live under the generic "storage" service so the Storage
   * page indicator and the `useStorageConnectivity()` hook can read a single
   * row regardless of active provider. Override the base implementation.
   */
  protected async recordConnectivityStatus(
    status: ConnectivityStatusType,
    responseTimeMs?: number,
    errorMessage?: string,
    errorCode?: string,
    metadata?: Record<string, unknown>,
    userId?: string,
  ): Promise<void> {
    try {
      await this.prisma.connectivityStatus.create({
        data: {
          service: "storage",
          status: status,
          responseTimeMs: responseTimeMs ?? null,
          errorMessage: errorMessage ?? null,
          errorCode: errorCode ?? null,
          metadata: metadata ? JSON.stringify(metadata) : null,
          checkInitiatedBy: userId ?? null,
          checkedAt: new Date(),
          lastSuccessfulAt: status === "connected" ? new Date() : null,
        },
      });
    } catch (error) {
      log().error(
        {
          status,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to record storage connectivity status",
      );
    }
  }

  // ====================
  // Settings helpers (encrypted at rest)
  // ====================

  /** Read the encrypted connection string. Returns null if not configured. */
  async getConnectionString(): Promise<string | null> {
    return await this.getSecure(AzureStorageBackend.CONNECTION_STRING_KEY);
  }

  async setConnectionString(
    connectionString: string,
    userId: string,
  ): Promise<void> {
    if (!connectionString || connectionString.trim().length === 0) {
      throw new Error("Connection string cannot be empty");
    }

    const requiredKeys = [
      "DefaultEndpointsProtocol",
      "AccountName",
      "AccountKey",
    ];
    const missingKeys = requiredKeys.filter(
      (key) => !connectionString.includes(`${key}=`),
    );
    if (missingKeys.length > 0) {
      throw new Error(
        `Invalid connection string format. Missing: ${missingKeys.join(", ")}`,
      );
    }

    await this.setSecure(
      AzureStorageBackend.CONNECTION_STRING_KEY,
      connectionString,
      userId,
    );
  }

  async getStorageAccountName(): Promise<string | null> {
    return await this.get(AzureStorageBackend.STORAGE_ACCOUNT_KEY);
  }

  /** Wipe the encrypted connection string + cached account name. */
  async removeConfiguration(userId: string): Promise<void> {
    try {
      await super.delete(AzureStorageBackend.CONNECTION_STRING_KEY, userId);
    } catch {
      // OK if not present.
    }
    try {
      await super.delete(AzureStorageBackend.STORAGE_ACCOUNT_KEY, userId);
    } catch {
      // OK if not present.
    }
    await this.recordConnectivityStatus(
      "failed",
      undefined,
      "Configuration removed by user",
      "CONFIG_REMOVED",
      undefined,
      userId,
    );
  }

  // ====================
  // Internal client wiring
  // ====================

  private async getBlobServiceClient(
    connectionStringOverride?: string,
  ): Promise<BlobServiceClient> {
    const connectionString =
      connectionStringOverride ?? (await this.getConnectionString());
    if (!connectionString) {
      throw new Error("Azure Storage connection string not configured");
    }
    return BlobServiceClient.fromConnectionString(connectionString);
  }

  private parseConnectionStringParts(
    connectionString: string,
  ): { accountName: string; accountKey: string } {
    const accountNameMatch = connectionString.match(/AccountName=([^;]+)/);
    const accountKeyMatch = connectionString.match(/AccountKey=([^;]+)/);
    if (!accountNameMatch || !accountKeyMatch) {
      throw new Error(
        "Invalid connection string: missing AccountName or AccountKey",
      );
    }
    return { accountName: accountNameMatch[1], accountKey: accountKeyMatch[1] };
  }

  private async retryOperation<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
    baseDelayMs = 1000,
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        const errorMessage = lastError.message.toLowerCase();
        if (
          errorMessage.includes("authenticationfailed") ||
          errorMessage.includes("forbidden") ||
          errorMessage.includes("invalidaccountkey") ||
          errorMessage.includes("invalidstorage")
        ) {
          throw lastError;
        }
        if (attempt === maxRetries) break;
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
        log().warn(
          {
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            delayMs: Math.round(delay),
            error: errorMessage,
          },
          "Azure operation failed, retrying...",
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError!;
  }

  // ====================
  // StorageBackend — validation & metadata
  // ====================

  async validate(settings?: Record<string, string>): Promise<ValidationResult> {
    const startTime = Date.now();
    try {
      const connectionString =
        settings?.connectionString ?? (await this.getConnectionString());
      if (!connectionString) {
        const result: ValidationResult = {
          isValid: false,
          message: "Azure Storage connection string not configured",
          errorCode: "MISSING_CONNECTION_STRING",
          responseTimeMs: Date.now() - startTime,
        };
        await this.recordConnectivityStatus(
          "failed",
          result.responseTimeMs,
          result.message,
          result.errorCode,
        );
        return result;
      }

      const blobServiceClient =
        BlobServiceClient.fromConnectionString(connectionString);
      const accountInfoPromise = blobServiceClient.getAccountInfo();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Azure API request timeout")),
          this.timeoutMs,
        ),
      );
      const accountInfo = await Promise.race([
        accountInfoPromise,
        timeoutPromise,
      ]);

      const responseTime = Date.now() - startTime;
      const accountNameMatch = connectionString.match(/AccountName=([^;]+)/);
      const accountName = accountNameMatch ? accountNameMatch[1] : "Unknown";

      const containers: string[] = [];
      try {
        const iter = blobServiceClient.listContainers();
        for await (const container of iter) {
          containers.push(container.name);
          if (containers.length >= 10) break;
        }
      } catch (containerError) {
        log().warn(
          {
            accountName,
            error:
              containerError instanceof Error
                ? containerError.message
                : "Unknown error",
          },
          "Failed to list containers, but connection is valid",
        );
      }

      const metadata: Record<string, unknown> = {
        accountName,
        skuName: accountInfo.skuName,
        accountKind: accountInfo.accountKind,
        containerCount: containers.length,
        containers: containers.slice(0, 5),
      };

      if (accountName !== "Unknown") {
        await this.set(
          AzureStorageBackend.STORAGE_ACCOUNT_KEY,
          accountName,
          "system",
        );
      }

      const result: ValidationResult = {
        isValid: true,
        message: `Azure Storage connection successful (${accountName})`,
        responseTimeMs: responseTime,
        metadata,
      };
      await this.recordConnectivityStatus(
        "connected",
        result.responseTimeMs,
        undefined,
        undefined,
        metadata,
      );
      return result;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      let errorCode = "AZURE_STORAGE_ERROR";
      let connectivityStatus: ConnectivityStatusType = "failed";

      if (errorMessage.includes("timeout")) {
        errorCode = "TIMEOUT";
        connectivityStatus = "timeout";
      } else if (
        errorMessage.includes("AuthenticationFailed") ||
        errorMessage.includes("InvalidStorageAccountName") ||
        errorMessage.includes("InvalidAccountKey")
      ) {
        errorCode = "INVALID_CREDENTIALS";
      } else if (errorMessage.includes("Forbidden")) {
        errorCode = "INSUFFICIENT_PERMISSIONS";
      } else if (
        errorMessage.includes("ENOTFOUND") ||
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("getaddrinfo")
      ) {
        errorCode = "NETWORK_ERROR";
        connectivityStatus = "unreachable";
      } else if (errorMessage.includes("Rate exceeded")) {
        errorCode = "RATE_LIMITED";
      } else if (errorMessage.includes("InvalidUri")) {
        errorCode = "INVALID_CONNECTION_STRING";
      }

      const result: ValidationResult = {
        isValid: false,
        message: `Azure Storage validation failed: ${errorMessage}`,
        errorCode,
        responseTimeMs: responseTime,
      };
      await this.recordConnectivityStatus(
        connectivityStatus,
        result.responseTimeMs,
        result.message,
        result.errorCode,
      );
      log().error(
        { error: errorMessage, errorCode, responseTime },
        "Azure Storage validation failed",
      );
      return result;
    }
  }

  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.getLatestConnectivityStatusForStorage();
    if (!latestStatus) {
      const validationResult = await this.validate();
      return {
        service: "storage",
        status: validationResult.isValid ? "connected" : "failed",
        lastChecked: new Date(),
        responseTime: validationResult.responseTimeMs,
        errorMessage: validationResult.isValid
          ? undefined
          : validationResult.message,
        errorCode: validationResult.errorCode,
        metadata: validationResult.metadata,
      };
    }
    return {
      service: "storage",
      status: latestStatus.status as ConnectivityStatusType,
      lastChecked: latestStatus.checkedAt,
      lastSuccessful: latestStatus.lastSuccessfulAt,
      responseTime: latestStatus.responseTimeMs ?? undefined,
      errorMessage: latestStatus.errorMessage ?? undefined,
      errorCode: latestStatus.errorCode ?? undefined,
      metadata: latestStatus.metadata
        ? JSON.parse(latestStatus.metadata)
        : undefined,
    };
  }

  /**
   * Read the latest "storage" connectivity row directly. The base helper keys
   * off `this.category`, which is `storage-azure` here; we deliberately store
   * connectivity under the bare `storage` service.
   */
  private async getLatestConnectivityStatusForStorage() {
    try {
      const record = await this.prisma.connectivityStatus.findFirst({
        where: { service: "storage" },
        orderBy: { checkedAt: "desc" },
      });
      if (!record) return null;
      return {
        status: record.status,
        checkedAt: record.checkedAt,
        lastSuccessfulAt: record.lastSuccessfulAt ?? undefined,
        responseTimeMs:
          record.responseTimeMs != null
            ? Number(record.responseTimeMs)
            : undefined,
        errorMessage: record.errorMessage ?? undefined,
        errorCode: record.errorCode ?? undefined,
        metadata: record.metadata ?? undefined,
      };
    } catch (error) {
      log().error(
        { error: error instanceof Error ? error.message : "Unknown error" },
        "Failed to load storage connectivity row",
      );
      return null;
    }
  }

  async getProviderMetadata(): Promise<ProviderMetadata> {
    const accountName = (await this.getStorageAccountName()) ?? "Unknown";
    return { accountLabel: accountName, providerId: this.providerId };
  }

  // ====================
  // StorageBackend — locations
  // ====================

  async listLocations(opts?: {
    search?: string;
    limit?: number;
  }): Promise<LocationInfo[]> {
    const limit = opts?.limit ?? 50;
    try {
      const blobServiceClient = await this.getBlobServiceClient();
      const containers: LocationInfo[] = [];
      const containersPromise = (async () => {
        const iter = blobServiceClient.listContainers({
          includeMetadata: true,
        });
        for await (const c of iter) {
          if (
            opts?.search &&
            !c.name.toLowerCase().includes(opts.search.toLowerCase())
          ) {
            continue;
          }
          containers.push({
            id: c.name,
            displayName: c.name,
            lastModified: c.properties.lastModified
              ? c.properties.lastModified.toISOString()
              : undefined,
            accessible: true,
            metadata: {
              etag: c.properties.etag,
              leaseStatus: c.properties.leaseStatus,
              leaseState: c.properties.leaseState,
              hasImmutabilityPolicy: c.properties.hasImmutabilityPolicy,
              hasLegalHold: c.properties.hasLegalHold,
              userMetadata: c.metadata ?? {},
            },
          });
          if (containers.length >= limit) break;
        }
        return containers;
      })();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Container listing timeout")),
          this.timeoutMs,
        ),
      );
      return await Promise.race([containersPromise, timeoutPromise]);
    } catch (error) {
      log().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to list Azure containers",
      );
      return [];
    }
  }

  async testLocationAccess(ref: StorageLocationRef): Promise<LocationInfo> {
    const cacheKey = `container_access:${ref.id}`;
    const cached = locationAccessCache.get<LocationInfo>(cacheKey);
    if (cached) {
      log().debug({ id: ref.id }, "Location access result returned from cache");
      return cached;
    }

    const start = Date.now();
    try {
      const blobServiceClient = await this.getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(ref.id);
      const result = await this.retryOperation(
        async () => {
          const propsPromise = containerClient.getProperties();
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Container access test timeout")),
              5000,
            ),
          );
          const props = await Promise.race([propsPromise, timeoutPromise]);
          return props;
        },
        2,
        500,
      );
      const info: LocationInfo = {
        id: ref.id,
        displayName: ref.id,
        accessible: true,
        lastModified: result.lastModified?.toISOString(),
        metadata: {
          responseTimeMs: Date.now() - start,
          leaseStatus: result.leaseStatus,
          leaseState: result.leaseState,
        },
      };
      locationAccessCache.set(cacheKey, info);
      return info;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      let errorCode = "CONTAINER_ACCESS_ERROR";
      if (errorMessage.includes("timeout")) errorCode = "TIMEOUT";
      else if (
        errorMessage.includes("AuthenticationFailed") ||
        errorMessage.includes("InvalidAccountKey")
      )
        errorCode = "INVALID_CREDENTIALS";
      else if (errorMessage.includes("ContainerNotFound"))
        errorCode = "CONTAINER_NOT_FOUND";
      else if (errorMessage.includes("Forbidden"))
        errorCode = "INSUFFICIENT_PERMISSIONS";
      else if (
        errorMessage.includes("ENOTFOUND") ||
        errorMessage.includes("ECONNREFUSED")
      )
        errorCode = "NETWORK_ERROR";
      const info: LocationInfo = {
        id: ref.id,
        displayName: ref.id,
        accessible: false,
        metadata: {
          responseTimeMs: Date.now() - start,
          error: errorMessage,
          errorCode,
        },
      };
      locationAccessCache.set(cacheKey, info, 120);
      return info;
    }
  }

  // ====================
  // StorageBackend — list / head / upload / download / delete
  // ====================

  async list(
    ref: StorageLocationRef,
    opts?: { prefix?: string; limit?: number },
  ): Promise<ListResult> {
    const limit = opts?.limit ?? 100;
    try {
      const blobServiceClient = await this.getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(ref.id);
      const objects: StorageObjectMetadata[] = [];
      const iter = containerClient.listBlobsFlat({
        prefix: opts?.prefix || undefined,
        includeMetadata: true,
      });
      let total = 0;
      let hasMore = false;
      for await (const blob of iter) {
        if (total >= limit) {
          hasMore = true;
          break;
        }
        objects.push({
          name: blob.name,
          size: blob.properties.contentLength ?? 0,
          etag: blob.properties.etag,
          contentType: blob.properties.contentType,
          contentMD5: blob.properties.contentMD5
            ? Buffer.from(blob.properties.contentMD5).toString("hex")
            : undefined,
          createdAt: blob.properties.createdOn ?? undefined,
          lastModified: blob.properties.lastModified ?? undefined,
          metadata: blob.metadata ?? {},
        });
        total++;
      }
      objects.sort(
        (a, b) =>
          (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
      );
      return { objects, hasMore };
    } catch (error) {
      log().error(
        {
          containerName: ref.id,
          prefix: opts?.prefix,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to list backup objects from Azure Storage",
      );
      throw toServiceError(error, "azure");
    }
  }

  async head(
    ref: StorageLocationRef,
    name: string,
  ): Promise<StorageObjectMetadata | null> {
    try {
      const blobServiceClient = await this.getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(ref.id);
      const blobClient = containerClient.getBlobClient(name);
      const props = await blobClient.getProperties();
      return {
        name,
        size: props.contentLength ?? 0,
        etag: props.etag,
        contentType: props.contentType,
        contentMD5: props.contentMD5
          ? Buffer.from(props.contentMD5).toString("hex")
          : undefined,
        createdAt: props.createdOn ?? undefined,
        lastModified: props.lastModified ?? undefined,
        metadata: props.metadata ?? {},
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      // Map Azure 404 to null — head is meant to be cheap & boolean-ish.
      if (message.includes("BlobNotFound") || message.includes("404")) {
        return null;
      }
      log().error(
        { ref, name, error: message },
        "Failed to head Azure blob",
      );
      throw toServiceError(error, "azure");
    }
  }

  async upload(
    ref: StorageLocationRef,
    name: string,
    body: unknown,
    size: number,
    opts?: UploadOptions,
  ): Promise<UploadResult> {
    try {
      const blobServiceClient = await this.getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(ref.id);
      const blockBlobClient = containerClient.getBlockBlobClient(name);

      let uploadResponse;
      if (Buffer.isBuffer(body)) {
        uploadResponse = await blockBlobClient.upload(body, size, {
          blobHTTPHeaders: opts?.contentType
            ? { blobContentType: opts.contentType }
            : undefined,
          metadata: opts?.metadata,
        });
      } else {
        // assume readable stream
        const stream = body as NodeJS.ReadableStream;
        uploadResponse = await blockBlobClient.uploadStream(
          stream as unknown as import("stream").Readable,
          undefined,
          undefined,
          {
            blobHTTPHeaders: opts?.contentType
              ? { blobContentType: opts.contentType }
              : undefined,
            metadata: opts?.metadata,
          },
        );
      }

      return {
        objectUrl: blockBlobClient.url,
        size,
        etag: uploadResponse.etag,
      };
    } catch (error) {
      log().error(
        {
          containerName: ref.id,
          blobName: name,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to upload object to Azure Storage",
      );
      throw toServiceError(error, "azure");
    }
  }

  async getDownloadStream(
    ref: StorageLocationRef,
    name: string,
  ): Promise<DownloadStream> {
    try {
      const blobServiceClient = await this.getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(ref.id);
      const blockBlobClient = containerClient.getBlockBlobClient(name);
      const props = await blockBlobClient.getProperties();
      const downloadResponse = await blockBlobClient.download(0);
      if (!downloadResponse.readableStreamBody) {
        throw new Error("Failed to get download stream");
      }
      return {
        stream: downloadResponse.readableStreamBody,
        contentLength: props.contentLength ?? 0,
        contentType: props.contentType ?? "application/octet-stream",
        fileName: name.split("/").pop() ?? name,
      };
    } catch (error) {
      log().error(
        {
          containerName: ref.id,
          blobName: name,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to download blob from Azure Storage",
      );
      throw toServiceError(error, "azure");
    }
  }

  async getDownloadHandle(
    ref: StorageLocationRef,
    name: string,
    ttlMinutes: number,
  ): Promise<DownloadHandle> {
    const url = await this.generateBlobSasUrl(ref.id, name, ttlMinutes, "read");
    return {
      redirectUrl: url,
      expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
    };
  }

  async mintUploadHandle(
    ref: StorageLocationRef,
    name: string,
    ttlMinutes: number,
  ): Promise<UploadHandle> {
    const sasUrl = await this.generateBlobSasUrl(
      ref.id,
      name,
      ttlMinutes,
      "write",
    );
    return {
      kind: "azure-sas-url",
      payload: { sasUrl, containerName: ref.id, blobName: name },
      expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
    };
  }

  // Note: this overrides the base `delete(key, userId)` with a different
  // signature. Callers that need the base method must use the standalone
  // `removeConfiguration()` helper instead.
  delete(ref: StorageLocationRef, name: string): Promise<void>;
  delete(key: string, userId: string): Promise<void>;
  async delete(
    refOrKey: StorageLocationRef | string,
    nameOrUserId: string,
  ): Promise<void> {
    if (typeof refOrKey === "string") {
      // Base config-level delete (delete a setting by key).
      return super.delete(refOrKey, nameOrUserId);
    }
    const ref = refOrKey;
    const name = nameOrUserId;
    try {
      const blobServiceClient = await this.getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(ref.id);
      const blobClient = containerClient.getBlobClient(name);
      await blobClient.delete();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      // Idempotent: 404 is fine.
      if (message.includes("BlobNotFound") || message.includes("404")) {
        return;
      }
      log().error(
        { ref, name, error: message },
        "Failed to delete Azure blob",
      );
      throw toServiceError(error, "azure");
    }
  }

  // ====================
  // StorageBackend — retention + metadata indexing
  // ====================

  async enforceRetention(
    ref: StorageLocationRef,
    policy: RetentionPolicy,
  ): Promise<RetentionEnforcementResult> {
    try {
      const blobServiceClient = await this.getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(ref.id);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - policy.retentionDays);

      let searchPrefix = policy.pathPrefix ?? "";
      if (policy.databaseName) {
        searchPrefix = searchPrefix
          ? `${searchPrefix}/${policy.databaseName}`
          : policy.databaseName;
      }

      const deletedFiles: string[] = [];
      const errors: string[] = [];
      let totalSizeFreed = 0;

      const iter = containerClient.listBlobsFlat({
        prefix: searchPrefix || undefined,
        includeMetadata: true,
      });

      for await (const blob of iter) {
        const blobDate =
          blob.properties.createdOn ?? blob.properties.lastModified;
        if (blobDate && blobDate < cutoff) {
          try {
            await containerClient.getBlobClient(blob.name).delete();
            deletedFiles.push(blob.name);
            totalSizeFreed += blob.properties.contentLength ?? 0;
          } catch (deleteError) {
            const msg =
              deleteError instanceof Error
                ? deleteError.message
                : "Unknown error";
            errors.push(`Failed to delete ${blob.name}: ${msg}`);
            log().warn(
              { blobName: blob.name, error: msg },
              "Failed to delete blob during retention enforcement",
            );
          }
        }
      }

      log().info(
        {
          containerName: ref.id,
          retentionDays: policy.retentionDays,
          pathPrefix: policy.pathPrefix,
          databaseName: policy.databaseName,
          deletedCount: deletedFiles.length,
          totalSizeFreed,
          errorCount: errors.length,
        },
        "Retention policy enforcement completed",
      );

      return {
        deletedFiles,
        deletedCount: deletedFiles.length,
        totalSizeFreed,
        errors,
      };
    } catch (error) {
      log().error(
        {
          containerName: ref.id,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to enforce retention policy",
      );
      throw toServiceError(error, "azure");
    }
  }

  async indexBackupMetadata(
    ref: StorageLocationRef,
    name: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    try {
      const blobServiceClient = await this.getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(ref.id);
      const blobClient = containerClient.getBlobClient(name);
      const validatedMetadata: Record<string, string> = {};
      for (const [key, value] of Object.entries(metadata)) {
        const validKey = key.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
        const validValue = String(value).substring(0, 8192);
        if (validKey && validValue) validatedMetadata[validKey] = validValue;
      }
      validatedMetadata.indexed_at = new Date().toISOString();
      await blobClient.setMetadata(validatedMetadata);
    } catch (error) {
      log().error(
        {
          containerName: ref.id,
          blobName: name,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to index backup metadata",
      );
      // Match historical behaviour: don't throw on metadata-index failure.
    }
  }

  // ====================
  // Internal: SAS URL helper used by both download and upload handle paths
  // ====================

  private async generateBlobSasUrl(
    containerName: string,
    blobName: string,
    expiryMinutes: number,
    mode: "read" | "write",
  ): Promise<string> {
    const connectionString = await this.getConnectionString();
    if (!connectionString) {
      throw new Error("Azure Storage connection string not configured");
    }
    const { accountName, accountKey } =
      this.parseConnectionStringParts(connectionString);
    const sharedKeyCredential = new StorageSharedKeyCredential(
      accountName,
      accountKey,
    );
    const permissions = new BlobSASPermissions();
    if (mode === "write") {
      permissions.create = true;
      permissions.write = true;
    } else {
      permissions.read = true;
    }
    const startsOn = new Date();
    const expiresOn = new Date(startsOn.getTime() + expiryMinutes * 60 * 1000);
    const sasToken = generateBlobSASQueryParameters(
      {
        containerName,
        blobName,
        permissions,
        startsOn,
        expiresOn,
      },
      sharedKeyCredential,
    ).toString();
    return `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;
  }

  // Used by tests + clean shutdown.
  static cleanupCache(): void {
    if (locationAccessCache) {
      locationAccessCache.flushAll();
      locationAccessCache.close();
    }
  }
}
