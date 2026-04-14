import { describe, expect, it } from "vitest";
import { createPrivateRsaKey } from "../src/crypto/keys";
import { JwsSigner } from "../src/jws";
import { AcmeHttpClient } from "../src/http";

const directoryBody = {
  newNonce: "https://acme.test/nonce",
  newAccount: "https://acme.test/newAccount",
  newOrder: "https://acme.test/newOrder",
  revokeCert: "https://acme.test/revokeCert",
};

describe("AcmeHttpClient concurrency", () => {
  it("serializes signed requests so nonces are never reused", async () => {
    let nonceCounter = 0;
    const consumedNonces: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://acme.test/directory") {
        return new Response(JSON.stringify(directoryBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "HEAD" && url === "https://acme.test/nonce") {
        nonceCounter += 1;
        return new Response("", { status: 200, headers: { "replay-nonce": `n-${nonceCounter}` } });
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const body = JSON.parse(init!.body as string);
      const header = JSON.parse(Buffer.from(body.protected, "base64url").toString("utf8"));
      consumedNonces.push(header.nonce);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      nonceCounter += 1;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "replay-nonce": `n-${nonceCounter}` },
      });
    }) as typeof fetch;

    const signer = new JwsSigner(await createPrivateRsaKey(2048));
    const http = new AcmeHttpClient({
      directoryUrl: "https://acme.test/directory",
      signer,
      fetchImpl,
    });

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        http.signedRequest(`https://acme.test/op/${i}`, { i }, { kid: "kid" })
      )
    );

    // Every nonce consumed must be unique (no reuse).
    expect(new Set(consumedNonces).size).toBe(consumedNonces.length);
    // Signed requests should never overlap.
    expect(maxInFlight).toBe(1);
  });

  it("single-flights the directory fetch under concurrent callers", async () => {
    let directoryCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://acme.test/directory") {
        directoryCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return new Response(JSON.stringify(directoryBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("unexpected " + url);
    }) as typeof fetch;

    const signer = new JwsSigner(await createPrivateRsaKey(2048));
    const http = new AcmeHttpClient({ directoryUrl: "https://acme.test/directory", signer, fetchImpl });
    await Promise.all([http.getDirectory(), http.getDirectory(), http.getDirectory(), http.getDirectory()]);
    expect(directoryCalls).toBe(1);
  });
});
