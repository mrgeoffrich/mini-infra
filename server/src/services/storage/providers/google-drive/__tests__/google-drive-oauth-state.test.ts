import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { internalSecrets } from "../../../../../lib/security-config";
import {
  buildOAuthState,
  verifyOAuthState,
  OAuthStateInvalidError,
} from "../google-drive-oauth-state";

beforeAll(() => {
  if (!internalSecrets.isInitialized()) {
    internalSecrets.setAuthSecret("test-auth-secret-for-drive-oauth");
  }
});

afterEach(() => {
  // Always restore real timers — the stale_state test installs fake ones.
  vi.useRealTimers();
});

describe("google-drive-oauth-state", () => {
  it("round-trips a freshly-built state", () => {
    const state = buildOAuthState();
    expect(() => verifyOAuthState(state)).not.toThrow();
  });

  it("rejects a missing state", () => {
    expect(() => verifyOAuthState(undefined)).toThrow(OAuthStateInvalidError);
    expect(() => verifyOAuthState("")).toThrow(OAuthStateInvalidError);
  });

  it("rejects malformed base64", () => {
    expect(() => verifyOAuthState("not%%base64")).toThrow(OAuthStateInvalidError);
  });

  it("rejects a tampered signature", () => {
    const state = buildOAuthState();
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    decoded.sig = "0000000000000000";
    const tampered = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    expect(() => verifyOAuthState(tampered)).toThrow(OAuthStateInvalidError);
  });

  it("rejects a stale state (>10 minutes)", () => {
    // Use fake timers to genuinely expire the TTL window: build a real
    // state at T0, advance the clock 20 minutes, and verify. The signature
    // stays valid (we never mutate the payload), so this exercises the
    // freshness check rather than the HMAC check.
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const state = buildOAuthState();
    // Sanity-check: the freshly-built state passes immediately.
    expect(() => verifyOAuthState(state)).not.toThrow();
    vi.setSystemTime(new Date(t0.getTime() + 20 * 60 * 1000));
    let thrown: unknown;
    try {
      verifyOAuthState(state);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OAuthStateInvalidError);
    expect((thrown as OAuthStateInvalidError).code).toBe("stale_state");
  });

  it("each state is unique (random nonce)", () => {
    const a = buildOAuthState();
    const b = buildOAuthState();
    expect(a).not.toBe(b);
  });
});
