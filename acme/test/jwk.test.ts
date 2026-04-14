import { describe, expect, it } from "vitest";
import { createPrivateRsaKey } from "../src/crypto/keys";
import { getRsaJwk, jwkThumbprint } from "../src/crypto/jwk";

describe("jwk", () => {
  it("produces an RSA JWK with n and e from a generated RSA key", async () => {
    const pem = await createPrivateRsaKey(2048);
    const jwk = getRsaJwk(pem);
    expect(jwk.kty).toBe("RSA");
    expect(jwk.e.length).toBeGreaterThan(0);
    expect(jwk.n.length).toBeGreaterThan(0);
  });

  it("matches RFC 7638 thumbprint test vector", () => {
    const jwk = {
      kty: "RSA" as const,
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
      e: "AQAB",
    };
    expect(jwkThumbprint(jwk)).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
  });
});
