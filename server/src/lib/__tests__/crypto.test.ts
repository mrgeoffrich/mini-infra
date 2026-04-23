import { describe, it, expect } from "vitest";
import {
  encrypt,
  decrypt,
  deriveKey,
  randomSalt,
  zeroise,
  toPrismaBytes,
  encryptString,
  decryptString,
  CryptoError,
  KEY_LEN,
  SALT_LEN,
} from "../crypto";
import crypto from "crypto";

describe("crypto", () => {
  const key = Buffer.alloc(KEY_LEN, 0xab);

  it("round-trips plaintext via encrypt/decrypt", () => {
    const plaintext = Buffer.from("hello, vault!");
    const ciphertext = encrypt(key, plaintext);
    const decrypted = decrypt(key, ciphertext);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("produces fresh nonces (no two ciphertexts equal for same plaintext)", () => {
    const plaintext = Buffer.from("same-input");
    const a = encrypt(key, plaintext);
    const b = encrypt(key, plaintext);
    expect(a.equals(b)).toBe(false);
  });

  it("detects tampering via GCM tag", () => {
    const plaintext = Buffer.from("important");
    const ciphertext = encrypt(key, plaintext);
    // Flip one byte in the ciphertext portion
    ciphertext[ciphertext.length - 5] ^= 0x01;
    expect(() => decrypt(key, ciphertext)).toThrow(CryptoError);
  });

  it("rejects wrong key", () => {
    const other = Buffer.alloc(KEY_LEN, 0x00);
    const ciphertext = encrypt(key, Buffer.from("secret"));
    expect(() => decrypt(other, ciphertext)).toThrow(CryptoError);
  });

  it("rejects unknown version byte", () => {
    const ciphertext = encrypt(key, Buffer.from("hi"));
    ciphertext[0] = 0x02;
    expect(() => decrypt(key, ciphertext)).toThrow(CryptoError);
  });

  it("convenience string helpers round-trip", () => {
    const out = decryptString(key, encryptString(key, "¡hola mundo 🚀"));
    expect(out).toBe("¡hola mundo 🚀");
  });

  it("deriveKey is deterministic for same passphrase + salt", async () => {
    const salt = randomSalt();
    const a = await deriveKey("correct horse battery staple", salt);
    const b = await deriveKey("correct horse battery staple", salt);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(KEY_LEN);
  });

  it("deriveKey differs for different passphrases", async () => {
    const salt = randomSalt();
    const a = await deriveKey("one", salt);
    const b = await deriveKey("two", salt);
    expect(a.equals(b)).toBe(false);
  });

  it("randomSalt produces correct length and is non-deterministic", () => {
    const a = randomSalt();
    const b = randomSalt();
    expect(a.length).toBe(SALT_LEN);
    expect(b.length).toBe(SALT_LEN);
    expect(a.equals(b)).toBe(false);
  });

  it("zeroise fills a buffer with zeros", () => {
    const buf = Buffer.from("plaintext-secret");
    zeroise(buf);
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it("zeroise tolerates null/undefined", () => {
    expect(() => zeroise(null)).not.toThrow();
    expect(() => zeroise(undefined)).not.toThrow();
  });

  it("toPrismaBytes produces a fresh ArrayBuffer-backed Uint8Array", () => {
    const buf = crypto.randomBytes(32);
    const out = toPrismaBytes(buf);
    expect(out.length).toBe(32);
    expect(out.buffer).toBeInstanceOf(ArrayBuffer);
    // mutation of the original shouldn't affect the copy
    buf.fill(0);
    expect(out.some((b) => b !== 0)).toBe(true);
  });
});
