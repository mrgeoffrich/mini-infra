/**
 * Storage backend registry.
 *
 * Concrete `StorageBackend` implementations register their constructor here at
 * import time; `StorageService` reads the active provider id from settings and
 * instantiates the matching factory.
 *
 * Adding a new provider is a 3-line drop-in:
 *
 *     import { GoogleDriveStorageBackend } from "./providers/google-drive/google-drive-backend";
 *     StorageServiceFactory.register("google-drive", (prisma) => new GoogleDriveStorageBackend(prisma));
 */

import type { StorageBackend, StorageProviderId } from "@mini-infra/types";
import type { PrismaClient } from "../../lib/prisma";

export type StorageBackendFactory = (prisma: PrismaClient) => StorageBackend;

export class StorageServiceFactory {
  private static registry = new Map<StorageProviderId, StorageBackendFactory>();

  /** Register a backend constructor for a provider id. */
  static register(
    providerId: StorageProviderId,
    factory: StorageBackendFactory,
  ): void {
    this.registry.set(providerId, factory);
  }

  /** Look up a registered factory by id; returns undefined if absent. */
  static getFactory(
    providerId: StorageProviderId,
  ): StorageBackendFactory | undefined {
    return this.registry.get(providerId);
  }

  /** True if a backend has been registered for `providerId`. */
  static isRegistered(providerId: StorageProviderId): boolean {
    return this.registry.has(providerId);
  }

  /** All registered provider ids — used by health/listing endpoints. */
  static listProviders(): StorageProviderId[] {
    return Array.from(this.registry.keys());
  }

  /** Test hook only. Production code does not unregister. */
  static _resetForTests(): void {
    this.registry.clear();
  }
}
