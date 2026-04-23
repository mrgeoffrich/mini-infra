import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  VaultCredentialInjector,
  DEFAULT_WRAPPED_SECRET_ID_TTL_SECONDS,
} from "../vault-credential-injector";
import type { StackContainerConfig } from "@mini-infra/types";

// Mock the vault-services module before importing the injector users.
vi.mock("../vault-services", () => {
  return {
    getVaultServices: vi.fn(),
    vaultServicesReady: () => true,
  };
});

import { getVaultServices } from "../vault-services";

function mkPrisma(approle: {
  id: string;
  name: string;
  cachedRoleId: string | null;
} | null) {
  return {
    vaultAppRole: {
      findUnique: vi.fn().mockResolvedValue(approle),
      update: vi.fn().mockResolvedValue(approle),
    },
  } as unknown as import("../../../generated/prisma/client").PrismaClient;
}

const LOG = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as import("pino").Logger;

describe("VaultCredentialInjector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when containerConfig has no dynamicEnv", async () => {
    const injector = new VaultCredentialInjector(mkPrisma(null));
    const out = await injector.resolve(
      { appRoleId: "ar-1", failClosed: true, prevBoundAppRoleId: null },
      { env: { FOO: "bar" } } as StackContainerConfig,
    );
    expect(out).toBeNull();
  });

  it("mints a wrapped secret_id and fills in role_id when Vault is reachable", async () => {
    const readAppRoleId = vi.fn().mockResolvedValue("role-xyz");
    const mintWrapped = vi
      .fn()
      .mockResolvedValue({ wrap_info: { token: "wrapping-token" } });

    (getVaultServices as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      admin: {
        getClient: () => ({
          readAppRoleId,
          mintWrappedAppRoleSecretId: mintWrapped,
        }),
      },
      stateService: {
        getMeta: async () => ({
          initialised: true,
          initialisedAt: new Date(),
          bootstrappedAt: new Date(),
          address: "http://vault:8200",
          stackId: null,
        }),
      },
    });

    const injector = new VaultCredentialInjector(
      mkPrisma({ id: "ar-1", name: "my-app", cachedRoleId: null }),
    );

    const containerConfig: StackContainerConfig = {
      dynamicEnv: {
        VAULT_ADDR: { kind: "vault-addr" },
        VAULT_ROLE_ID: { kind: "vault-role-id" },
        VAULT_WRAPPED_SECRET_ID: { kind: "vault-wrapped-secret-id" },
      },
    };

    const res = await injector.resolve(
      { appRoleId: "ar-1", failClosed: true, prevBoundAppRoleId: null },
      containerConfig,
    );
    expect(res).not.toBeNull();
    expect(res!.values).toEqual({
      VAULT_ADDR: "http://vault:8200",
      VAULT_ROLE_ID: "role-xyz",
      VAULT_WRAPPED_SECRET_ID: "wrapping-token",
    });
    expect(res!.degraded).toBe(false);
    expect(readAppRoleId).toHaveBeenCalledWith("my-app");
    expect(mintWrapped).toHaveBeenCalledWith(
      "my-app",
      DEFAULT_WRAPPED_SECRET_ID_TTL_SECONDS,
    );
  });

  it("fail-closed without stable prior binding throws when Vault unreachable", async () => {
    const readAppRoleId = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const mintWrapped = vi.fn();

    (getVaultServices as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      admin: {
        getClient: () => ({
          readAppRoleId,
          mintWrappedAppRoleSecretId: mintWrapped,
        }),
      },
      stateService: {
        getMeta: async () => ({
          initialised: true,
          initialisedAt: new Date(),
          bootstrappedAt: new Date(),
          address: "http://vault:8200",
          stackId: null,
        }),
      },
    });

    const injector = new VaultCredentialInjector(
      mkPrisma({ id: "ar-1", name: "my-app", cachedRoleId: null }),
    );

    const containerConfig: StackContainerConfig = {
      dynamicEnv: {
        VAULT_ROLE_ID: { kind: "vault-role-id" },
      },
    };

    await expect(
      injector.resolve(
        { appRoleId: "ar-1", failClosed: true, prevBoundAppRoleId: null },
        containerConfig,
      ),
    ).rejects.toThrow(/cannot apply in fail-closed mode/i);
  });

  it("fail-closed with stable prior binding degrades (role_id only) when Vault unreachable", async () => {
    const readAppRoleId = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const mintWrapped = vi.fn();

    (getVaultServices as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      admin: {
        getClient: () => ({
          readAppRoleId,
          mintWrappedAppRoleSecretId: mintWrapped,
        }),
      },
      stateService: {
        getMeta: async () => ({
          initialised: true,
          initialisedAt: new Date(),
          bootstrappedAt: new Date(),
          address: "http://vault:8200",
          stackId: null,
        }),
      },
    });

    const injector = new VaultCredentialInjector(
      mkPrisma({ id: "ar-1", name: "my-app", cachedRoleId: "cached-role-id" }),
    );

    const containerConfig: StackContainerConfig = {
      dynamicEnv: {
        VAULT_ADDR: { kind: "vault-addr" },
        VAULT_ROLE_ID: { kind: "vault-role-id" },
        VAULT_WRAPPED_SECRET_ID: { kind: "vault-wrapped-secret-id" },
      },
    };

    const res = await injector.resolve(
      { appRoleId: "ar-1", failClosed: true, prevBoundAppRoleId: "ar-1" },
      containerConfig,
    );
    expect(res).not.toBeNull();
    expect(res!.degraded).toBe(true);
    expect(res!.values.VAULT_ADDR).toBe("http://vault:8200");
    expect(res!.values.VAULT_ROLE_ID).toBe("cached-role-id");
    expect(res!.values.VAULT_WRAPPED_SECRET_ID).toBeUndefined();
  });

  it("fail-closed rejects when binding changed since last apply", async () => {
    // Client is null → Vault is effectively unreachable — exercises the
    // degrade path. Binding has changed (ar-new vs ar-old), so we fail-closed.
    (getVaultServices as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      admin: { getClient: () => null },
      stateService: {
        getMeta: async () => ({
          initialised: true,
          initialisedAt: new Date(),
          bootstrappedAt: new Date(),
          address: "http://vault:8200",
          stackId: null,
        }),
      },
    });

    const injector = new VaultCredentialInjector(
      mkPrisma({ id: "ar-new", name: "my-app", cachedRoleId: "cached-role-id" }),
    );

    const containerConfig: StackContainerConfig = {
      dynamicEnv: { VAULT_ROLE_ID: { kind: "vault-role-id" } },
    };

    await expect(
      injector.resolve(
        { appRoleId: "ar-new", failClosed: true, prevBoundAppRoleId: "ar-old" },
        containerConfig,
      ),
    ).rejects.toThrow(/cannot apply in fail-closed mode/i);
  });
});
