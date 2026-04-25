import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// emitToChannel is imported by VaultAdminService to broadcast token-staleness.
// Mock it before the service module loads so we can assert it fires.
const emitToChannel = vi.fn();
vi.mock("../../../lib/socket", () => ({
  emitToChannel: (...args: unknown[]) => emitToChannel(...args),
}));

import { VaultAdminService } from "../vault-admin-service";
import { VaultHttpClient } from "../vault-http-client";
import type { OperatorPassphraseService } from "../../../lib/operator-passphrase-service";
import type { VaultStateService } from "../vault-state-service";
import type { PrismaClient } from "../../../lib/prisma";

function mkPassphrase(unlocked: boolean): OperatorPassphraseService {
  return {
    isUnlocked: () => unlocked,
  } as unknown as OperatorPassphraseService;
}

function mkStateService(): VaultStateService {
  return {
    readAdminRoleId: vi.fn().mockResolvedValue("role-id-1"),
    readAdminSecretId: vi.fn().mockResolvedValue("secret-id-1"),
  } as unknown as VaultStateService;
}

function mkPrisma(): PrismaClient {
  return {} as unknown as PrismaClient;
}

describe("VaultAdminService — admin token renewal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    emitToChannel.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("schedules a renewal at half the lease duration after authenticateAsAdmin", async () => {
    const renewSelf = vi.fn().mockResolvedValue({
      auth: { client_token: "renewed", lease_duration: 3600, renewable: true },
    });
    const appRoleLogin = vi.fn().mockResolvedValue({
      auth: { client_token: "fresh", lease_duration: 3600, renewable: true },
    });
    const setToken = vi.fn();
    const fakeClient = {
      appRoleLogin,
      renewSelf,
      setToken,
      clearToken: vi.fn(),
    } as unknown as VaultHttpClient;

    const svc = new VaultAdminService(
      mkPrisma(),
      mkPassphrase(true),
      mkStateService(),
    );
    // Inject a stub client without going through the real fetch path.
    (svc as unknown as { client: VaultHttpClient }).client = fakeClient;

    await svc.authenticateAsAdmin();

    expect(setToken).toHaveBeenCalledWith("fresh");
    expect(renewSelf).not.toHaveBeenCalled();

    // half of 3600s = 1800s = 1_800_000ms
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(renewSelf).toHaveBeenCalledTimes(1);

    // Renewing reschedules the next renewal at half the new lease.
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(renewSelf).toHaveBeenCalledTimes(2);

    svc.destroy();
  });

  it("drops the cached token and emits VAULT_STATUS_CHANGED on renewal failure", async () => {
    const renewSelf = vi
      .fn()
      .mockRejectedValue(new Error("permission denied"));
    const appRoleLogin = vi.fn().mockResolvedValue({
      auth: { client_token: "fresh", lease_duration: 3600, renewable: true },
    });
    const setToken = vi.fn();
    const clearToken = vi.fn();
    const fakeClient = {
      appRoleLogin,
      renewSelf,
      setToken,
      clearToken,
    } as unknown as VaultHttpClient;

    const svc = new VaultAdminService(
      mkPrisma(),
      mkPassphrase(true),
      mkStateService(),
    );
    (svc as unknown as { client: VaultHttpClient }).client = fakeClient;

    await svc.authenticateAsAdmin();
    expect(svc.hasAdminToken()).toBe(true);

    await vi.advanceTimersByTimeAsync(1_800_000);
    // Allow the renewSelfTick microtask + catch handlers to settle.
    await vi.runOnlyPendingTimersAsync();

    expect(svc.hasAdminToken()).toBe(false);
    expect(clearToken).toHaveBeenCalled();
    expect(emitToChannel).toHaveBeenCalledWith(
      "vault",
      "vault:status:changed",
      expect.objectContaining({ adminTokenStale: true }),
    );

    svc.destroy();
  });

  it("getAuthenticatedClient re-authenticates when the cached token is missing", async () => {
    const appRoleLogin = vi.fn().mockResolvedValue({
      auth: { client_token: "rebuilt", lease_duration: 3600, renewable: true },
    });
    const setToken = vi.fn();
    const fakeClient = {
      appRoleLogin,
      renewSelf: vi.fn(),
      setToken,
      clearToken: vi.fn(),
    } as unknown as VaultHttpClient;

    const svc = new VaultAdminService(
      mkPrisma(),
      mkPassphrase(true),
      mkStateService(),
    );
    (svc as unknown as { client: VaultHttpClient }).client = fakeClient;

    expect(svc.hasAdminToken()).toBe(false);

    const client = await svc.getAuthenticatedClient();
    expect(client).toBe(fakeClient);
    expect(appRoleLogin).toHaveBeenCalledTimes(1);
    expect(svc.hasAdminToken()).toBe(true);

    svc.destroy();
  });

  it("getAuthenticatedClient returns the cached client without re-auth when token is present", async () => {
    const appRoleLogin = vi.fn().mockResolvedValue({
      auth: { client_token: "fresh", lease_duration: 3600, renewable: true },
    });
    const fakeClient = {
      appRoleLogin,
      renewSelf: vi.fn(),
      setToken: vi.fn(),
      clearToken: vi.fn(),
    } as unknown as VaultHttpClient;

    const svc = new VaultAdminService(
      mkPrisma(),
      mkPassphrase(true),
      mkStateService(),
    );
    (svc as unknown as { client: VaultHttpClient }).client = fakeClient;

    await svc.authenticateAsAdmin();
    expect(appRoleLogin).toHaveBeenCalledTimes(1);

    await svc.getAuthenticatedClient();
    expect(appRoleLogin).toHaveBeenCalledTimes(1); // not called again

    svc.destroy();
  });
});
