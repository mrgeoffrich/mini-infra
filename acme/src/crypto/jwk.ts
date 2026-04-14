import { createHash } from "node:crypto";
import { getPublicKeyObject } from "./keys";

export interface RsaPublicJwk {
  kty: "RSA";
  n: string;
  e: string;
}

export const getRsaJwk = (keyPem: Buffer | string): RsaPublicJwk => {
  const jwk = getPublicKeyObject(keyPem).export({ format: "jwk" }) as Record<string, string>;
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) {
    throw new Error("Expected RSA JWK with n and e components");
  }
  return { kty: "RSA", n: jwk.n, e: jwk.e };
};

export const jwkThumbprint = (jwk: RsaPublicJwk): string => {
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return createHash("sha256").update(canonical).digest("base64url");
};
