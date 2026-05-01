import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import type { KeyPair } from "nkeys.js";
import {
  generateAccount,
  generateOperator,
  loadKeyPair,
  mintSystemUserCreds,
  reissueAccountJwt,
  type AccountMaterial,
  type OperatorMaterial,
} from "../../services/nats/nats-key-manager";
import { renderNatsConfig } from "../../services/nats/nats-config-renderer";

/**
 * Boot a real `nats:2.12.8-alpine` container with the full account resolver
 * plus a freshly-minted operator + system account + system-admin user.
 *
 * What this is for: verifying the cryptographic guarantees of Phase 0 + 4
 * end-to-end. Mocks can prove the orchestrator wrote the right rows, but
 * only a real `nats-server` can prove that scoped signers actually trim
 * user permissions, that `$SYS.REQ.CLAIMS.UPDATE` propagates within seconds,
 * and that revocation invalidates new connections.
 *
 * Usage:
 *   const env = await startTestNats();
 *   try {
 *     // env.url, env.systemCreds, env.sysAccountKp, env.operatorKp ready.
 *   } finally {
 *     await env.stop();
 *   }
 *
 * The container is opaque from the test's perspective — there's no shared
 * state with the production NatsControlPlaneService singleton. Tests that
 * exercise the control plane create their own service instance against the
 * returned URL.
 */
export interface TestNatsEnv {
  url: string;
  systemCreds: string;
  operatorMaterial: OperatorMaterial;
  operatorKp: KeyPair;
  systemAccountMaterial: AccountMaterial;
  sysAccountKp: KeyPair;
  /** Push an updated account JWT to the running server. Mirrors what the
   *  control plane does in production via `$SYS.REQ.CLAIMS.UPDATE`. */
  pushAccountClaim(publicKey: string, jwt: string): Promise<void>;
  stop(): Promise<void>;
}

const NATS_IMAGE = "nats:2.12.8-alpine";
const ACCOUNTS_DIR = "/data/accounts";

export async function startTestNats(): Promise<TestNatsEnv> {
  // Build operator + system-account material before booting the container so
  // we can seed the JWTs into /data/accounts on first start. Production does
  // this via the vault-nats v2 entrypoint reading $NATS_ACCOUNTS_INDEX; the
  // test rig writes the same files directly.
  const operatorMaterial = await generateOperator("test-op");
  const operatorKp = loadKeyPair(operatorMaterial.seed);

  const systemAccountMaterial = await generateAccount("SYS", operatorKp);
  const sysAccountKp = loadKeyPair(systemAccountMaterial.seed);

  // Re-issue with a stable JWT (the renderer needs a deterministic value).
  const reissuedSys = await reissueAccountJwt("SYS", systemAccountMaterial.seed, operatorKp);
  const systemCreds = await mintSystemUserCreds(sysAccountKp);

  const conf = renderNatsConfig({
    operatorJwt: operatorMaterial.jwt,
    accounts: [{ publicKey: reissuedSys.publicKey, jwt: reissuedSys.jwt }],
    systemAccountPublicKey: reissuedSys.publicKey,
    jetStream: true,
    jetStreamStoreDir: "/data/jetstream",
    resolverDir: ACCOUNTS_DIR,
  });

  // Wrap nats-server with a tiny shim so the seed JWT lands on disk before
  // the server starts. Mirrors the production vault-nats entrypoint.
  const initScript = [
    `mkdir -p ${ACCOUNTS_DIR}`,
    `printf '%s' "$NATS_CONF" > /etc/nats.conf`,
    `printf '%s' "$INITIAL_ACCOUNT_JWT" > ${ACCOUNTS_DIR}/$INITIAL_ACCOUNT_PUBLIC.jwt`,
    `exec nats-server -c /etc/nats.conf -m 8222`,
  ].join(" && ");

  const container = await new GenericContainer(NATS_IMAGE)
    .withEnvironment({
      NATS_CONF: conf,
      INITIAL_ACCOUNT_PUBLIC: reissuedSys.publicKey,
      INITIAL_ACCOUNT_JWT: reissuedSys.jwt,
    })
    .withEntrypoint(["sh", "-c", initScript])
    .withExposedPorts(4222, 8222)
    .withWaitStrategy(Wait.forHttp("/healthz", 8222).forStatusCode(200))
    .withStartupTimeout(20_000)
    .start();

  const port = container.getMappedPort(4222);
  const host = container.getHost();
  const url = `nats://${host}:${port}`;

  // Lazy-load `nats` once we have a URL. We don't keep a cached client —
  // each push opens its own short-lived connection so tests can verify
  // claim updates from a fresh-connection perspective if they want to.
  const env: TestNatsEnv = {
    url,
    systemCreds,
    operatorMaterial,
    operatorKp,
    systemAccountMaterial: reissuedSys,
    sysAccountKp,
    async pushAccountClaim(_publicKey: string, jwt: string): Promise<void> {
      const { connect, credsAuthenticator } = await import("nats");
      const nc = await connect({
        servers: url,
        authenticator: credsAuthenticator(new TextEncoder().encode(systemCreds)),
        timeout: 5000,
        reconnect: false,
      });
      try {
        const reply = await nc.request(
          "$SYS.REQ.CLAIMS.UPDATE",
          new TextEncoder().encode(jwt),
          { timeout: 5000 },
        );
        const body = new TextDecoder().decode(reply.data);
        try {
          const parsed = JSON.parse(body) as { error?: { description?: string } };
          if (parsed.error) {
            throw new Error(`Claims update rejected: ${parsed.error.description ?? body}`);
          }
        } catch (parseErr) {
          if (parseErr instanceof SyntaxError) {
            // Plain-text reply — treat as success unless explicitly negative.
            if (body && !body.toLowerCase().includes("ok")) {
              throw new Error(`Unexpected non-JSON claims update reply: ${body}`, { cause: parseErr });
            }
          } else {
            throw parseErr;
          }
        }
      } finally {
        await nc.drain();
      }
    },
    async stop(): Promise<void> {
      await stopContainer(container);
    },
  };
  return env;
}

async function stopContainer(c: StartedTestContainer): Promise<void> {
  try {
    await c.stop({ timeout: 5_000 });
  } catch {
    // best-effort — testcontainers stops are advisory in CI
  }
}
