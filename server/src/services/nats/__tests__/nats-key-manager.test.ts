import { describe, it, expect } from "vitest";
import {
  generateOperator,
  generateAccount,
  reissueOperatorJwt,
  reissueAccountJwt,
  loadKeyPair,
  mintUserCreds,
} from "../nats-key-manager";

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
