/**
 * Encrypt, decrypt, and merge operator-supplied input values for stack
 * templates.
 *
 * Input values are sensitive secrets (e.g. Slack bot tokens, API keys). They
 * are encrypted at rest on the Stack row using AES-256-GCM, keyed from the
 * application's internal auth secret. The plaintext is a JSON object mapping
 * input name → value.
 *
 * The public surface is:
 *   encryptInputValues(values) → string (base64 ciphertext blob)
 *   decryptInputValues(encrypted) → Record<string, string>
 *   mergeForUpgrade(stored, supplied, declarations) → Record<string, string>
 *
 * No DB access, no logger — pure crypto + business logic, safe to unit-test.
 */

import crypto from "crypto";
import { encryptString, decryptString, CryptoError, zeroise } from "../../lib/crypto";
import { getAuthSecret } from "../../lib/security-config";
import type { TemplateInputDeclaration } from "@mini-infra/types";

export class InputValuesMissingError extends Error {
  constructor(readonly inputName: string) {
    super(`Input '${inputName}' has rotateOnUpgrade=true and must be supplied on every upgrade`);
    this.name = "InputValuesMissingError";
  }
}

/**
 * Derive a 32-byte key from the application auth secret for wrapping input
 * values. Uses HMAC-SHA256 so the result is deterministic but domain-separated
 * from any other HMAC uses of the same secret.
 */
function deriveInputValuesKey(): Buffer {
  const secret = getAuthSecret();
  return Buffer.from(
    crypto.createHmac("sha256", secret).update("stack-input-values-v1").digest(),
  );
}

/**
 * Encrypt a map of input values to a base64 string suitable for storing in
 * Stack.encryptedInputValues.
 */
export function encryptInputValues(values: Record<string, string>): string {
  const key = deriveInputValuesKey();
  const plaintext = JSON.stringify(values);
  const cipherBuf = encryptString(key, plaintext);
  zeroise(key);
  return cipherBuf.toString("base64");
}

/**
 * Decrypt a base64 blob produced by encryptInputValues() back to a map of
 * input name → value.
 */
export function decryptInputValues(encrypted: string): Record<string, string> {
  const key = deriveInputValuesKey();
  const cipherBuf = Buffer.from(encrypted, "base64");
  let plaintext: string;
  try {
    plaintext = decryptString(key, cipherBuf);
  } finally {
    zeroise(key);
  }
  const parsed: unknown = JSON.parse(plaintext);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CryptoError("Decrypted payload is not a plain object");
  }
  return parsed as Record<string, string>;
}

/**
 * Merge stored input values with newly-supplied ones for an upgrade.
 *
 * Rules:
 *   - If a declaration has rotateOnUpgrade=true, the value MUST be in
 *     `supplied` — throws InputValuesMissingError if absent.
 *   - For all other inputs, `supplied` overrides `stored`; if neither has a
 *     value and the input is required it is silently omitted (the apply step
 *     in PR 2 will surface the missing-required-input error).
 */
export function mergeForUpgrade(
  stored: Record<string, string>,
  supplied: Record<string, string>,
  declarations: TemplateInputDeclaration[],
): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const decl of declarations) {
    if (decl.rotateOnUpgrade) {
      if (!(decl.name in supplied)) {
        throw new InputValuesMissingError(decl.name);
      }
      merged[decl.name] = supplied[decl.name];
    } else {
      const value = supplied[decl.name] ?? stored[decl.name];
      if (value !== undefined) {
        merged[decl.name] = value;
      }
    }
  }

  return merged;
}

