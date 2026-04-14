import { createPrivateKey, createPrivateRsaKey } from "./crypto/keys";
import { createCsr, createCsrPair } from "./crypto/csr";
import { splitPemChain } from "./crypto/pem";

export { AcmeClient } from "./client";
export type { AcmeClientOptions } from "./client";
export { AcmeHttpClient } from "./http";
export type { AcmeResponse } from "./http";
export { JwsSigner } from "./jws";
export { AcmeProblemError } from "./errors";
export type { AcmeProblem } from "./errors";
export * from "./types";
export { directory, letsencrypt, buypass, zerossl } from "./directories";
export { verifyDnsChallenge } from "./flow/verify";
export type { AutoOptions } from "./flow/auto";

export const crypto = {
  createPrivateKey,
  createPrivateRsaKey,
  createCsr,
  createCsrPair,
  splitPemChain,
};
