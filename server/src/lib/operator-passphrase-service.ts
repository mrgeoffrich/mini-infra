import { EventEmitter } from "events";
import crypto from "crypto";
import { PrismaClient } from "./prisma";
import {
  deriveKey,
  encrypt,
  decrypt,
  randomSalt,
  zeroise,
  toPrismaBytes,
  CryptoError,
} from "./crypto";
import { getLogger } from "./logger-factory";

/**
 * Operator passphrase state.
 *
 *   - uninitialised: no VaultState row exists yet, or it has no passphraseSalt.
 *   - locked:        salt is stored but the derived key is not in memory.
 *   - unlocked:      the derived key is in memory and ready to wrap/unwrap.
 */
export type PassphraseState = "uninitialised" | "locked" | "unlocked";

/**
 * Fixed 32-byte probe plaintext. When the operator sets a passphrase we encrypt
 * this constant; on subsequent unlock attempts we decrypt the stored probe with
 * the newly-derived key and require the plaintext to match. This catches wrong
 * passphrases without having to attempt to decrypt real secrets.
 */
const PROBE_PLAINTEXT = Buffer.from(
  "mini-infra-vault-operator-passphrase-probe-v1",
  "utf8",
);

/**
 * Back-off schedule applied after a failed unlock attempt. Simple linear growth
 * capped at 30s — we do not permanently lock because lockout could DoS recovery.
 */
function backoffMs(failedCount: number): number {
  if (failedCount <= 0) return 0;
  const secs = Math.min(failedCount * 2, 30);
  return secs * 1000;
}

const VAULT_STATE_KIND = "primary";

const log = getLogger("platform", "operator-passphrase-service");

export interface OperatorPassphraseServiceEvents {
  unlocked: () => void;
  locked: () => void;
}

/**
 * Manages the operator passphrase used to wrap VaultState secrets.
 *
 * Singleton per server process. `refresh()` rereads persistent state from the
 * DB (e.g. after another process changed the salt). `unlock()` derives the key
 * and verifies it against a stored probe; `lock()` zeroises the in-memory key.
 */
export class OperatorPassphraseService extends EventEmitter {
  private prisma: PrismaClient;
  private state: PassphraseState = "uninitialised";
  private key: Buffer | null = null;
  private failedAttempts = 0;
  private nextAttemptAt: number = 0;

  constructor(prisma: PrismaClient) {
    super();
    this.prisma = prisma;
  }

  /** Refresh state flags from the DB. Does NOT change the in-memory key. */
  async refresh(): Promise<PassphraseState> {
    const row = await this.prisma.vaultState.findUnique({
      where: { kind: VAULT_STATE_KIND },
    });
    if (!row || !row.passphraseSalt || !row.passphraseProbe) {
      if (this.state !== "uninitialised" && !this.key) {
        this.state = "uninitialised";
      }
      if (!this.key) this.state = "uninitialised";
      return this.state;
    }
    if (this.key) {
      this.state = "unlocked";
    } else {
      this.state = "locked";
    }
    return this.state;
  }

  getState(): PassphraseState {
    return this.state;
  }

  isUnlocked(): boolean {
    return this.state === "unlocked" && this.key !== null;
  }

  /**
   * Retrieve the current retry delay in ms (how long until the next unlock
   * attempt is allowed). Returns 0 if no delay is active.
   */
  getRetryDelayMs(): number {
    return Math.max(0, this.nextAttemptAt - Date.now());
  }

  /**
   * Set the passphrase for the first time, or rotate it.
   *
   * On first-set: generates a salt, derives the key, writes salt + encrypted probe.
   * On rotate (not yet implemented here): would need to re-wrap every encrypted
   *   field in VaultState — deferred to a dedicated passphrase-rotation flow.
   */
  async setInitialPassphrase(passphrase: string): Promise<void> {
    if (!passphrase || passphrase.length < 8) {
      throw new Error("Passphrase must be at least 8 characters");
    }
    const row = await this.prisma.vaultState.findUnique({
      where: { kind: VAULT_STATE_KIND },
    });
    if (row?.passphraseSalt) {
      throw new Error(
        "Passphrase already set; use the change-passphrase flow to rotate",
      );
    }

    const salt = randomSalt();
    const key = await deriveKey(passphrase, salt);
    const probe = encrypt(key, PROBE_PLAINTEXT);

    await this.prisma.vaultState.upsert({
      where: { kind: VAULT_STATE_KIND },
      create: {
        kind: VAULT_STATE_KIND,
        passphraseSalt: toPrismaBytes(salt),
        passphraseProbe: toPrismaBytes(probe),
      },
      update: {
        passphraseSalt: toPrismaBytes(salt),
        passphraseProbe: toPrismaBytes(probe),
      },
    });

    // Promote to unlocked immediately
    this.replaceKey(key);
    this.failedAttempts = 0;
    this.nextAttemptAt = 0;
    this.state = "unlocked";
    this.emit("unlocked");
    log.info("Operator passphrase set and unlocked");
  }

