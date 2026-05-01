/**
 * Singleton facade in front of the pluggable storage backend.
 *
 * Reads `(category="storage", key="active_provider")` to figure out which
 * backend the operator picked. `getActiveBackend()` returns that backend (or
 * throws `STORAGE_NOT_CONFIGURED` if none is set); `getBackendByProviderId()`
 * resolves a specific provider regardless of which one is currently active —
 * used at restore time when a backup row references the provider it was
 * created under via `storageProviderAtCreation`.
 *
 * Connectivity rows are recorded by the active backend under
 * `service="storage"` (not under any provider-specific service name).
 */

import type {
  StorageBackend,
  StorageProviderId,
} from "@mini-infra/types";
import { STORAGE_PROVIDER_IDS } from "@mini-infra/types";
import prismaDefault, { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";
import { StorageServiceFactory } from "./storage-service-factory";
import { AzureStorageBackend } from "./providers/azure/azure-storage-backend";
import { GoogleDriveBackend } from "./providers/google-drive/google-drive-backend";
import { GoogleDriveTokenManager } from "./providers/google-drive/google-drive-token-manager";
import {
  buildGoogleDriveRedirectUri,
  GOOGLE_DRIVE_OAUTH_CALLBACK_PATH,
} from "./providers/google-drive/google-drive-redirect";

// Register built-in providers eagerly. Phase 1 is Azure-only; Phase 3 lands
// the Drive backend.
StorageServiceFactory.register(
  "azure",
  (prisma) => new AzureStorageBackend(prisma),
);
StorageServiceFactory.register("google-drive", (prisma) => {
  const tokens = new GoogleDriveTokenManager(prisma);
  return new GoogleDriveBackend(prisma, tokens, () =>
    buildGoogleDriveRedirectUri(),
  );
});

// Re-export for the OAuth route + tests.
export { GOOGLE_DRIVE_OAUTH_CALLBACK_PATH };

const log = () => getLogger("platform", "storage-service");

const STORAGE_CATEGORY = "storage" as const;
const ACTIVE_PROVIDER_KEY = "active_provider";

export class StorageNotConfiguredError extends Error {
  readonly code = "STORAGE_NOT_CONFIGURED";
  constructor(message = "No storage provider is configured") {
    super(message);
    this.name = "StorageNotConfiguredError";
  }
}

export class StorageProviderUnregisteredError extends Error {
  readonly code = "STORAGE_PROVIDER_UNREGISTERED";
  constructor(providerId: string) {
    super(`Storage provider '${providerId}' is not registered in this build`);
    this.name = "StorageProviderUnregisteredError";
  }
}

/**
 * Thrown when a backup row asks to be restored from a provider whose config
 * has been wiped (e.g. via `POST /api/storage/:provider/forget?force=true`).
 * Surfaced to callers so route handlers can map this to a friendly 409 with
 * a "reconnect <provider> or pick a different backup" message instead of
 * letting the underlying SDK fail with an opaque auth error.
 */
export class ProviderNoLongerConfiguredError extends Error {
  readonly code = "PROVIDER_NO_LONGER_CONFIGURED";
  readonly providerId: StorageProviderId;
  constructor(providerId: StorageProviderId) {
    super(
      `Original provider '${providerId}' is no longer configured. Reconnect ${providerId} or pick a different backup.`,
    );
    this.providerId = providerId;
    this.name = "ProviderNoLongerConfiguredError";
  }
}

function isKnownProviderId(value: string): value is StorageProviderId {
  return (STORAGE_PROVIDER_IDS as readonly string[]).includes(value);
}

export class StorageService {
  private static instance: StorageService | null = null;
  private prisma: PrismaClient;
  // Backend instances are cached per provider id. They're stateless across
  // calls (config is re-read on each operation), so caching them is safe.
  private backendCache = new Map<StorageProviderId, StorageBackend>();

  private constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  static getInstance(prisma?: PrismaClient): StorageService {
    if (!StorageService.instance) {
      StorageService.instance = new StorageService(prisma ?? prismaDefault);
    }
    return StorageService.instance;
  }

  /** Test hook — drop the singleton between unit tests. */
  static _resetForTests(): void {
    StorageService.instance = null;
  }

  /** Return the provider id the operator has currently selected, or null. */
  async getActiveProviderId(): Promise<StorageProviderId | null> {
    const setting = await this.prisma.systemSettings.findUnique({
      where: {
        category_key: {
          category: STORAGE_CATEGORY,
          key: ACTIVE_PROVIDER_KEY,
        },
      },
    });
    if (!setting?.value) return null;
    if (!isKnownProviderId(setting.value)) {
      log().warn(
        { value: setting.value },
        "Unknown active storage provider id in settings; ignoring",
      );
      return null;
    }
    return setting.value;
  }

  /**
   * Persist the active provider selection. The caller is responsible for
   * ensuring the chosen provider's per-provider config is in place before
   * writing this — `StorageService` never silently auto-migrates rows.
   */
  async setActiveProviderId(
    providerId: StorageProviderId,
    userId: string,
  ): Promise<void> {
    if (!StorageServiceFactory.isRegistered(providerId)) {
      throw new StorageProviderUnregisteredError(providerId);
    }
    await this.prisma.systemSettings.upsert({
      where: {
        category_key: {
          category: STORAGE_CATEGORY,
          key: ACTIVE_PROVIDER_KEY,
        },
      },
      update: {
        value: providerId,
        updatedBy: userId,
        updatedAt: new Date(),
      },
      create: {
        category: STORAGE_CATEGORY,
        key: ACTIVE_PROVIDER_KEY,
        value: providerId,
        createdBy: userId,
        updatedBy: userId,
        isEncrypted: false,
        isActive: true,
      },
    });
  }

  /** Returns the backend matching the operator's active selection. */
  async getActiveBackend(): Promise<StorageBackend> {
    const providerId = await this.getActiveProviderId();
    if (!providerId) throw new StorageNotConfiguredError();
    return this.getBackendByProviderId(providerId);
  }

  /**
   * Return a backend regardless of which provider is currently active. Used at
   * restore time to read a row whose `storageProviderAtCreation` differs from
   * the active provider — works as long as the older provider's config still
   * exists in `system_settings`.
   */
  getBackendByProviderId(providerId: StorageProviderId): StorageBackend {
    const cached = this.backendCache.get(providerId);
    if (cached) return cached;
    const factory = StorageServiceFactory.getFactory(providerId);
    if (!factory) throw new StorageProviderUnregisteredError(providerId);
    const backend = factory(this.prisma);
    this.backendCache.set(providerId, backend);
    return backend;
  }

  /** Best-effort liveness check — used by health and connectivity endpoints. */
  async isConfigured(): Promise<boolean> {
    return (await this.getActiveProviderId()) !== null;
  }

  /**
   * Cheap "is this provider's config still on disk?" check. Reads any one
   * `(category="storage-{providerId}")` row — presence is enough to know
   * the operator hasn't yet hit "Disconnect <provider> entirely". Avoids a
   * `getHealthStatus()` round-trip (which talks to the upstream SDK) so the
   * restore route can fail fast on a forgotten provider before any network
   * I/O is attempted.
   */
  async isProviderConfigured(providerId: StorageProviderId): Promise<boolean> {
    const row = await this.prisma.systemSettings.findFirst({
      where: { category: `storage-${providerId}` },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Like `getBackendByProviderId`, but throws `ProviderNoLongerConfiguredError`
   * if the provider's config rows have been wiped. Used by restore handlers so
   * "I forgot Azure last week and now I'm trying to restore an old Azure backup"
   * surfaces a friendly error instead of an opaque SDK auth failure.
   */
  async getBackendByProviderIdOrThrow(
    providerId: StorageProviderId,
  ): Promise<StorageBackend> {
    if (!(await this.isProviderConfigured(providerId))) {
      throw new ProviderNoLongerConfiguredError(providerId);
    }
    return this.getBackendByProviderId(providerId);
  }
}

/** Convenience helper for resolving the storage location id for a slot. */
export const STORAGE_LOCATION_KEYS = {
  POSTGRES_BACKUP: "locations.postgres_backup",
  SELF_BACKUP: "locations.self_backup",
  TLS_CERTIFICATES: "locations.tls_certificates",
} as const;

export type StorageLocationSlot =
  (typeof STORAGE_LOCATION_KEYS)[keyof typeof STORAGE_LOCATION_KEYS];
