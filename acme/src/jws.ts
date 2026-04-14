import { createSign, constants as cryptoConstants, KeyObject } from "node:crypto";
import { assertRsaKey, loadPrivateKey } from "./crypto/keys";
import { getRsaJwk, RsaPublicJwk } from "./crypto/jwk";

export interface JwsSignOptions {
  url: string;
  nonce?: string | null;
  kid?: string | null;
  payload?: unknown;
}

export interface JwsBody {
  protected: string;
  payload: string;
  signature: string;
}

const b64u = (input: string | Buffer): string =>
  (Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8")).toString("base64url");

export class JwsSigner {
  readonly privateKey: KeyObject;
  readonly jwk: RsaPublicJwk;

  constructor(accountKeyPem: Buffer | string) {
    this.privateKey = loadPrivateKey(accountKeyPem);
    assertRsaKey(this.privateKey);
    this.jwk = getRsaJwk(accountKeyPem);
  }

  createSignedBody({ url, nonce = null, kid = null, payload = null }: JwsSignOptions): JwsBody {
    const header: Record<string, unknown> = { alg: "RS256", url };
    if (nonce) header.nonce = nonce;
    if (kid) header.kid = kid;
    else header.jwk = this.jwk;

    const encodedProtected = b64u(JSON.stringify(header));
    const encodedPayload = payload === null || payload === undefined ? "" : b64u(JSON.stringify(payload));

    const signer = createSign("SHA256");
    signer.update(`${encodedProtected}.${encodedPayload}`, "utf8");
    const signature = signer.sign({ key: this.privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING });

    return {
      protected: encodedProtected,
      payload: encodedPayload,
      signature: signature.toString("base64url"),
    };
  }
}
