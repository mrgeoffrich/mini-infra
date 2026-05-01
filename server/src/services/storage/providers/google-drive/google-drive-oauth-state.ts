/**
 * Stateless HMAC-signed OAuth state helpers.
 *
 * The OAuth `state` parameter is signed with the application's auth secret
 * — no SystemSettings round-trip — so concurrent OAuth attempts don't race
 * on a shared nonce row. Validity window is 10 minutes; freshness is checked
 * against `iat` at callback time.
 *
 * Wire format (URL-safe base64 of JSON):
 *   { iat: number, nonce: string, sig: string }
 * where `sig = HMAC-SHA256(secret, "google-drive:" + iat + ":" + nonce)`.
 *
 * The signed payload is intentionally minimal — Google enforces a state
 * length cap and we don't need to round-trip arbitrary return targets.
 */

import crypto from "crypto";
import { getAuthSecret } from "../../../../lib/security-config";

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_CONTEXT = "google-drive:";

interface SignedStatePayload {
  iat: number;
  nonce: string;
  sig: string;
}

function deriveStateKey(): Buffer {
  return Buffer.from(
    crypto
      .createHmac("sha256", getAuthSecret())
      .update("storage-google-drive/oauth-state/v1")
      .digest(),
  );
}

function computeSignature(iat: number, nonce: string): string {
  const key = deriveStateKey();
  try {
    return crypto
      .createHmac("sha256", key)
      .update(`${STATE_CONTEXT}${iat}:${nonce}`)
      .digest("base64url");
  } finally {
    key.fill(0);
  }
}

export function buildOAuthState(): string {
  const iat = Date.now();
  const nonce = crypto.randomBytes(16).toString("base64url");
  const sig = computeSignature(iat, nonce);
  const payload: SignedStatePayload = { iat, nonce, sig };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export class OAuthStateInvalidError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OAuthStateInvalidError";
  }
}

/**
 * Verify a state value is well-formed, recently-issued, and signed with the
 * current auth secret. Throws an {@link OAuthStateInvalidError} on every
 * failure path — callers map to a redirect with `?google-drive=error`.
 */
export function verifyOAuthState(raw: string | undefined): void {
  if (!raw) {
    throw new OAuthStateInvalidError("missing_state", "Missing state parameter");
  }
  let decoded: SignedStatePayload;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new OAuthStateInvalidError(
      "malformed_state",
      "OAuth state is not valid base64url JSON",
    );
  }
  if (
    typeof decoded.iat !== "number" ||
    typeof decoded.nonce !== "string" ||
    typeof decoded.sig !== "string"
  ) {
    throw new OAuthStateInvalidError(
      "malformed_state",
      "OAuth state is missing required fields",
    );
  }
  const expected = computeSignature(decoded.iat, decoded.nonce);
  // Constant-time compare. Mismatched lengths short-circuit safely.
  const a = Buffer.from(decoded.sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new OAuthStateInvalidError(
      "bad_signature",
      "OAuth state signature is invalid",
    );
  }
  const age = Date.now() - decoded.iat;
  if (age < 0 || age > STATE_TTL_MS) {
    throw new OAuthStateInvalidError(
      "stale_state",
      "OAuth state has expired (>10 minutes)",
    );
  }
}
