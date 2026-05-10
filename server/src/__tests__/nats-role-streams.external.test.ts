import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, credsAuthenticator, AckPolicy } from "nats";
import { startTestNats, type TestNatsEnv } from "./helpers/nats-test-server";
import { generateAccount, loadKeyPair, mintUserCreds, reissueAccountJwt } from "../services/nats/nats-key-manager";

/**
 * Phase 6 — JetStream-for-apps end-to-end against a real `nats:2.12.8-alpine`.
 *
 * The integration tests pin DB-side materialization (NatsStream/NatsConsumer
 * rows with prefixed subjects, and the JS API grants list on the role's
 * NatsCredentialProfile). What only a real NATS can confirm is the
 * compound guarantee:
 *
 *   - With the **exact** grant set the orchestrator's `materializeRole`
 *     produces for a role with `streams[]` + `consumers[]`, a service
 *     bound to that role can publish into the prefixed stream subjects,
 *     bind the durable consumer, pull, and ACK — all without any system-
 *     admin creds.
 *
 * If a future refactor drops one of the JS API grants (`STREAM.INFO`,
 * `CONSUMER.INFO`, `CONSUMER.CREATE`, `CONSUMER.MSG.NEXT`, or `$JS.ACK.>`),
 * this test will fail with a permissions-violation surfaced by the live
 * server — exactly the regression we can't catch with mocks.
 */
describe("Phase 6 — JetStream-for-apps role pub/consume (external)", () => {
  let env: TestNatsEnv;

  beforeAll(async () => {
    env = await startTestNats();
  }, 60_000);

  afterAll(async () => {
    if (env) await env.stop();
  });

  it("a role-bound connection can publish to its stream and consume via its durable consumer", async () => {
    // Stand up an app account with JetStream available — the test rig already
    // boots `nats-server` with JS enabled on the system account, but each
    // app account gets JS turned on via its own JWT claim. We push the
    // account WITHOUT special claims (default JS quotas suffice for a tiny
    // test stream) and rely on the unbounded test config.
    const account = await generateAccount("rolejs-acct", env.operatorKp);
    const reissued = await reissueAccountJwt(
      "rolejs-acct",
      account.seed,
      env.operatorKp,
    );
    await env.pushAccountClaim(reissued.publicKey, reissued.jwt);
    const accountKp = loadKeyPair(account.seed);

    // Concrete materialized names, mirroring what the orchestrator produces
    // for a stack with id "stk-rolejs", role "worker", stream "jobs",
    // consumer "pull". The orchestrator's `concreteName` lower-cases and
    // hyphen-collapses; the inputs here are already normalised to keep the
    // expected names short and readable in assertions.
    const subjectPrefix = "app.stk-rolejs";
    const streamName = "stk-rolejs-worker-jobs";
    const consumerName = "stk-rolejs-worker-jobs-pull";
    const streamSubjectPattern = `${subjectPrefix}.work.>`;

    // Use account-admin creds to create the JetStream stream + consumer up
    // front. In production the control plane's `applyJetStreamResources()`
    // does this; here we collapse it inline because the apply orchestrator
    // isn't under test on this path.
    const adminCreds = await mintUserCreds(
      "admin",
      accountKp,
      { pub: [">"], sub: [">"] },
      300,
    );
    const adminNc = await connect({
      servers: env.url,
      authenticator: credsAuthenticator(new TextEncoder().encode(adminCreds)),
      timeout: 5_000,
      reconnect: false,
    });
    try {
      const jsm = await adminNc.jetstreamManager();
      await jsm.streams.add({ name: streamName, subjects: [streamSubjectPattern] });
      await jsm.consumers.add(streamName, {
        durable_name: consumerName,
        ack_policy: AckPolicy.Explicit,
        filter_subject: `${subjectPrefix}.work.in.>`,
      });
    } finally {
      await adminNc.drain();
    }

    // Mint role creds with the **exact** grant set materializeRole produces
    // for `roles[].streams[]` + `roles[].consumers[]`. Anything missing
    // here (e.g. dropping CONSUMER.MSG.NEXT) will surface as a real
    // permissions violation when we try to pull below.
    const roleCreds = await mintUserCreds(
      "worker-role",
      accountKp,
      {
        pub: [
          streamSubjectPattern,
          "_INBOX.>",
          `$JS.API.STREAM.INFO.${streamName}`,
          `$JS.API.CONSUMER.INFO.${streamName}.${consumerName}`,
          `$JS.API.CONSUMER.CREATE.${streamName}.${consumerName}`,
          `$JS.API.CONSUMER.MSG.NEXT.${streamName}.${consumerName}`,
          `$JS.ACK.${streamName}.${consumerName}.>`,
        ],
        sub: [streamSubjectPattern, "_INBOX.>"],
      },
      300,
    );

    const nc = await connect({
      servers: env.url,
      authenticator: credsAuthenticator(new TextEncoder().encode(roleCreds)),
      timeout: 5_000,
      reconnect: false,
    });
    try {
      const js = nc.jetstream();

      // Publish into the stream as a role-bound producer. NATS routes the
      // message into the stream because the subject matches the stream's
      // declared filter pattern.
      const ack = await js.publish(
        `${subjectPrefix}.work.in.42`,
        new TextEncoder().encode("hello-jetstream"),
      );
      expect(ack.stream).toBe(streamName);

      // Pull-fetch from the durable consumer. The pull-bind exercises
      // CONSUMER.INFO + CONSUMER.MSG.NEXT; the explicit ack exercises
      // `$JS.ACK.>`. Any missing grant surfaces as a permissions error.
      const c = await js.consumers.get(streamName, consumerName);
      const messages = await c.fetch({ max_messages: 1, expires: 3_000 });

      const received: string[] = [];
      for await (const m of messages) {
        received.push(new TextDecoder().decode(m.data));
        m.ack();
      }
      expect(received).toEqual(["hello-jetstream"]);
    } finally {
      await nc.drain();
    }
  }, 60_000);
});
