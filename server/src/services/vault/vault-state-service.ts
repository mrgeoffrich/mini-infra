import { PrismaClient } from "../../lib/prisma";
import { OperatorPassphraseService } from "../../lib/operator-passphrase-service";
import { toPrismaBytes } from "../../lib/crypto";
import { getLogger } from "../../lib/logger-factory";

const log = getLogger("platform", "vault-state-service");

const VAULT_STATE_KIND = "primary";

/**
 * Wraps reads/writes to the singleton VaultState row.
 *
 * All secret material is wrapped/unwrapped via the operator passphrase service.
 * Callers MUST check `passphrase.isUnlocked()` before calling any method that
 * returns decrypted material — this service throws an error when locked.
 */
export class VaultStateService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly passphrase: OperatorPassphraseService,
  ) {}

  async exists(): Promise<boolean> {
    const row = await this.prisma.vaultState.findUnique({
      where: { kind: VAULT_STATE_KIND },
    });
    return row !== null;
  }

  async isBootstrapped(): Promise<boolean> {
    const row = await this.prisma.vaultState.findUnique({
      where: { kind: VAULT_STATE_KIND },
      select: { bootstrappedAt: true },
    });
    return row?.bootstrappedAt != null;
  }

  async getMeta(): Promise<{
    initialised: boolean;
    initialisedAt: Date | null;
    bootstrappedAt: Date | null;
    address: string | null;
    stackId: string | null;
  } | null> {
    const row = await this.prisma.vaultState.findUnique({
      where: { kind: VAULT_STATE_KIND },
      select: {
        initialised: true,
        initialisedAt: true,
        bootstrappedAt: true,
        address: true,
        stackId: true,
      },
    });
    if (!row) return null;
    return {
      initialised: row.initialised,
      initialisedAt: row.initialisedAt,
      bootstrappedAt: row.bootstrappedAt,
      address: row.address,
      stackId: row.stackId,
    };
  }

  async setAddress(address: string): Promise<void> {
    await this.prisma.vaultState.upsert({
      where: { kind: VAULT_STATE_KIND },
      create: { kind: VAULT_STATE_KIND, address },
      update: { address },
    });
  }

  async setStackId(stackId: string | null): Promise<void> {
    await this.prisma.vaultState.upsert({
      where: { kind: VAULT_STATE_KIND },
      create: { kind: VAULT_STATE_KIND, stackId },
      update: { stackId },
    });
  }

  /**
   * Persist the init output (unseal keys + root token), wrapping with the
   * operator passphrase. Requires passphrase to be unlocked.
   */
  async persistInitResult(params: {
    unsealKeys: string[];
    rootToken: string;
  }): Promise<void> {
    const wrappedKeys = toPrismaBytes(
      this.passphrase.wrap(
        Buffer.from(JSON.stringify(params.unsealKeys), "utf8"),
      ),
    );
    const wrappedRoot = toPrismaBytes(
      this.passphrase.wrap(Buffer.from(params.rootToken, "utf8")),
    );
    await this.prisma.vaultState.upsert({
      where: { kind: VAULT_STATE_KIND },
      create: {
        kind: VAULT_STATE_KIND,
        initialised: true,
        initialisedAt: new Date(),
        encryptedUnsealKeys: wrappedKeys,
        encryptedRootToken: wrappedRoot,
      },
      update: {
        initialised: true,
        initialisedAt: new Date(),
        encryptedUnsealKeys: wrappedKeys,
        encryptedRootToken: wrappedRoot,
      },
    });
    log.info("Persisted encrypted init result (unseal keys + root token)");
  }

  async readUnsealKeys(): Promise<string[]> {
    const row = await this.prisma.vaultState.findUnique({
      where: { kind: VAULT_STATE_KIND },
      select: { encryptedUnsealKeys: true },
    });
    if (!row?.encryptedUnsealKeys) {
      throw new Error("VaultState has no unseal keys stored");
    }
    const plain = this.passphrase.unwrap(Buffer.from(row.encryptedUnsealKeys));
    return JSON.parse(plain.toString("utf8")) as string[];
  }

  async readRootToken(): Promise<string> {
    const row = await this.prisma.vaultState.findUnique({
      where: { kind: VAULT_STATE_KIND },
      select: { encryptedRootToken: true },
    });
    if (!row?.encryptedRootToken) {
      throw new Error("VaultState has no root token stored");
    }
    return this.passphrase.unwrap(Buffer.from(row.encryptedRootToken)).toString("utf8");
  }

  async clearRootToken(): Promise<void> {
    await this.prisma.vaultState.update({
      where: { kind: VAULT_STATE_KIND },
      data: { encryptedRootToken: null },
    });
    log.info("Cleared stored root token (rotated during bootstrap)");
  }

  async persistAdminAppRole(roleId: string, secretId: string): Promise<void> {
    const wrappedRole = toPrismaBytes(
      this.passphrase.wrap(Buffer.from(roleId, "utf8")),
    );
    const wrappedSecret = toPrismaBytes(
      this.passphrase.wrap(Buffer.from(secretId, "utf8")),
    );
    await this.prisma.vaultState.update({
      where: { kind: VAULT_STATE_KIND },
      data: {
        encryptedAdminRoleId: wrappedRole,
        encryptedAdminSecretId: wrappedSecret,
        encryptedAdminSecretIdAt: new Date(),
      },
    });
    log.info("Persisted encrypted mini-infra-admin AppRole credentials");
  }

  async readAdminRoleId(): Promise<string> {
    const row = await this.prisma.vaultState.findUnique({
      where: { kind: VAULT_STATE_KIND },
      select: { encryptedAdminRoleId: true },
    });
    if (!row?.encryptedAdminRoleId) {
      throw new Error("VaultState has no admin role_id stored");
    }
    return this.passphrase.unwrap(Buffer.from(row.encryptedAdminRoleId)).toString("utf8");
  }

  async readAdminSecretId(): Promise<string> {
    const row = await this.prisma.vaultState.findUnique({
      where: { kind: VAULT_STATE_KIND },
      select: { encryptedAdminSecretId: true },
    });
    if (!row?.encryptedAdminSecretId) {
      throw new Error("VaultState has no admin secret_id stored");
    }
    return this.passphrase.unwrap(Buffer.from(row.encryptedAdminSecretId)).toString("utf8");
  }

  async persistOperatorPassword(password: string): Promise<void> {
    const wrapped = toPrismaBytes(
      this.passphrase.wrap(Buffer.from(password, "utf8")),
    );
    await this.prisma.vaultState.update({
      where: { kind: VAULT_STATE_KIND },
      data: { encryptedOperatorPassword: wrapped },
    });
    log.info("Persisted encrypted mini-infra-operator userpass password");
  }

  async readOperatorPassword(): Promise<string | null> {
    const row = await this.prisma.vaultState.findUnique({
      where: { kind: VAULT_STATE_KIND },
      select: { encryptedOperatorPassword: true },
    });
    if (!row?.encryptedOperatorPassword) return null;
    return this.passphrase
      .unwrap(Buffer.from(row.encryptedOperatorPassword))
      .toString("utf8");
  }

  async markBootstrapped(): Promise<void> {
    await this.prisma.vaultState.update({
      where: { kind: VAULT_STATE_KIND },
      data: { bootstrappedAt: new Date() },
    });
  }
}
