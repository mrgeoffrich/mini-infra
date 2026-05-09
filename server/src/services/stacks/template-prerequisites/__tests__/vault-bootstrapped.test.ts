/**
 * Unit tests for the `vault-bootstrapped` predicate. Stubs
 * vault-services so we can exercise the four state cells:
 *   - vaultServicesReady() === false                  → not initialised
 *   - bootstrappedAt == null                          → not bootstrapped
 *   - bootstrappedAt != null + state !== "unlocked"   → locked
 *   - bootstrappedAt != null + state === "unlocked"   → ok
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const fakeVault = vi.hoisted(() => ({
  ready: true,
  bootstrappedAt: null as Date | null,
  passphraseState: "uninitialised" as "uninitialised" | "locked" | "unlocked",
}));

vi.mock("../../../vault/vault-services", () => ({
  vaultServicesReady: () => fakeVault.ready,
  getVaultServices: () => ({
    stateService: {
      getMeta: async () => ({
        initialised: true,
        initialisedAt: null,
        bootstrappedAt: fakeVault.bootstrappedAt,
        address: null,
        stackId: null,
      }),
    },
    passphrase: {
      getState: () => fakeVault.passphraseState,
    },
  }),
}));

import { vaultBootstrappedPredicate } from "../predicates/vault-bootstrapped";
import type { PredicateContext } from "../predicates/types";

const ctx: PredicateContext = { prisma: {} as PredicateContext["prisma"] };

describe("vault-bootstrapped predicate", () => {
  beforeEach(() => {
    fakeVault.ready = true;
    fakeVault.bootstrappedAt = null;
    fakeVault.passphraseState = "uninitialised";
  });

  it("fails with no helpAction when vault services aren't initialised", async () => {
    fakeVault.ready = false;
    const r = await vaultBootstrappedPredicate(ctx);
    expect(r.ok).toBe(false);
    expect(r.helpAction).toBeUndefined();
    expect(r.reason).toMatch(/not initialised/i);
  });

  it("fails with open-vault-bootstrap action when bootstrappedAt is null", async () => {
    fakeVault.bootstrappedAt = null;
    fakeVault.passphraseState = "uninitialised";
    const r = await vaultBootstrappedPredicate(ctx);
    expect(r.ok).toBe(false);
    expect(r.helpAction).toEqual({ type: "open-vault-bootstrap" });
    expect(r.reason).toMatch(/not been bootstrapped/i);
  });

  it("fails with open-vault-bootstrap action when bootstrapped but passphrase locked", async () => {
    fakeVault.bootstrappedAt = new Date();
    fakeVault.passphraseState = "locked";
    const r = await vaultBootstrappedPredicate(ctx);
    expect(r.ok).toBe(false);
    expect(r.helpAction).toEqual({ type: "open-vault-bootstrap" });
    expect(r.reason).toMatch(/locked/i);
  });

  it("returns ok when bootstrapped AND unlocked", async () => {
    fakeVault.bootstrappedAt = new Date();
    fakeVault.passphraseState = "unlocked";
    const r = await vaultBootstrappedPredicate(ctx);
    expect(r.ok).toBe(true);
  });
});
