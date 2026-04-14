import { describe, expect, it } from "vitest";
import { createPublicKey, createVerify, constants } from "node:crypto";
import { createPrivateRsaKey } from "../src/crypto/keys";
import { JwsSigner } from "../src/jws";

describe("JwsSigner", () => {
  it("signs with RS256 producing a signature that verifies against the public key", async () => {
    const keyPem = await createPrivateRsaKey(2048);
    const signer = new JwsSigner(keyPem);
    const body = signer.createSignedBody({
      url: "https://example.test/newOrder",
      nonce: "abc",
      kid: "https://example.test/acct/1",
      payload: { identifiers: [{ type: "dns", value: "example.com" }] },
    });

    const header = JSON.parse(Buffer.from(body.protected, "base64url").toString("utf8"));
    expect(header.alg).toBe("RS256");
    expect(header.nonce).toBe("abc");
    expect(header.kid).toBe("https://example.test/acct/1");
    expect(header.url).toBe("https://example.test/newOrder");
    expect(header.jwk).toBeUndefined();

    const verifier = createVerify("SHA256");
    verifier.update(`${body.protected}.${body.payload}`, "utf8");
    const pub = createPublicKey(keyPem);
    expect(
      verifier.verify(
        { key: pub, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(body.signature, "base64url")
      )
    ).toBe(true);
  });

  it("embeds jwk when no kid is provided", async () => {
    const signer = new JwsSigner(await createPrivateRsaKey(2048));
    const body = signer.createSignedBody({ url: "https://example.test/newAccount", nonce: "n" });
    const header = JSON.parse(Buffer.from(body.protected, "base64url").toString("utf8"));
    expect(header.jwk).toBeDefined();
    expect(header.jwk.kty).toBe("RSA");
    expect(header.kid).toBeUndefined();
  });
});
