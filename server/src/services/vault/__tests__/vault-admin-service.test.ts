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

  it("re-issues the admin token via AppRole login when renewal fails", async () => {
    // Renewal returning "permission denied" usually means the cached token
    // expired. The service should fall back to a fresh AppRole login so the
    // next admin op succeeds without manual intervention.
    const renewSelf = vi
      .fn()
      .mockRejectedValue(new Error("permission denied"));
    const appRoleLogin = vi
      .fn()
      .mockResolvedValueOnce({
        auth: { client_token: "initial", lease_duration: 3600, renewable: true },
      })
      .mockResolvedValueOnce({
        auth: { client_token: "rebuilt", lease_duration: 3600, renewable: true },
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

    // Trigger the half-lease renewal timer — renewal will fail, re-login
    // succeeds. Don't drain further timers (the recovery path schedules
    // another renewal at +1800s which we don't want to chain into).
    await vi.advanceTimersByTimeAsync(1_800_000);
    await vi.advanceTimersByTimeAsync(0);

    // Renewal failed → AppRole login was re-invoked → token is live again.
    expect(appRoleLogin).toHaveBeenCalledTimes(2);
    expect(setToken).toHaveBeenLastCalledWith("rebuilt");
    expect(svc.hasAdminToken()).toBe(true);
    // Stale-token event NOT emitted — we recovered without operator action.
    expect(emitToChannel).not.toHaveBeenCalledWith(
      "vault",
      "vault:status:changed",
      expect.objectContaining({ adminTokenStale: true }),
    );

    svc.destroy();
  });

  it("drops the cached token and emits VAULT_STATUS_CHANGED when both renewal and re-login fail", async () => {
    const renewSelf = vi
      .fn()
      .mockRejectedValue(new Error("permission denied"));
    const appRoleLogin = vi
      .fn()
      .mockResolvedValueOnce({
        auth: { client_token: "initial", lease_duration: 3600, renewable: true },
      })
      .mockRejectedValueOnce(new Error("invalid secret_id"));
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

  it("does not schedule a renewal timer when the token is non-renewable", async () => {
    const appRoleLogin = vi.fn().mockResolvedValue({
      auth: {
        client_token: "fresh",
        lease_duration: 3600,
        renewable: false,
      },
    });
    const renewSelf = vi.fn();
    const fakeClient = {
      appRoleLogin,
      renewSelf,
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
    expect(svc.hasAdminToken()).toBe(true);

    // Advance well past the half-lease point — renewSelf must NOT fire.
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(renewSelf).not.toHaveBeenCalled();

    svc.destroy();
  });

  it("does not schedule a follow-up renewal when both renewal and re-login fail", async () => {
    const renewSelf = vi
      .fn()
      .mockRejectedValue(new Error("permission denied"));
    const appRoleLogin = vi
      .fn()
      .mockResolvedValueOnce({
        auth: { client_token: "initial", lease_duration: 3600, renewable: true },
      })
      .mockRejectedValueOnce(new Error("invalid secret_id"));
    const fakeClient = {
      appRoleLogin,
      renewSelf,
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
    await vi.advanceTimersByTimeAsync(1_800_000);
    await vi.runOnlyPendingTimersAsync();
    expect(renewSelf).toHaveBeenCalledTimes(1);

    // Both paths failed → token dropped, no further timer scheduled.
    expect(svc.hasAdminToken()).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(renewSelf).toHaveBeenCalledTimes(1);

    svc.destroy();
  });

  it("serialises a manual reauthenticate against an in-flight renewal", async () => {
    // Simulates the race: renewSelf is awaiting Vault when the operator hits
    // POST /admin/reauthenticate. The manual auth must wait for the renewal
    // to settle and then either skip (if renewal succeeded) or run.
    let resolveRenew: (val: unknown) => void = () => {};
    const renewSelfPromise = new Promise((resolve) => {
      resolveRenew = resolve;
    });
    const renewSelf = vi.fn().mockReturnValue(renewSelfPromise);
    const appRoleLogin = vi.fn().mockResolvedValue({
      auth: { client_token: "fresh", lease_duration: 3600, renewable: true },
    });
    const fakeClient = {
      appRoleLogin,
      renewSelf,
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

    // Trigger the renewal tick — this hangs because we never resolve.
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(renewSelf).toHaveBeenCalledTimes(1);

    // Kick off a manual re-auth. It must NOT race with the in-flight renewal.
    const reauthPromise = svc.authenticateAsAdmin();
    // Give the event loop a chance — appRoleLogin should still be at 1.
    await Promise.resolve();
    expect(appRoleLogin).toHaveBeenCalledTimes(1);

    // Now resolve the renewal. The manual reauth sees a live token and skips
    // the second login.
    resolveRenew({
      auth: { client_token: "renewed", lease_duration: 3600, renewable: true },
    });
    await reauthPromise;
    expect(appRoleLogin).toHaveBeenCalledTimes(1);

    svc.destroy();
  });
});
