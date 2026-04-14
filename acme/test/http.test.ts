import { describe, expect, it } from "vitest";
import { createPrivateRsaKey } from "../src/crypto/keys";
import { JwsSigner } from "../src/jws";
import { AcmeHttpClient, parseRetryAfter } from "../src/http";
import { AcmeProblemError } from "../src/errors";

const directoryBody = {
  newNonce: "https://acme.test/nonce",
  newAccount: "https://acme.test/newAccount",
  newOrder: "https://acme.test/newOrder",
  revokeCert: "https://acme.test/revokeCert",
  keyChange: "https://acme.test/keyChange",
  meta: { termsOfService: "https://acme.test/tos" },
};

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  bodyText?: string;
}

const mkFetch = (handler: (url: string, init: RequestInit | undefined) => FakeResponse | Promise<FakeResponse>): typeof fetch => {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = await handler(url, init);
    const text = r.bodyText ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    return new Response(text, {
      status: r.status,
      headers: r.headers,
    });
  }) as typeof fetch;
};

describe("AcmeHttpClient", () => {
  it("caches directory, pulls a nonce, and retries on badNonce", async () => {
    let nonceCount = 0;
    let signedCalls = 0;
    const signer = new JwsSigner(await createPrivateRsaKey(2048));
    const fetchImpl = mkFetch(async (url) => {
      if (url === "https://acme.test/directory") {
        return { status: 200, headers: { "content-type": "application/json" }, body: directoryBody };
      }
      if (url === "https://acme.test/nonce") {
        nonceCount += 1;
        return { status: 200, headers: { "replay-nonce": `nonce-${nonceCount}` } };
      }
      if (url === "https://acme.test/newOrder") {
        signedCalls += 1;
        if (signedCalls === 1) {
          return {
            status: 400,
            headers: { "content-type": "application/problem+json", "replay-nonce": "retry-nonce" },
            body: { type: "urn:ietf:params:acme:error:badNonce", detail: "bad" },
          };
        }
        return {
          status: 201,
          headers: { "content-type": "application/json", location: "https://acme.test/order/1" },
          body: { status: "pending", identifiers: [], authorizations: [], finalize: "https://acme.test/order/1/finalize" },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const http = new AcmeHttpClient({
      directoryUrl: "https://acme.test/directory",
      signer,
      fetchImpl,
    });

    const resp = await http.signedRequest("https://acme.test/newOrder", { identifiers: [] }, { kid: "kid" });
    expect(resp.status).toBe(201);
    expect(signedCalls).toBe(2);
    // Second attempt used the nonce from the badNonce response, not a fresh HEAD.
    expect(nonceCount).toBe(1);
  });

  it("throws AcmeProblemError on non-badNonce 4xx problem+json", async () => {
    const signer = new JwsSigner(await createPrivateRsaKey(2048));
    const fetchImpl = mkFetch(async (url) => {
      if (url === "https://acme.test/directory")
        return { status: 200, headers: { "content-type": "application/json" }, body: directoryBody };
      if (url === "https://acme.test/nonce")
        return { status: 200, headers: { "replay-nonce": "n" } };
      return {
        status: 403,
        headers: { "content-type": "application/problem+json" },
        body: { type: "urn:ietf:params:acme:error:unauthorized", detail: "nope" },
      };
    });
    const http = new AcmeHttpClient({ directoryUrl: "https://acme.test/directory", signer, fetchImpl });
    await expect(http.signedRequest("https://acme.test/newOrder", {}, { kid: "kid" })).rejects.toBeInstanceOf(AcmeProblemError);
  });
});

describe("parseRetryAfter", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfter("5")).toBe(5);
  });
  it("parses an HTTP date", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const value = parseRetryAfter(future);
    expect(value).toBeGreaterThan(0);
  });
  it("returns undefined for invalid input", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("nonsense")).toBeUndefined();
  });
});
