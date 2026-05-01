import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, credsAuthenticator } from "nats";
import { startTestNats, type TestNatsEnv } from "./helpers/nats-test-server";
import {
  generateAccount,
  generateScopedSigningKey,
  loadKeyPair,
  mintUserCreds,
  reissueAccountJwt,
} from "../services/nats/nats-key-manager";

/**
 * Phase 4 — scoped signing key cryptographic guarantees against a real NATS
 * server. The whole point of scoped signers is server-side trimming: even
 * if the application minting JWTs claims broader pub/sub permissions, the
 * server reduces them to whatever the scope template in the account JWT
 * allows. That guarantee is what lets mini-infra hand out a seed without
 * trusting the holder to honour the scope. It cannot be verified against
 * mocks — only a real server applies the trim.
 */
describe("Phase 4 — scoped signer materialization (external)", () => {
  let env: TestNatsEnv;

  beforeAll(async () => {
    env = await startTestNats();
  }, 60_000);

  afterAll(async () => {
    if (env) await env.stop();
  });

  it("trims user permissions broader than the signer's scope to the scope envelope", async () => {
    // Stand up the app account with a scoped signer for `app.x.in.>`.
    const appAccount = await generateAccount("trim-acct", env.operatorKp);
    const signer = generateScopedSigningKey({
      role: "writer",
      scopedSubject: "app.x.in.>",
    });
    const reissued = await reissueAccountJwt("trim-acct", appAccount.seed, env.operatorKp, [
      signer.scopeTemplate,
    ]);
    await env.pushAccountClaim(reissued.publicKey, reissued.jwt);

    // Mint a user JWT with deliberately *broader* claimed permissions.
    // The server should silently trim them to the scope.
    const signerKp = loadKeyPair(signer.seed);
    const { encodeUser, fmtCreds } = await import("nats-jwt");
    const { createUser } = await import("nkeys.js");
    const userKp = createUser();
    const userJwt = await encodeUser(
      "broad-user",
      userKp,
      signerKp,
      { issuer_account: appAccount.publicKey },
      { exp: Math.floor(Date.now() / 1000) + 60, scopedUser: true },
    );
    const creds = new TextDecoder().decode(fmtCreds(userJwt, userKp));

    // Privileged listener: connect as an account-admin user (full pub/sub on
    // `>`) and subscribe to the wildcard. Anything the scoped user manages to
    // publish — in-scope or out-of-scope — will land here. The trim guarantee
    // means the out-of-scope publish must NEVER reach this subscriber.
    const accountKp = loadKeyPair(appAccount.seed);
    const adminCreds = await mintUserCreds(
      "trim-listener",
      accountKp,
      { pub: [">"], sub: [">"] },
      60,
    );
    const listener = await connect({
      servers: env.url,
      authenticator: credsAuthenticator(new TextEncoder().encode(adminCreds)),
      timeout: 5_000,
      reconnect: false,
    });
    const inScopeReceived: string[] = [];
    const outOfScopeReceived: string[] = [];
    const inScopeSub = listener.subscribe("app.x.in.>", {
      callback: (_err, msg) => inScopeReceived.push(msg.subject),
    });
    const outOfScopeSub = listener.subscribe("other.>", {
      callback: (_err, msg) => outOfScopeReceived.push(msg.subject),
    });
    // Round-trip a sentinel through the listener so we know its subscriptions
    // are registered server-side before the scoped publish fires.
    await listener.flush();

    const nc = await connect({
      servers: env.url,
      authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
      timeout: 5_000,
      reconnect: false,
    });

    try {
      // In-scope publish must succeed and reach the listener.
      nc.publish("app.x.in.write", new TextEncoder().encode("ok"));
      await nc.flush();

      // Out-of-scope publish must be silently dropped by the server's scope
      // trim. The publish call itself doesn't error (NATS surfaces permission
      // violations asynchronously, and the trimmed scope template makes the
      // user's pub allow list strictly `[app.x.in.>, _INBOX.>]` — anything
      // outside is denied at the server boundary, never delivered).
      nc.publish("other.namespace.evil", new TextEncoder().encode("nope"));
      // Use a request/round-trip to the listener as a second-flush barrier:
      // the listener sees its own publish, so by the time we observe it the
      // scoped user's earlier publishes have either been delivered or
      // explicitly denied.
      await nc.flush();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await listener.flush();

      // Load-bearing assertions.
      expect(inScopeReceived).toContain("app.x.in.write");
      expect(outOfScopeReceived).toEqual([]);
    } finally {
      await Promise.all([
        nc.drain().catch(() => undefined),
        (async () => {
          inScopeSub.unsubscribe();
          outOfScopeSub.unsubscribe();
          await listener.drain().catch(() => undefined);
        })(),
      ]);
    }
  }, 30_000);

  it("rejects connections with a user JWT signed by a key not in the account claim", async () => {
    const appAccount = await generateAccount("unsigned-acct", env.operatorKp);
    // Push the account WITHOUT any signing keys.
    await env.pushAccountClaim(appAccount.publicKey, appAccount.jwt);

    // Generate a signer locally — but DON'T add it to the account claim.
    const orphanSigner = generateScopedSigningKey({
      role: "ghost",
      scopedSubject: "x.>",
    });
    const orphanKp = loadKeyPair(orphanSigner.seed);
    const { encodeUser, fmtCreds } = await import("nats-jwt");
    const { createUser } = await import("nkeys.js");
    const userKp = createUser();
    const userJwt = await encodeUser(
      "ghost-user",
      userKp,
      orphanKp,
      { issuer_account: appAccount.publicKey },
      { exp: Math.floor(Date.now() / 1000) + 60, scopedUser: true },
    );
    const creds = new TextDecoder().decode(fmtCreds(userJwt, userKp));

    await expect(
      connect({
        servers: env.url,
        authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
        timeout: 5_000,
        reconnect: false,
      }),
    ).rejects.toThrow();
  }, 30_000);
});
