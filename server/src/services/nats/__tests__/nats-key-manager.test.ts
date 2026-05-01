import { describe, it, expect } from "vitest";
import {
  generateOperator,
  generateAccount,
  reissueOperatorJwt,
  reissueAccountJwt,
  loadKeyPair,
  mintUserCreds,
  mintSystemUserCreds,
  generateScopedSigningKey,
} from "../nats-key-manager";
import { decode } from "nats-jwt";

describe("nats-key-manager", () => {
  it("generates operator material with seed/public/jwt", async () => {
    const op = await generateOperator("test-op");
    expect(op.seed).toMatch(/^SO/);
    expect(op.publicKey).toMatch(/^O/);
    expect(op.jwt.length).toBeGreaterThan(50);
  });

  it("re-derives the same public key when the same seed is loaded", async () => {
    const op = await generateOperator("op");
    const reloaded = await reissueOperatorJwt("op", op.seed);
    expect(reloaded.publicKey).toBe(op.publicKey);
    expect(reloaded.seed).toBe(op.seed);
    // JWT may differ on iat — but the public key must be stable.
    expect(reloaded.jwt.length).toBeGreaterThan(50);
  });

  it("signs an account JWT with the operator and matches public key on reload", async () => {
    const op = await generateOperator("op");
    const operatorKp = loadKeyPair(op.seed);
    const acct = await generateAccount("acct", operatorKp);
    expect(acct.publicKey).toMatch(/^A/);

    const reloaded = await reissueAccountJwt("acct", acct.seed, operatorKp);
    expect(reloaded.publicKey).toBe(acct.publicKey);
  });

  it("mints a creds string containing the user JWT block and seed block", async () => {
    const op = await generateOperator("op");
    const operatorKp = loadKeyPair(op.seed);
    const acct = await generateAccount("acct", operatorKp);
    const accountKp = loadKeyPair(acct.seed);

    const creds = await mintUserCreds(
      "test-user",
      accountKp,
      { pub: ["test.>"], sub: ["test.replies.>"] },
      60,
    );

    expect(creds).toContain("-----BEGIN NATS USER JWT-----");
    expect(creds).toContain("------END NATS USER JWT------");
    expect(creds).toContain("-----BEGIN USER NKEY SEED-----");
    expect(creds).toContain("------END USER NKEY SEED------");
  });

  it("mints system-user creds with broad $SYS pub/sub permissions", async () => {
    const op = await generateOperator("op");
    const operatorKp = loadKeyPair(op.seed);
    const sys = await generateAccount("SYS", operatorKp);
    const sysKp = loadKeyPair(sys.seed);

    const creds = await mintSystemUserCreds(sysKp);

    expect(creds).toContain("BEGIN NATS USER JWT");
    // Extract the JWT block (strip the BEGIN/END framing and join wrapped
    // lines back into the original three-segment dot-delimited JWT).
    const jwtMatch = creds.match(/-----BEGIN NATS USER JWT-----\n([\s\S]*?)\n------END NATS USER JWT------/);
    expect(jwtMatch).not.toBeNull();
    const jwt = jwtMatch![1].replace(/\s+/g, "");
    const claims = decode<{ pub: { allow: string[] }; sub: { allow: string[] } }>(jwt);
    expect(claims.nats.pub?.allow).toContain("$SYS.>");
    expect(claims.nats.sub?.allow).toContain("$SYS.>");
    expect(claims.nats.sub?.allow).toContain("_INBOX.>");
  });

  it("generates a scoped signing key with an account-prefix nkey and the requested role", () => {
    const sk = generateScopedSigningKey({
      role: "worker-minter",
      scopedSubject: "app.stack123.agent.worker.>",
    });

    expect(sk.publicKey).toMatch(/^A/);
    expect(sk.seed).toMatch(/^SA/);
    expect(sk.scopeTemplate.kind).toBe("user_scope");
    expect(sk.scopeTemplate.role).toBe("worker-minter");
    expect(sk.scopeTemplate.key).toBe(sk.publicKey);
    // Pub allow trimmed exactly to the scoped subject.
    expect(sk.scopeTemplate.template.pub?.allow).toEqual(["app.stack123.agent.worker.>"]);
    // Sub allow includes the scoped subject and _INBOX.> for request/reply.
    expect(sk.scopeTemplate.template.sub?.allow).toEqual(["app.stack123.agent.worker.>", "_INBOX.>"]);
  });

  it("splices a scoped signing key into the account JWT when re-issued", async () => {
    const op = await generateOperator("op");
    const operatorKp = loadKeyPair(op.seed);
    const acct = await generateAccount("acct", operatorKp);

    const sk = generateScopedSigningKey({
      role: "worker-minter",
      scopedSubject: "app.s1.agent.>",
    });

    const reissued = await reissueAccountJwt("acct", acct.seed, operatorKp, [sk.scopeTemplate]);
    const claims = decode<{ signing_keys?: Array<{ key: string; role: string }> }>(reissued.jwt);
    const keys = claims.nats.signing_keys ?? [];
    expect(keys).toHaveLength(1);
    // Stored as the SigningKey object form because we passed the scope template.
    expect((keys[0] as { key: string }).key).toBe(sk.publicKey);
    expect((keys[0] as { role: string }).role).toBe("worker-minter");
  });

  it("supports non-expiring user creds when ttlSeconds=0", async () => {
    const op = await generateOperator("op");
    const operatorKp = loadKeyPair(op.seed);
    const acct = await generateAccount("acct", operatorKp);
    const accountKp = loadKeyPair(acct.seed);

    const creds = await mintUserCreds(
      "long-lived",
      accountKp,
      { pub: [">"], sub: [">"] },
      0,
    );

    expect(creds).toContain("BEGIN NATS USER JWT");
  });
});
