import type { PrismaClient } from "../../lib/prisma";
import {
  getOperatorPassphraseService,
  OperatorPassphraseService,
} from "../../lib/operator-passphrase-service";
import { VaultStateService } from "./vault-state-service";
import { VaultAdminService } from "./vault-admin-service";
import { VaultHealthWatcher } from "./vault-health-watcher";

/**
 * Singleton container wiring all Vault-related services together. Held on a
 * module-level registry so routes and schedulers can reach it without
 * dependency-injection plumbing every call site.
 */
export interface VaultServices {
  prisma: PrismaClient;
  passphrase: OperatorPassphraseService;
  stateService: VaultStateService;
  admin: VaultAdminService;
  healthWatcher: VaultHealthWatcher;
}

let services: VaultServices | null = null;

export function initVaultServices(prisma: PrismaClient): VaultServices {
  if (services) return services;
  const passphrase = getOperatorPassphraseService(prisma);
  const stateService = new VaultStateService(prisma, passphrase);
  const admin = new VaultAdminService(prisma, passphrase, stateService);
  const healthWatcher = new VaultHealthWatcher(passphrase, admin, stateService);
  services = { prisma, passphrase, stateService, admin, healthWatcher };
  return services;
}

export function getVaultServices(): VaultServices {
  if (!services) {
    throw new Error(
      "Vault services have not been initialised — call initVaultServices(prisma) first",
    );
  }
  return services;
}

export function vaultServicesReady(): boolean {
  return services !== null;
}

/** Test-only: reset singleton. */
export function __resetVaultServicesForTests(): void {
  if (services) {
    try {
      services.healthWatcher.stop();
    } catch {
      /* ignore */
    }
  }
  services = null;
}