  /**
   * Derive the key from passphrase + stored salt, verify it decrypts the probe,
   * and transition to `unlocked`.
   */
  async unlock(passphrase: string): Promise<void> {
    const now = Date.now();
    if (now < this.nextAttemptAt) {
      const waitMs = this.nextAttemptAt - now;
      throw new Error(
        `Too many failed attempts — wait ${Math.ceil(waitMs / 1000)}s before retrying`,
      );
    }
    const row = await this.prisma.vaultState.findUnique({
      where: { kind: VAULT_STATE_KIND },
    });
    if (!row?.passphraseSalt || !row.passphraseProbe) {
      throw new Error("Passphrase has not been set; run bootstrap first");
    }
    const salt = Buffer.from(row.passphraseSalt);
    const probe = Buffer.from(row.passphraseProbe);

    const candidate = await deriveKey(passphrase, salt);
    try {
      const decoded = decrypt(candidate, probe);
      if (!crypto.timingSafeEqual(decoded, PROBE_PLAINTEXT)) {
        zeroise(candidate);
        this.recordFailure();
        throw new Error("Invalid passphrase");
      }
    } catch (err) {
      zeroise(candidate);
      if (err instanceof CryptoError) {
        this.recordFailure();
        throw new Error("Invalid passphrase");
      }
      throw err;
    }

    this.replaceKey(candidate);
    this.failedAttempts = 0;
    this.nextAttemptAt = 0;
    this.state = "unlocked";
    this.emit("unlocked");
    log.info("Operator passphrase unlocked");
  }

  /**
   * Zeroise the in-memory key and transition to `locked`.
   */
  lock(): void {
    this.replaceKey(null);
    if (this.state === "unlocked") {
      this.state = "locked";
      this.emit("locked");
      log.info("Operator passphrase locked");
    }
  }

  /**
   * Wrap plaintext bytes using the in-memory key. Throws if not unlocked.
   */
  wrap(plaintext: Buffer): Buffer {
    const key = this.requireKey();
    return encrypt(key, plaintext);
  }

  /** Unwrap bytes using the in-memory key. Throws if not unlocked. */
  unwrap(ciphertext: Buffer): Buffer {
    const key = this.requireKey();
    return decrypt(key, ciphertext);
  }

  /** Convenience: wrap a utf-8 string. */
  wrapString(plaintext: string): Buffer {
    return this.wrap(Buffer.from(plaintext, "utf8"));
  }

  /** Convenience: unwrap to a utf-8 string. */
  unwrapString(ciphertext: Buffer): string {
    return this.unwrap(ciphertext).toString("utf8");
  }

  /**
   * Attempt to unlock using the OPERATOR_PASSPHRASE environment variable.
   * Intended to be called once at boot. Silent no-op when the env var is unset
   * or empty; errors are logged but do not throw (the server must keep running).
   */
  async tryAutoUnlockFromEnv(): Promise<boolean> {
    const envPass = process.env.OPERATOR_PASSPHRASE;
    if (!envPass) return false;
    try {
      await this.refresh();
      if (this.state === "uninitialised") {
        log.info(
          "OPERATOR_PASSPHRASE env var set but VaultState is uninitialised — skipping auto-unlock",
        );
        return false;
      }
      await this.unlock(envPass);
      log.info("Vault passphrase auto-unlocked via OPERATOR_PASSPHRASE env var");
      return true;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Auto-unlock from OPERATOR_PASSPHRASE failed",
      );
      return false;
    }
  }

  private requireKey(): Buffer {
    if (!this.key || this.state !== "unlocked") {
      throw new Error("Operator passphrase is locked");
    }
    return this.key;
  }

  private replaceKey(next: Buffer | null): void {
    if (this.key) {
      zeroise(this.key);
    }
    this.key = next;
  }

  private recordFailure(): void {
    this.failedAttempts += 1;
    this.nextAttemptAt = Date.now() + backoffMs(this.failedAttempts);
  }
}

let instance: OperatorPassphraseService | null = null;

export function getOperatorPassphraseService(
  prisma: PrismaClient,
): OperatorPassphraseService {
  if (!instance) {
    instance = new OperatorPassphraseService(prisma);
  }
  return instance;
}

/** Test-only: reset the module-level singleton. */
export function __resetOperatorPassphraseServiceForTests(): void {
  if (instance) {
    instance.lock();
  }
  instance = null;
}
