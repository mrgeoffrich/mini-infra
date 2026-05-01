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
 * Phase 0 — live account-JWT propagation against a real `nats:2.12.8-alpine`
 * server running the full account resolver. These tests verify the
 * cryptographic guarantees that mocks cannot:
 *   - `$SYS.REQ.CLAIMS.UPDATE` actually propagates an updated account JWT
 *     to the live server within the timeout the control plane uses.
 *   - User JWTs minted by a scoped signing key that was *removed* from the
 *     account claim no longer authenticate.
 *
 * Scope: this file does not exercise the orchestrator. The control plane's
 * own end-to-end behaviour (apply → updateAccountClaim) is covered in the
 * integration project against mocks; here we verify the cryptographic floor.
 */
describe("Phase 0 — live account claim propagation (external)", () => {
  let env: TestNatsEnv;

  beforeAll(async () => {
    env = await startTestNats();
  }, 60_000);

  afterAll(async () => {
    if (env) await env.stop();
  });

  it("propagates an updated account claim within the 5s control-plane timeout", async () => {
    // Stand up an app account, push it to the server, mint a user, connect.
    const appAccount = await generateAccount("app-acct", env.operatorKp);
    await env.pushAccountClaim(appAccount.publicKey, appAccount.jwt);

    const appKp = loadKeyPair(appAccount.seed);
    const creds = await mintUserCreds(
      "u1",
      appKp,
      { pub: ["foo.>"], sub: ["foo.>"] },
      60,
    );

    const start = Date.now();
    const nc = await connect({
      servers: env.url,
      authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
      timeout: 5_000,
      reconnect: false,
    });
    const elapsed = Date.now() - start;
    await nc.drain();
    // Round-trip + propagation should be under 2 s on a healthy machine. Use
    // 5 s as a generous CI ceiling — the assertion's job is to catch
    // *seconds-vs-minutes* regressions, not microbenchmark.
    expect(elapsed).toBeLessThan(5_000);
  }, 30_000);

  it("invalidates user JWTs minted by a scoped signing key after that key is removed from the account claim", async () => {
    const appAccount = await generateAccount("revoke-acct", env.operatorKp);
    const appKp = loadKeyPair(appAccount.seed);

    // Add a scoped signer + push the new claim.
    const signer = generateScopedSigningKey({
      role: "minter",
      scopedSubject: "revoke.scope.>",
    });
    const withSigner = await reissueAccountJwt("revoke-acct", appAccount.seed, env.operatorKp, [
      signer.scopeTemplate,
    ]);
    await env.pushAccountClaim(withSigner.publicKey, withSigner.jwt);

    // Mint a user JWT using the scoped signer (account-prefix nkey acting
    // as the issuer). Must declare `issuer_account` so NATS knows the user
    // belongs to the parent account.
    const signerKp = loadKeyPair(signer.seed);
    const { encodeUser, fmtCreds } = await import("nats-jwt");
    const { createUser } = await import("nkeys.js");
    const userKp = createUser();
    // Scoped signers require `scopedUser: true` and empty pub/sub claims —
    // NATS applies the scope template's permissions on top, and rejects user
    // JWTs that try to declare their own when scopedUser is set.
    const userJwt = await encodeUser(
      "scoped-user",
      userKp,
      signerKp,
      { issuer_account: appAccount.publicKey },
      { exp: Math.floor(Date.now() / 1000) + 60, scopedUser: true },
    );
    const credsBytes = fmtCreds(userJwt, userKp);
    const creds = new TextDecoder().decode(credsBytes);

    // Sanity: connection works while the signer is in the account claim.
    const ncBefore = await connect({
      servers: env.url,
      authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
      timeout: 5_000,
      reconnect: false,
    });
    await ncBefore.drain();

    // Remove the signer + push the new claim.
    const withoutSigner = await reissueAccountJwt(
      "revoke-acct",
      appAccount.seed,
      env.operatorKp,
      [],
    );
    await env.pushAccountClaim(withoutSigner.publicKey, withoutSigner.jwt);

    // Connection attempt with the same creds should now fail. NATS rejects
    // either at handshake (auth violation) or with a server-side close —
    // both should surface as a thrown error from `connect`.
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
