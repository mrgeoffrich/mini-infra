import argon2 from "argon2";
import crypto from "crypto";

/**
 * Symmetric crypto utilities for wrapping sensitive material at rest.
 *
 * On-disk format: version(1) | nonce(12) | ciphertext(N) | tag(16)
 * Cipher: AES-256-GCM
 * KDF: Argon2id (memoryCost 64 MiB, timeCost 3, parallelism 4) with 16-byte salt
 *
 * Typical use: derive a wrapping key from an operator passphrase at unlock time,
 * keep it in memory until lock(), then zeroise.
 */

const VERSION_V1 = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + NONCE_LEN; // version + nonce

export const ARGON2_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 65536, // KiB = 64 MiB
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
} as const;

export const KEY_LEN = 32; // AES-256
export const SALT_LEN = 16;

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

/**
 * Derive a 32-byte key from a passphrase + salt using Argon2id.
 * The returned Buffer should be zeroised via buf.fill(0) when no longer needed.
 */
export async function deriveKey(
  passphrase: string,
  salt: Buffer,
): Promise<Buffer> {
  if (salt.length !== SALT_LEN) {
    throw new CryptoError(`Salt must be ${SALT_LEN} bytes, got ${salt.length}`);
  }
  const raw = await argon2.hash(passphrase, {
    ...ARGON2_PARAMS,
    salt,
    raw: true,
  });
  // argon2 returns a Buffer when raw: true
  return raw as unknown as Buffer;
}

/**
 * Generate a fresh random salt suitable for deriveKey().
 */
export function randomSalt(): Buffer {
  return crypto.randomBytes(SALT_LEN);
}

/**
 * Encrypt plaintext with AES-256-GCM using the provided key.
 * Returns a self-contained buffer in the format:
 *   version(1) | nonce(12) | ciphertext | tag(16)
 */
export function encrypt(key: Buffer, plaintext: Buffer): Buffer {
  if (key.length !== KEY_LEN) {
    throw new CryptoError(`Key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION_V1]), nonce, ciphertext, tag]);
}

/**
 * Decrypt a buffer produced by encrypt(). Throws CryptoError on any failure,
 * including tag mismatch (tampering) or wrong key.
 */
export function decrypt(key: Buffer, payload: Buffer): Buffer {
  if (key.length !== KEY_LEN) {
    throw new CryptoError(`Key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  if (payload.length < HEADER_LEN + TAG_LEN) {
    throw new CryptoError("Ciphertext too short");
  }
  const version = payload[0];
  if (version !== VERSION_V1) {
    throw new CryptoError(`Unsupported crypto version: ${version}`);
  }
  const nonce = payload.subarray(1, 1 + NONCE_LEN);
  const tag = payload.subarray(payload.length - TAG_LEN);
  const ciphertext = payload.subarray(HEADER_LEN, payload.length - TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new CryptoError(
      `Decryption failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}

/**
 * Encrypt a utf-8 string. Convenience wrapper over encrypt().
 */
export function encryptString(key: Buffer, plaintext: string): Buffer {
  return encrypt(key, Buffer.from(plaintext, "utf8"));
}

/**
 * Decrypt to a utf-8 string. Convenience wrapper over decrypt().
 */
export function decryptString(key: Buffer, payload: Buffer): string {
  return decrypt(key, payload).toString("utf8");
}

/**
 * Overwrite a Buffer's contents with zero bytes in place.
 * Use before releasing references to a derived key.
 */
export function zeroise(buf: Buffer | null | undefined): void {
  if (buf && buf.length > 0) {
    buf.fill(0);
  }
}

/**
 * Convert a Buffer to a Uint8Array backed by a dedicated ArrayBuffer.
 *
 * Node's Buffer extends Uint8Array but its underlying `buffer` can be a
 * SharedArrayBuffer — which Prisma's Bytes field type refuses. This helper
 * returns a fresh, non-shared Uint8Array<ArrayBuffer> suitable for Prisma
 * writes.
 */
export function toPrismaBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  const ab = new ArrayBuffer(buf.length);
  const copy = new Uint8Array(ab);
  copy.set(buf);
  return copy;
}
