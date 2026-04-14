import { describe, expect, it } from "vitest";
import { AcmeClient } from "../src/client";
import { createPrivateRsaKey } from "../src/crypto/keys";
import { createCsr } from "../src/crypto/csr";

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  bodyText?: string;
}

const respond = (r: FakeResponse): Response => {
  const text = r.bodyText ?? (r.body === undefined ? "" : JSON.stringify(r.body));
  return new Response(text, { status: r.status, headers: r.headers });
};

describe("AcmeClient full issuance flow", () => {
  it("completes account creation, order, dns-01 challenge, finalize, and cert retrieval", async () => {
    let nonceCounter = 0;
    let authzStatus: "pending" | "valid" = "pending";
    let orderStatus: "pending" | "ready" | "processing" | "valid" = "pending";
    let createdChallenge: { token: string; keyAuth?: string } | null = null;

    const directory = {
      newNonce: "https://acme.test/nonce",
      newAccount: "https://acme.test/newAccount",
      newOrder: "https://acme.test/newOrder",
      revokeCert: "https://acme.test/revokeCert",
      meta: { termsOfService: "https://acme.test/tos" },
    };

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const json = init?.body ? JSON.parse(init.body as string) : undefined;

      if (url === "https://acme.test/directory") {
        return respond({ status: 200, headers: { "content-type": "application/json" }, body: directory });
      }
      if (url === "https://acme.test/nonce" && method === "HEAD") {
        nonceCounter += 1;
        return respond({ status: 200, headers: { "replay-nonce": `n-${nonceCounter}` } });
      }
      if (url === "https://acme.test/newAccount") {
        nonceCounter += 1;
        return respond({
          status: 201,
          headers: {
            "content-type": "application/json",
            location: "https://acme.test/acct/1",
            "replay-nonce": `n-${nonceCounter}`,
          },
          body: { status: "valid", contact: json?.payload ? [] : [] },
        });
      }
      if (url === "https://acme.test/newOrder") {
        nonceCounter += 1;
        orderStatus = "pending";
        authzStatus = "pending";
        return respond({
          status: 201,
          headers: {
            "content-type": "application/json",
            location: "https://acme.test/order/1",
            "replay-nonce": `n-${nonceCounter}`,
          },
          body: {
            status: orderStatus,
            identifiers: [{ type: "dns", value: "example.com" }],
            authorizations: ["https://acme.test/authz/1"],
            finalize: "https://acme.test/order/1/finalize",
          },
        });
      }
      if (url === "https://acme.test/authz/1") {
        nonceCounter += 1;
        return respond({
          status: 200,
          headers: { "content-type": "application/json", "replay-nonce": `n-${nonceCounter}` },
          body: {
            status: authzStatus,
            identifier: { type: "dns", value: "example.com" },
            challenges: [
              { type: "dns-01", url: "https://acme.test/chal/1", status: "pending", token: "TOKEN123" },
              { type: "http-01", url: "https://acme.test/chal/2", status: "pending", token: "HTOKEN" },
            ],
          },
        });
      }
      if (url === "https://acme.test/chal/1") {
        nonceCounter += 1;
        authzStatus = "valid";
        orderStatus = "ready";
        return respond({
          status: 200,
          headers: { "content-type": "application/json", "replay-nonce": `n-${nonceCounter}` },
          body: { type: "dns-01", url, status: "valid", token: "TOKEN123" },
        });
      }
      if (url === "https://acme.test/order/1/finalize") {
        nonceCounter += 1;
        orderStatus = "valid";
        return respond({
          status: 200,
          headers: { "content-type": "application/json", "replay-nonce": `n-${nonceCounter}` },
          body: {
            status: orderStatus,
            identifiers: [{ type: "dns", value: "example.com" }],
            authorizations: ["https://acme.test/authz/1"],
            finalize: url,
            certificate: "https://acme.test/cert/1",
          },
        });
      }
      if (url === "https://acme.test/order/1") {
        nonceCounter += 1;
        return respond({
          status: 200,
          headers: { "content-type": "application/json", "replay-nonce": `n-${nonceCounter}` },
          body: {
            status: orderStatus,
            identifiers: [{ type: "dns", value: "example.com" }],
            authorizations: ["https://acme.test/authz/1"],
            finalize: "https://acme.test/order/1/finalize",
            certificate: orderStatus === "valid" ? "https://acme.test/cert/1" : undefined,
          },
        });
      }
      if (url === "https://acme.test/cert/1") {
        nonceCounter += 1;
        return respond({
          status: 200,
          headers: { "content-type": "application/pem-certificate-chain", "replay-nonce": `n-${nonceCounter}` },
          bodyText: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
        });
      }
      if (url === "https://acme.test/revokeCert") {
        nonceCounter += 1;
        return respond({
          status: 200,
          headers: { "content-type": "application/json", "replay-nonce": `n-${nonceCounter}` },
          body: {},
        });
      }
      throw new Error(`Unexpected URL: ${url} (${method})`);
    }) as typeof fetch;

    const accountKey = await createPrivateRsaKey(2048);
    const client = new AcmeClient({
      directoryUrl: "https://acme.test/directory",
      accountKey,
      fetchImpl,
      backoffMinMs: 1,
      backoffMaxMs: 1,
    });

    const { csrPem } = createCsr({ altNames: ["example.com"] });

    const cert = await client.auto({
      csr: csrPem,
      domains: ["example.com"],
      termsOfServiceAgreed: true,
      email: "admin@example.com",
      skipChallengeVerification: true,
      challengeCreateFn: async (_authz, challenge, keyAuth) => {
        createdChallenge = { token: challenge.token, keyAuth };
      },
      challengeRemoveFn: async () => {
        createdChallenge = null;
      },
    });

    expect(cert).toContain("BEGIN CERTIFICATE");
    expect(createdChallenge).toBeNull(); // cleaned up
  });

  it("revokeCertificate sends signed POST to revokeCert URL", async () => {
    const directory = {
      newNonce: "https://acme.test/nonce",
      newAccount: "https://acme.test/newAccount",
      newOrder: "https://acme.test/newOrder",
      revokeCert: "https://acme.test/revokeCert",
    };
    let revokeCalled = false;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://acme.test/directory")
        return respond({ status: 200, headers: { "content-type": "application/json" }, body: directory });
      if (url === "https://acme.test/nonce")
        return respond({ status: 200, headers: { "replay-nonce": "nn" } });
      if (url === "https://acme.test/revokeCert") {
        revokeCalled = true;
        const body = JSON.parse(init!.body as string);
        expect(body.payload).toBeTruthy();
        return respond({ status: 200, headers: { "content-type": "application/json" }, body: {} });
      }
      throw new Error("unexpected " + url);
    }) as typeof fetch;

    const client = new AcmeClient({
      directoryUrl: "https://acme.test/directory",
      accountKey: await createPrivateRsaKey(2048),
      accountUrl: "https://acme.test/acct/1",
      fetchImpl,
    });
    const certPem = "-----BEGIN CERTIFICATE-----\nQUFB\n-----END CERTIFICATE-----\n";
    await client.revokeCertificate(certPem);
    expect(revokeCalled).toBe(true);
  });
});
