import { describe, it, expect, beforeEach, vi } from "vitest";
import { OperatorPassphraseService } from "../operator-passphrase-service";
import type { PrismaClient } from "../prisma";

/**
 * Uses an in-memory mock Prisma. Good enough for the state-machine tests —
 * the actual DB shape is narrow (one row, a few byte columns) and the test
 * exercises behaviour, not persistence semantics.
 */
function makeMockPrisma() {
  let row: {
    kind: string;
    passphraseSalt: Uint8Array | null;
    passphraseProbe: Uint8Array | null;
  } | null = null;
  const vaultState = {
    findUnique: vi.fn(async () => row),
    upsert: vi.fn(
      async ({
        create,
        update,
      }: {
        create: { kind: string; passphraseSalt: Uint8Array; passphraseProbe: Uint8Array };
        update: { passphraseSalt: Uint8Array; passphraseProbe: Uint8Array };
      }) => {
        if (row) {
          row.passphraseSalt = update.passphraseSalt;
          row.passphraseProbe = update.passphraseProbe;
        } else {
          row = {
            kind: create.kind,
            passphraseSalt: create.passphraseSalt,
            passphraseProbe: create.passphraseProbe,
          };
        }
        return row;
      },
    ),
  };
  return { vaultState } as unknown as PrismaClient;
}

describe("OperatorPassphraseService", () => {
  let prisma: PrismaClient;
  let svc: OperatorPassphraseService;

  beforeEach(() => {
    prisma = makeMockPrisma();
    svc = new OperatorPassphraseService(prisma);
  });

  it("starts uninitialised when no VaultState row exists", async () => {
    expect(await svc.refresh()).toBe("uninitialised");
    expect(svc.isUnlocked()).toBe(false);
  });

  it("setInitialPassphrase promotes to unlocked", async () => {
    const emitted: string[] = [];
    svc.on("unlocked", () => emitted.push("unlocked"));
    await svc.setInitialPassphrase("correct horse battery staple");
    expect(svc.isUnlocked()).toBe(true);
    expect(emitted).toEqual(["unlocked"]);
  });

  it("lock() transitions back to locked and clears the key", async () => {
    await svc.setInitialPassphrase("correct horse battery staple");
    svc.lock();
    expect(svc.isUnlocked()).toBe(false);
    expect(() => svc.wrap(Buffer.from("x"))).toThrow(/locked/i);
  });

  it("wrap/unwrap round-trips while unlocked", async () => {
    await svc.setInitialPassphrase("correct horse battery staple");
    const plaintext = Buffer.from("my secret token");
    const wrapped = svc.wrap(plaintext);
    const unwrapped = svc.unwrap(wrapped);
    expect(unwrapped.equals(plaintext)).toBe(true);
  });

  it("unlock succeeds with correct passphrase after lock", async () => {
    await svc.setInitialPassphrase("secret-a-b-c-1-2-3");
    svc.lock();
    await svc.unlock("secret-a-b-c-1-2-3");
    expect(svc.isUnlocked()).toBe(true);
  });

  it("unlock with wrong passphrase throws and records a failure", async () => {
    await svc.setInitialPassphrase("secret-a-b-c-1-2-3");
    svc.lock();
    await expect(svc.unlock("wrong-passphrase")).rejects.toThrow(/invalid/i);
    expect(svc.isUnlocked()).toBe(false);
  });

  it("setInitialPassphrase rejects if already set", async () => {
    await svc.setInitialPassphrase("secret-a-b-c-1-2-3");
    await expect(
      svc.setInitialPassphrase("another-valid-passphrase"),
    ).rejects.toThrow(/already set/i);
  });

  it("refresh returns 'locked' when salt exists but no in-memory key", async () => {
    await svc.setInitialPassphrase("secret-a-b-c-1-2-3");
    svc.lock();
    expect(await svc.refresh()).toBe("locked");
  });
});
