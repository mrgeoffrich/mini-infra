import argon2 from "argon2";
import crypto from "crypto";
import { getLogger } from "./logger-factory";

const logger = getLogger("auth", "password-service");

/**
 * Hash a password using argon2id
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
  });
}

/**
 * Verify a password against an argon2id hash
 */
export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch (error) {
    logger.error({ error }, "Error verifying password");
    return false;
  }
}

/**
 * Generate a random temporary password (16 chars, URL-safe)
 */
export function generateTemporaryPassword(): string {
  return crypto.randomBytes(12).toString("base64url");
}

/**
 * Validate password strength: min 8 chars, at least one letter and one number
 */
export function validatePasswordStrength(password: string): {
  valid: boolean;
  message?: string;
} {
  if (!password || password.length < 8) {
    return { valid: false, message: "Password must be at least 8 characters" };
  }
  if (!/[a-zA-Z]/.test(password)) {
    return {
      valid: false,
      message: "Password must contain at least one letter",
    };
  }
  if (!/[0-9]/.test(password)) {
    return {
      valid: false,
      message: "Password must contain at least one number",
    };
  }
  return { valid: true };
}
