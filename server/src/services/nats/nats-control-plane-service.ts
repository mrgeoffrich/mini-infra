import { connect, credsAuthenticator, RetentionPolicy, StorageType, DeliverPolicy, AckPolicy } from "nats";
import type { ConsumerConfig, JetStreamManager, NatsConnection, StreamConfig } from "nats";
import type { SigningKey } from "nats-jwt";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import prisma from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";
import { getVaultKVService } from "../vault/vault-kv-service";
import { VaultKVError } from "../vault/vault-kv-paths";
import {
  generateAccount,
  generateOperator,
  loadKeyPair,
  mintServerBusUserCreds,
  mintSystemUserCreds,
  mintUserCreds,
  reissueAccountJwt,
  reissueOperatorJwt,
  type NatsPermissions,
} from "./nats-key-manager";
import { renderNatsConfig, type RenderedNatsAccount } from "./nats-config-renderer";
import type {
  CreateNatsAccountRequest,
  CreateNatsConsumerRequest,
  CreateNatsCredentialProfileRequest,
  CreateNatsStreamRequest,
  MintNatsCredentialResponse,
  NatsAccountInfo,
  NatsAckPolicy,
  NatsConsumerInfo,
  NatsCredentialProfileInfo,
  NatsDeliverPolicy,
  NatsRetentionPolicy,
  NatsStatus,
  NatsStorageType,
  UpdateNatsAccountRequest,
  UpdateNatsConsumerRequest,
  UpdateNatsCredentialProfileRequest,
  UpdateNatsStreamRequest,
  NatsStreamInfo,
} from "@mini-infra/types";

const log = getLogger("platform", "nats-control-plane");

const OPERATOR_NAME = "mini-infra-operator";
const DEFAULT_ACCOUNT_NAME = "mini-infra-account";
const DEFAULT_ACCOUNT_DISPLAY = "Mini Infra Account";
/**
 * The NATS system account is exclusively for `$SYS.>` administration. NATS
 * 2.10+ refuses to enable JetStream on the system account ("jetstream can
 * not be enabled on the system account") — so the system account must be
 * separate from the default app account, even though they're both managed
 * by Mini Infra. Phase 3 (ALT-28) introduced JetStream-bearing streams +
 * KV buckets on `mini-infra-account`, which forced this split.
 */
const SYSTEM_ACCOUNT_NAME = "mini-infra-system";
const SYSTEM_ACCOUNT_DISPLAY = "Mini Infra System";
export const NATS_SYSTEM_ACCOUNT_KV_PATH = "shared/nats-accounts/mini-infra-system";

export const NATS_OPERATOR_KV_PATH = "shared/nats-operator";
export const NATS_CONFIG_KV_PATH = "shared/nats-config";
export const NATS_DEFAULT_ACCOUNT_KV_PATH = "shared/nats-account";
// Phase 0: system-account user creds + index of all account JWTs. The
// vault-nats v2 entrypoint reads `shared/nats-accounts-index` on cold start
// and writes one file per account into `/data/accounts/`; the control plane
// reads `shared/nats-system-creds` to push live updates via $SYS.REQ.CLAIMS.UPDATE.
export const NATS_SYSTEM_CREDS_KV_PATH = "shared/nats-system-creds";
export const NATS_ACCOUNTS_INDEX_KV_PATH = "shared/nats-accounts-index";
export const NATS_SIGNER_KV_PATH_PREFIX = "shared/nats-signers";
/**
 * `.creds` blob for the server's own bus connection. Bound to the default
 * (non-system) account, scoped to `mini-infra.>` + `_INBOX.>`. Re-minted on
 * every `applyConfig()`; consumed by `NatsBus` at connect time.
 *
 * The path and field are exported together so the writer (this file) and the
 * reader (`nats-bus.ts`) share one source of truth — a typo fix in one would
 * silently break the other.
 */
export const NATS_SERVER_BUS_CREDS_KV_PATH = "shared/nats-server-bus-creds";
export const FIELD_SERVER_BUS_CREDS = "creds";

const FIELD_OPERATOR_SEED = "operator_seed";
const FIELD_OPERATOR_JWT = "operator_jwt";
const FIELD_OPERATOR_PUBLIC = "operator_public";
const FIELD_ACCOUNT_SEED = "account_seed";
const FIELD_ACCOUNT_JWT = "account_jwt";
const FIELD_ACCOUNT_PUBLIC = "account_public";
const FIELD_CONFIG = "conf";
const FIELD_SYSTEM_CREDS = "creds";
const FIELD_ACCOUNTS_INDEX = "index";

/** Path prefix for storing scoped signing-key seeds keyed by stack. */
export function natsSignerSeedKvPath(stackId: string, signerName: string): string {
  return `${NATS_SIGNER_KV_PATH_PREFIX}/${stackId}-${signerName}`;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const SUBJECT_RE = /^[A-Za-z0-9_$*>\-.]+$/;

export interface NatsApplyConfigResult {
  generatedSeeds: boolean;
  operatorPublic: string;
  systemAccountPublic: string | null;
  /**
   * Public keys of accounts whose JWT update could not be propagated to the
   * running NATS server via $SYS.REQ.CLAIMS.UPDATE. The cold-start path
   * (entrypoint reads `shared/nats-accounts-index` on container restart)
   * fixes these on next NATS restart, but until then the live server holds
   * stale claims for the listed accounts. Callers that have a security-
   * sensitive change pending (notably stack destroy revoking signers) must
   * inspect this list and force a NATS restart on a non-empty result.
   */
  unpropagatedAccountPublicKeys: string[];
}

type CredentialWithAccount = Prisma.NatsCredentialProfileGetPayload<{
  include: { account: true };
}>;

type StreamWithAccount = Prisma.NatsStreamGetPayload<{
  include: { account: true };
}>;

type ConsumerWithStream = Prisma.NatsConsumerGetPayload<{
  include: { stream: true };
}>;

export class NatsControlPlaneService {
  // Serialises applyConfig + applyJetStreamResources so concurrent triggers
  // (manual POST /api/nats/apply and the stack-apply NATS phase) cannot race
  // on Vault KV writes or the NatsState upsert.
  private applyChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: PrismaClient = prisma) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.applyChain.then(fn, fn);
    this.applyChain = next.catch(() => undefined);
    return next;
  }

  async getStatus(): Promise<NatsStatus> {
    const [state, accounts, credentialProfiles, streams, consumers] = await Promise.all([
      this.db.natsState.findUnique({ where: { kind: "primary" } }),
      this.db.natsAccount.count(),
      this.db.natsCredentialProfile.count(),
      this.db.natsStream.count(),
      this.db.natsConsumer.count(),
    ]);

    let reachable = false;
    let errorMessage: string | undefined;
    if (state?.monitorUrl) {
      try {
        const res = await fetch(`${state.monitorUrl.replace(/\/$/, "")}/healthz`, {
          signal: AbortSignal.timeout(2500),
        });
        reachable = res.ok;
        if (!res.ok) errorMessage = `NATS monitor returned ${res.status}`;
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      configured: !!state?.clientUrl,
      reachable,
      clientUrl: state?.clientUrl ?? null,
      monitorUrl: state?.monitorUrl ?? null,
      stackId: state?.stackId ?? null,
      bootstrappedAt: state?.bootstrappedAt?.toISOString() ?? null,
      lastAppliedAt: state?.lastAppliedAt?.toISOString() ?? null,
      operatorPublic: state?.operatorPublic ?? null,
      systemAccountPublic: state?.systemAccountPublic ?? null,
      accounts,
      credentialProfiles,
      streams,
      consumers,
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  async setManagedEndpoint(input: {
    stackId: string;
    clientUrl: string;
    monitorUrl: string;
    /**
     * Host-loopback NATS URL (e.g. nats://127.0.0.1:4222). Required for
     * services running in `network_mode: host` where the docker-DNS
     * `clientUrl` cannot resolve. Optional here for forward-compat with
     * older callers; new callers always set it.
     */
    clientHostUrl?: string;
  }): Promise<void> {
    await this.db.natsState.upsert({
      where: { kind: "primary" },
      create: {
        kind: "primary",
        stackId: input.stackId,
        clientUrl: input.clientUrl,
        monitorUrl: input.monitorUrl,
        ...(input.clientHostUrl ? { clientHostUrl: input.clientHostUrl } : {}),
      },
      update: {
        stackId: input.stackId,
        clientUrl: input.clientUrl,
        monitorUrl: input.monitorUrl,
        // `??` not `||` so we can clear with explicit `null` if a future
        // caller wants to (no current call site does, but the type is
        // honest about its semantics).
        clientHostUrl: input.clientHostUrl ?? null,
      },
    });
  }

  async ensureDefaultAccount(): Promise<NatsAccountInfo> {
    // The default app account is NOT the system account — JetStream cannot
    // be enabled on a system account, and Phase 3 puts streams + KV here.
    // The `update.isSystem: false` clause migrates pre-Phase-3 rows where
    // `mini-infra-account` was incorrectly marked as system.
    const account = await this.db.natsAccount.upsert({
      where: { name: DEFAULT_ACCOUNT_NAME },
      create: {
        name: DEFAULT_ACCOUNT_NAME,
        displayName: DEFAULT_ACCOUNT_DISPLAY,
        description: "Default NATS account managed by Mini Infra",
        isSystem: false,
        seedKvPath: NATS_DEFAULT_ACCOUNT_KV_PATH,
      },
      update: { isSystem: false },
    });
    await this.ensureSystemAccount();
    return serializeAccount(account);
  }

  /**
   * Provision the dedicated system account (`mini-infra-system`). Idempotent.
   * Called from `ensureDefaultAccount` so the bootstrap flow always sees
   * both rows; nats-config-renderer picks the `isSystem: true` row to populate
   * `system_account` in nats.conf.
   */
  private async ensureSystemAccount(): Promise<NatsAccountInfo> {
    const account = await this.db.natsAccount.upsert({
      where: { name: SYSTEM_ACCOUNT_NAME },
      create: {
        name: SYSTEM_ACCOUNT_NAME,
        displayName: SYSTEM_ACCOUNT_DISPLAY,
        description: "NATS system account ($SYS.> administration only)",
        isSystem: true,
        seedKvPath: NATS_SYSTEM_ACCOUNT_KV_PATH,
      },
      update: { isSystem: true },
    });
    return serializeAccount(account);
  }

  async listAccounts(): Promise<NatsAccountInfo[]> {
    const rows = await this.db.natsAccount.findMany({ orderBy: [{ isSystem: "desc" }, { name: "asc" }] });
    return rows.map(serializeAccount);
  }

  async createAccount(input: CreateNatsAccountRequest, userId?: string): Promise<NatsAccountInfo> {
    validateName(input.name, "account name");
    const account = await this.db.natsAccount.create({
      data: {
        name: input.name,
        displayName: input.displayName,
        description: input.description ?? null,
        seedKvPath: accountSeedPath(input.name),
        createdById: userId ?? null,
        updatedById: userId ?? null,
      },
    });
    return serializeAccount(account);
  }

  async updateAccount(id: string, input: UpdateNatsAccountRequest, userId?: string): Promise<NatsAccountInfo> {
    const account = await this.db.natsAccount.update({
      where: { id },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updatedById: userId ?? null,
      },
    });
    return serializeAccount(account);
  }

  async deleteAccount(id: string): Promise<void> {
    const account = await this.db.natsAccount.findUnique({ where: { id } });
    if (!account) return;
    if (account.isSystem) {
      throw new Error("System NATS account cannot be deleted");
    }
    await this.db.natsAccount.delete({ where: { id } });
  }

  async listCredentialProfiles(): Promise<NatsCredentialProfileInfo[]> {
    const rows = await this.db.natsCredentialProfile.findMany({
      include: { account: true },
      orderBy: { name: "asc" },
    });
    return rows.map(serializeCredential);
  }

  async createCredentialProfile(input: CreateNatsCredentialProfileRequest, userId?: string): Promise<NatsCredentialProfileInfo> {
    validateName(input.name, "credential profile name");
    validateSubjects(input.publishAllow, "publishAllow");
    validateSubjects(input.subscribeAllow, "subscribeAllow");
    const row = await this.db.natsCredentialProfile.create({
      data: {
        name: input.name,
        displayName: input.displayName,
        description: input.description ?? null,
        accountId: input.accountId,
        publishAllow: input.publishAllow as unknown as Prisma.InputJsonValue,
        subscribeAllow: input.subscribeAllow as unknown as Prisma.InputJsonValue,
        ttlSeconds: input.ttlSeconds ?? 3600,
        createdById: userId ?? null,
        updatedById: userId ?? null,
      },
      include: { account: true },
    });
    return serializeCredential(row);
  }

  async updateCredentialProfile(id: string, input: UpdateNatsCredentialProfileRequest, userId?: string): Promise<NatsCredentialProfileInfo> {
    if (input.publishAllow) validateSubjects(input.publishAllow, "publishAllow");
    if (input.subscribeAllow) validateSubjects(input.subscribeAllow, "subscribeAllow");
    const row = await this.db.natsCredentialProfile.update({
      where: { id },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
        ...(input.publishAllow !== undefined ? { publishAllow: input.publishAllow as unknown as Prisma.InputJsonValue } : {}),
        ...(input.subscribeAllow !== undefined ? { subscribeAllow: input.subscribeAllow as unknown as Prisma.InputJsonValue } : {}),
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
        updatedById: userId ?? null,
      },
      include: { account: true },
    });
    return serializeCredential(row);
  }

  async deleteCredentialProfile(id: string): Promise<void> {
    await this.db.natsCredentialProfile.delete({ where: { id } });
  }

  async mintCredentialsForProfile(profileId: string, ttlOverrideSeconds?: number): Promise<MintNatsCredentialResponse> {
    const profile = await this.db.natsCredentialProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { account: true },
    });
    const creds = await this.mintCredentials(profile, ttlOverrideSeconds);
    const ttl = ttlOverrideSeconds ?? profile.ttlSeconds;
    return {
      profileId: profile.id,
      profileName: profile.name,
      expiresAt: ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null,
      creds,
    };
  }

  async mintCredentials(profile: CredentialWithAccount, ttlOverrideSeconds?: number): Promise<string> {
    const accountSeed = await getVaultKVService().readField(profile.account.seedKvPath, FIELD_ACCOUNT_SEED);
    const accountKp = loadKeyPair(accountSeed);
    const perms: NatsPermissions = {
      pub: readStringArray(profile.publishAllow),
      sub: readStringArray(profile.subscribeAllow),
    };
    return mintUserCreds(profile.name, accountKp, perms, ttlOverrideSeconds ?? profile.ttlSeconds);
  }

  async getInternalUrl(): Promise<string> {
    const state = await this.db.natsState.findUnique({ where: { kind: "primary" } });
    return state?.clientUrl ?? "nats://mini-infra-vault-nats-nats:4222";
  }

  /**
   * Host-loopback NATS URL for `network_mode: host` services that can't
   * resolve docker-internal DNS (e.g. egress-fw-agent, ALT-27). Returns the
   * stored `clientHostUrl` if `applyConfig()` has run since the migration
   * landed, otherwise falls back to `nats://127.0.0.1:4222` (the vault-nats
   * template's host-port default). The fallback exists so a fresh worktree
   * boot doesn't deadlock on apply-ordering — fw-agent injection runs before
   * the next vault-nats apply has had a chance to populate the field.
   */
  async getHostUrl(): Promise<string> {
    const state = await this.db.natsState.findUnique({ where: { kind: "primary" } });
    return state?.clientHostUrl ?? "nats://127.0.0.1:4222";
  }

  async applyConfig(): Promise<NatsApplyConfigResult> {
    return this.serialize(() => this.applyConfigInner());
  }

  private async applyConfigInner(): Promise<NatsApplyConfigResult> {
    await this.ensureDefaultAccount();
    const kv = getVaultKVService();

    let operatorSeed = await this.tryReadField(NATS_OPERATOR_KV_PATH, FIELD_OPERATOR_SEED);
    let generatedSeeds = false;
    if (!operatorSeed) {
      const op = await generateOperator(OPERATOR_NAME);
      await kv.write(NATS_OPERATOR_KV_PATH, {
        [FIELD_OPERATOR_SEED]: op.seed,
        [FIELD_OPERATOR_JWT]: op.jwt,
        [FIELD_OPERATOR_PUBLIC]: op.publicKey,
      });
      operatorSeed = op.seed;
      generatedSeeds = true;
    }

    const operatorKp = loadKeyPair(operatorSeed);
    const operatorMaterial = await reissueOperatorJwt(OPERATOR_NAME, operatorSeed);
    await kv.write(NATS_OPERATOR_KV_PATH, {
      [FIELD_OPERATOR_SEED]: operatorSeed,
      [FIELD_OPERATOR_JWT]: operatorMaterial.jwt,
      [FIELD_OPERATOR_PUBLIC]: operatorMaterial.publicKey,
    });

    // Phase 4: scoped signing keys are stored per-stack on NatsSigningKey.
    // Group them by accountId so each account JWT can be re-issued with the
    // full live set spliced in.
    const signingKeysByAccount = await this.loadAccountSigningKeys();

    const accounts = await this.db.natsAccount.findMany({ orderBy: [{ isSystem: "desc" }, { name: "asc" }] });
    const renderedAccounts: RenderedNatsAccount[] = [];
    let systemAccountPublic: string | null = null;
    let systemAccountSeed: string | null = null;
    let defaultAccountSeed: string | null = null;

    for (const account of accounts) {
      let accountSeed = await this.tryReadField(account.seedKvPath, FIELD_ACCOUNT_SEED);
      if (!accountSeed) {
        const generated = await generateAccount(account.name, operatorKp, [], {
          isSystem: account.isSystem,
        });
        accountSeed = generated.seed;
        generatedSeeds = true;
      }

      const signingKeys = signingKeysByAccount.get(account.id) ?? [];
      // System accounts must be minted without JetStream limits — NATS 2.10+
      // fatal-exits at boot ("Not allowed to enable JetStream on the system
      // account") if the system-account JWT carries `mem_storage` /
      // `disk_storage` etc. App accounts get the full JS limit set.
      const accountMaterial = await reissueAccountJwt(
        account.name,
        accountSeed,
        operatorKp,
        signingKeys,
        { isSystem: account.isSystem },
      );
      await kv.write(account.seedKvPath, {
        [FIELD_ACCOUNT_SEED]: accountSeed,
        [FIELD_ACCOUNT_JWT]: accountMaterial.jwt,
        [FIELD_ACCOUNT_PUBLIC]: accountMaterial.publicKey,
      });
      await this.db.natsAccount.update({
        where: { id: account.id },
        data: {
          publicKey: accountMaterial.publicKey,
          jwt: accountMaterial.jwt,
          lastAppliedAt: new Date(),
        },
      });
      renderedAccounts.push({
        publicKey: accountMaterial.publicKey,
        jwt: accountMaterial.jwt,
      });
      if (account.isSystem && !systemAccountPublic) {
        systemAccountPublic = accountMaterial.publicKey;
        systemAccountSeed = accountSeed;
      }
      if (account.name === DEFAULT_ACCOUNT_NAME) {
        defaultAccountSeed = accountSeed;
      }
    }

    // Phase 0: re-mint system-account user creds on every apply. The user
    // JWT is non-expiring (TTL=0) since the control plane uses it on demand
    // and re-mint cost is negligible — rotating on every apply means a
    // leaked KV blob is invalidated by the next apply rather than living
    // until manual intervention. The user nkey rotates with each mint.
    if (systemAccountSeed) {
      const systemCreds = await mintSystemUserCreds(loadKeyPair(systemAccountSeed));
      await kv.write(NATS_SYSTEM_CREDS_KV_PATH, { [FIELD_SYSTEM_CREDS]: systemCreds });
    }

    // Phase 1 (internal-bus migration): mint a long-lived `.creds` for the
    // server's own NATS bus connection, bound to the default account and
    // scoped to `mini-infra.>` + `_INBOX.>`. Same rotate-every-apply rationale
    // as the system creds above. NatsBus reads this on connect.
    if (defaultAccountSeed) {
      const serverBusCreds = await mintServerBusUserCreds(loadKeyPair(defaultAccountSeed));
      await kv.write(NATS_SERVER_BUS_CREDS_KV_PATH, {
        [FIELD_SERVER_BUS_CREDS]: serverBusCreds,
      });
    } else {
      // ensureDefaultAccount() at the top of this method should always
      // create the row, so this branch only fires if someone manually
      // deleted the account. Without creds the bus loops forever printing
      // "server bus creds not present" — surface the cause loudly.
      log.warn(
        { defaultAccountName: DEFAULT_ACCOUNT_NAME },
        "default NATS account not found during applyConfig; server-bus creds were not minted, NatsBus will be unable to connect",
      );
    }

    // Phase 0: write the full set of account JWTs to a single Vault KV blob
    // so the vault-nats v2 entrypoint can populate /data/accounts/ on cold
    // start of the NATS container. One line per account: <publicKey> <jwt>.
    const accountsIndex = renderedAccounts
      .map((a) => `${a.publicKey} ${a.jwt}`)
      .join("\n");
    await kv.write(NATS_ACCOUNTS_INDEX_KV_PATH, { [FIELD_ACCOUNTS_INDEX]: accountsIndex });

    const conf = renderNatsConfig({
      operatorJwt: operatorMaterial.jwt,
      accounts: renderedAccounts,
      systemAccountPublicKey: systemAccountPublic ?? renderedAccounts[0]?.publicKey,
      jetStream: true,
    });
    await kv.write(NATS_CONFIG_KV_PATH, { [FIELD_CONFIG]: conf });

    await this.db.natsState.upsert({
      where: { kind: "primary" },
      create: {
        kind: "primary",
        bootstrappedAt: new Date(),
        lastAppliedAt: new Date(),
        operatorPublic: operatorMaterial.publicKey,
        systemAccountPublic,
      },
      update: {
        bootstrappedAt: new Date(),
        lastAppliedAt: new Date(),
        operatorPublic: operatorMaterial.publicKey,
        systemAccountPublic,
      },
    });

    // Phase 0: best-effort live propagation of every re-issued account JWT.
    // Failed accounts come back in `unpropagated`; the cold-start path
    // (vault-nats entrypoint reads $NATS_ACCOUNTS_INDEX) repairs them on
    // next NATS restart. Callers with a security-sensitive change pending
    // (notably stack destroy revoking signers) inspect this list and force
    // a NATS recycle on a non-empty result.
    const unpropagatedAccountPublicKeys = await this.propagateAccountClaims(renderedAccounts);

    log.info(
      { accountCount: accounts.length, unpropagated: unpropagatedAccountPublicKeys.length },
      "NATS config rendered to Vault KV",
    );
    return {
      generatedSeeds,
      operatorPublic: operatorMaterial.publicKey,
      systemAccountPublic,
      unpropagatedAccountPublicKeys,
    };
  }

  /**
   * Load all scoped signing keys grouped by their parent account id. Returns
   * one `SigningKey` entry per `NatsSigningKey` row. The orchestrator owns
   * row lifecycle; this method just rebuilds the in-memory list each apply
   * so the next account-JWT re-issue carries the live set.
   */
  private async loadAccountSigningKeys(): Promise<Map<string, SigningKey[]>> {
    const rows = await this.db.natsSigningKey.findMany();
    const out = new Map<string, SigningKey[]>();
    for (const row of rows) {
      const list = out.get(row.accountId) ?? [];
      list.push({
        kind: "user_scope",
        key: row.publicKey,
        role: row.name,
        template: {
          pub: { allow: [row.scopedSubject], deny: [] },
          sub: { allow: [row.scopedSubject, "_INBOX.>"], deny: [] },
        },
      });
      out.set(row.accountId, list);
    }
    return out;
  }

  /**
   * Push every re-issued account JWT to the running NATS server via
   * `$SYS.REQ.CLAIMS.UPDATE`. Failures are caught per-account and returned;
   * the cold-start path (vault-nats entrypoint reads $NATS_ACCOUNTS_INDEX)
   * repairs them on next NATS restart. Callers with a security-sensitive
   * change pending must inspect the result and force a recycle on a
   * non-empty array.
   *
   * Two failure shapes get logged differently:
   *   - "no responders" (503): expected during the v1→v2 upgrade window
   *     when the running server is still on the MEMORY resolver. Logged
   *     at info, not warn.
   *   - Anything else: the resolver is wired up but rejected the claim,
   *     or the connection broke mid-loop. Logged at warn.
   */
  private async propagateAccountClaims(accounts: RenderedNatsAccount[]): Promise<string[]> {
    if (accounts.length === 0) return [];
    const failed: string[] = [];
    try {
      await this.withSystemNats(async (nc) => {
        for (const account of accounts) {
          try {
            await this.requestUpdateClaim(nc, account.publicKey, account.jwt);
          } catch (err) {
            failed.push(account.publicKey);
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("503") || msg.toLowerCase().includes("no responders")) {
              log.info(
                { publicKey: account.publicKey },
                "Account claim update has no responders (full resolver not yet running); cold-start path will seed it",
              );
            } else {
              log.warn(
                { err: msg, publicKey: account.publicKey },
                "Account claim update failed; cold-start path will repair on next NATS restart",
              );
            }
          }
        }
      });
    } catch (err) {
      // System NATS unreachable entirely — every account is unpropagated.
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "System NATS connection unavailable; relying on cold-start propagation",
      );
      for (const account of accounts) {
        if (!failed.includes(account.publicKey)) failed.push(account.publicKey);
      }
    }
    return failed;
  }

  /**
   * Public, callable form of the `$SYS.REQ.CLAIMS.UPDATE` push for a single
   * account. Used by the orchestrator's destroy path so a stack tear-down
   * can revoke its scoped signing keys without waiting for the next apply.
   */
  async updateAccountClaim(publicKey: string, jwt: string): Promise<void> {
    await this.withSystemNats(async (nc) => {
      await this.requestUpdateClaim(nc, publicKey, jwt);
    });
  }

  /**
   * Send one `$SYS.REQ.CLAIMS.UPDATE` request and validate the JSON reply.
   * NATS 2.10+ always replies with JSON of the form `{ data: { code } }` on
   * success or `{ error: { description } }` on failure. We target 2.12+ in
   * the vault-nats template, so a non-JSON reply is genuinely unexpected
   * and surfaced as an error rather than treated as legacy success.
   */
  private async requestUpdateClaim(
    nc: NatsConnection,
    publicKey: string,
    jwt: string,
  ): Promise<void> {
    const reply = await nc.request("$SYS.REQ.CLAIMS.UPDATE", new TextEncoder().encode(jwt), { timeout: 5000 });
    const body = new TextDecoder().decode(reply.data);
    let parsed: { error?: { description?: string }; data?: { code?: number; account?: string } };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      throw new Error(`Account claim update for ${publicKey} returned non-JSON reply: ${body.slice(0, 200)}`);
    }
    if (parsed.error) {
      throw new Error(`Account claim update for ${publicKey} rejected: ${parsed.error.description ?? body}`);
    }
    if (parsed.data?.code !== undefined && parsed.data.code !== 200) {
      throw new Error(`Account claim update for ${publicKey} rejected with code ${parsed.data.code}`);
    }
  }

  private async withSystemNats<T>(fn: (nc: NatsConnection) => Promise<T>): Promise<T> {
    const creds = await this.tryReadField(NATS_SYSTEM_CREDS_KV_PATH, FIELD_SYSTEM_CREDS);
    if (!creds) {
      throw new Error("System NATS creds not yet provisioned in Vault KV");
    }
    const url = await this.getInternalUrl();
    const nc = await connect({
      servers: url,
      authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
      timeout: 5000,
      reconnect: false,
    });
    try {
      return await fn(nc);
    } finally {
      await nc.drain();
    }
  }

  async listStreams(): Promise<NatsStreamInfo[]> {
    const rows = await this.db.natsStream.findMany({ include: { account: true }, orderBy: { name: "asc" } });
    return rows.map(serializeStream);
  }

  async createStream(input: CreateNatsStreamRequest, userId?: string): Promise<NatsStreamInfo> {
    validateName(input.name, "stream name");
    validateSubjects(input.subjects, "subjects");
    const row = await this.db.natsStream.create({
      data: streamData(input, userId),
      include: { account: true },
    });
    return serializeStream(row);
  }

  async updateStream(id: string, input: UpdateNatsStreamRequest, userId?: string): Promise<NatsStreamInfo> {
    if (input.subjects) validateSubjects(input.subjects, "subjects");
    const row = await this.db.natsStream.update({
      where: { id },
      data: {
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.subjects !== undefined ? { subjects: input.subjects as unknown as Prisma.InputJsonValue } : {}),
        ...(input.retention !== undefined ? { retention: input.retention } : {}),
        ...(input.storage !== undefined ? { storage: input.storage } : {}),
        ...(input.maxMsgs !== undefined ? { maxMsgs: input.maxMsgs } : {}),
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
        ...(input.maxAgeSeconds !== undefined ? { maxAgeSeconds: input.maxAgeSeconds } : {}),
        updatedById: userId ?? null,
      },
      include: { account: true },
    });
    return serializeStream(row);
  }

  async deleteStream(id: string): Promise<void> {
    await this.db.natsStream.delete({ where: { id } });
  }

  async listConsumers(): Promise<NatsConsumerInfo[]> {
    const rows = await this.db.natsConsumer.findMany({ include: { stream: true }, orderBy: { name: "asc" } });
    return rows.map(serializeConsumer);
  }

  async createConsumer(input: CreateNatsConsumerRequest, userId?: string): Promise<NatsConsumerInfo> {
    validateName(input.name, "consumer name");
    const row = await this.db.natsConsumer.create({
      data: consumerData(input, userId),
      include: { stream: true },
    });
    return serializeConsumer(row);
  }

  async updateConsumer(id: string, input: UpdateNatsConsumerRequest, userId?: string): Promise<NatsConsumerInfo> {
    const row = await this.db.natsConsumer.update({
      where: { id },
      data: {
        ...(input.streamId !== undefined ? { streamId: input.streamId } : {}),
        ...(input.durableName !== undefined ? { durableName: input.durableName } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.filterSubject !== undefined ? { filterSubject: input.filterSubject } : {}),
        ...(input.deliverPolicy !== undefined ? { deliverPolicy: input.deliverPolicy } : {}),
        ...(input.ackPolicy !== undefined ? { ackPolicy: input.ackPolicy } : {}),
        ...(input.maxDeliver !== undefined ? { maxDeliver: input.maxDeliver } : {}),
        ...(input.ackWaitSeconds !== undefined ? { ackWaitSeconds: input.ackWaitSeconds } : {}),
        updatedById: userId ?? null,
      },
      include: { stream: true },
    });
    return serializeConsumer(row);
  }

  async deleteConsumer(id: string): Promise<void> {
    await this.db.natsConsumer.delete({ where: { id } });
  }

  async applyJetStreamResources(): Promise<void> {
    return this.serialize(() => this.applyJetStreamResourcesInner());
  }

  /**
   * Idempotently ensure JetStream KV buckets exist on the system account.
   * KV buckets are JetStream streams under the hood (named `KV_<bucket>`),
   * but creating one requires admin permission on the account — which only
   * the control plane has. App-level NATS roles (e.g. the egress-gateway's
   * `gw` role) only get publish/subscribe on the bucket's subject namespace
   * once the bucket exists, so the bucket must be pre-seeded by the server.
   *
   * Called from server boot for system-internal buckets (egress-gw-health,
   * egress-fw-health, …). Caller passes the bucket spec list — keeping the
   * spec out of this service avoids a third source of truth for bucket names.
   */
  async ensureSystemKvBuckets(
    buckets: Array<{
      name: string;
      maxAgeSeconds?: number;
      maxBytes?: number;
      description?: string;
    }>,
  ): Promise<void> {
    if (buckets.length === 0) return;
    return this.serialize(async () => {
      const account = await this.db.natsAccount.findUnique({
        where: { name: DEFAULT_ACCOUNT_NAME },
      });
      if (!account) {
        log.warn(
          { account: DEFAULT_ACCOUNT_NAME },
          "ensureSystemKvBuckets: default account missing; deferring",
        );
        return;
      }
      const creds = await this.mintAccountAdminCreds(account);
      const url = await this.getInternalUrl();
      const nc = await connect({
        servers: url,
        authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
        timeout: 5000,
        reconnect: false,
      });
      try {
        const js = nc.jetstream();
        for (const b of buckets) {
          // `views.kv` creates the underlying stream when missing (default
          // `bindOnly: false`). Idempotent — calling twice for the same
          // bucket is a metadata-only round-trip.
          try {
            await js.views.kv(b.name, {
              ...(b.maxAgeSeconds !== undefined
                ? { max_age: b.maxAgeSeconds * 1_000_000_000 }
                : {}),
              ...(b.maxBytes !== undefined ? { max_bytes: b.maxBytes } : {}),
              ...(b.description ? { description: b.description } : {}),
            });
            log.info({ bucket: b.name }, "JetStream KV bucket ensured");
          } catch (err) {
            log.warn(
              { bucket: b.name, err: err instanceof Error ? err.message : String(err) },
              "ensureSystemKvBuckets: bucket create/update failed",
            );
          }
        }
      } finally {
        await nc.drain();
      }
    });
  }

  private async applyJetStreamResourcesInner(): Promise<void> {
    const streams = await this.db.natsStream.findMany({ include: { account: { include: { credentialProfiles: true } } } });
    const consumers = await this.db.natsConsumer.findMany({ include: { stream: { include: { account: true } } } });
    const streamsByAccount = groupBy(streams, (s) => s.accountId);
    const consumersByAccount = groupBy(consumers, (c) => c.stream.accountId);

    for (const [accountId, accountStreams] of streamsByAccount) {
      const account = accountStreams[0]?.account;
      if (!account) continue;
      const creds = await this.mintAccountAdminCreds(account);
      await this.withNats(creds, async (jsm) => {
        for (const stream of accountStreams) {
          const cfg = streamConfig(stream);
          try {
            await jsm.streams.update(stream.name, cfg);
          } catch {
            await jsm.streams.add(cfg);
          }
          await this.db.natsStream.update({ where: { id: stream.id }, data: { lastAppliedAt: new Date() } });
        }
        for (const consumer of consumersByAccount.get(accountId) ?? []) {
          const cfg = consumerConfig(consumer);
          try {
            await jsm.consumers.update(consumer.stream.name, consumer.name, cfg);
          } catch {
            await jsm.consumers.add(consumer.stream.name, cfg);
          }
          await this.db.natsConsumer.update({ where: { id: consumer.id }, data: { lastAppliedAt: new Date() } });
        }
      });
    }
  }

  private async mintAccountAdminCreds(account: { name: string; seedKvPath: string }): Promise<string> {
    const accountSeed = await getVaultKVService().readField(account.seedKvPath, FIELD_ACCOUNT_SEED);
    return mintUserCreds(`${account.name}-mini-infra-admin`, loadKeyPair(accountSeed), { pub: [">"], sub: [">"] }, 300);
  }

  private async withNats<T>(creds: string, fn: (jsm: JetStreamManager) => Promise<T>): Promise<T> {
    const url = await this.getInternalUrl();
    const nc = await connect({
      servers: url,
      authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
      timeout: 5000,
    });
    try {
      const jsm = await nc.jetstreamManager();
      return await fn(jsm);
    } finally {
      await nc.drain();
    }
  }

  private async tryReadField(path: string, field: string): Promise<string | null> {
    try {
      return await getVaultKVService().readField(path, field);
    } catch (err) {
      if (err instanceof VaultKVError && (err.code === "path_not_found" || err.code === "field_not_found")) {
        return null;
      }
      throw err;
    }
  }
}

let singleton: NatsControlPlaneService | null = null;

export function getNatsControlPlaneService(db: PrismaClient = prisma): NatsControlPlaneService {
  if (db !== prisma) return new NatsControlPlaneService(db);
  if (!singleton) singleton = new NatsControlPlaneService(db);
  return singleton;
}

export function __resetNatsControlPlaneServiceForTests(): void {
  singleton = null;
}

function validateName(name: string, label: string): void {
  if (!NAME_RE.test(name)) throw new Error(`${label} must be lowercase alphanumeric with optional '-' or '_'`);
}

function validateSubjects(subjects: string[], label: string): void {
  if (subjects.length === 0) throw new Error(`${label} must contain at least one subject`);
  for (const subject of subjects) {
    if (!SUBJECT_RE.test(subject)) throw new Error(`${label} contains invalid subject '${subject}'`);
  }
}

function readStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function accountSeedPath(name: string): string {
  return name === DEFAULT_ACCOUNT_NAME ? NATS_DEFAULT_ACCOUNT_KV_PATH : `shared/nats-accounts/${name}`;
}

function serializeAccount(account: Prisma.NatsAccountGetPayload<true>): NatsAccountInfo {
  return {
    id: account.id,
    name: account.name,
    displayName: account.displayName,
    description: account.description,
    isSystem: account.isSystem,
    seedKvPath: account.seedKvPath,
    publicKey: account.publicKey,
    jwt: account.jwt,
    lastAppliedAt: account.lastAppliedAt?.toISOString() ?? null,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

function serializeCredential(row: CredentialWithAccount): NatsCredentialProfileInfo {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    accountId: row.accountId,
    accountName: row.account.name,
    publishAllow: readStringArray(row.publishAllow),
    subscribeAllow: readStringArray(row.subscribeAllow),
    ttlSeconds: row.ttlSeconds,
    lastAppliedAt: row.lastAppliedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeStream(row: StreamWithAccount): NatsStreamInfo {
  return {
    id: row.id,
    name: row.name,
    accountId: row.accountId,
    accountName: row.account.name,
    description: row.description,
    subjects: readStringArray(row.subjects),
    retention: row.retention as NatsRetentionPolicy,
    storage: row.storage as NatsStorageType,
    maxMsgs: row.maxMsgs,
    maxBytes: row.maxBytes,
    maxAgeSeconds: row.maxAgeSeconds,
    lastAppliedAt: row.lastAppliedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeConsumer(row: ConsumerWithStream): NatsConsumerInfo {
  return {
    id: row.id,
    streamId: row.streamId,
    streamName: row.stream.name,
    name: row.name,
    durableName: row.durableName,
    description: row.description,
    filterSubject: row.filterSubject,
    deliverPolicy: row.deliverPolicy as NatsDeliverPolicy,
    ackPolicy: row.ackPolicy as NatsAckPolicy,
    maxDeliver: row.maxDeliver,
    ackWaitSeconds: row.ackWaitSeconds,
    lastAppliedAt: row.lastAppliedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function streamData(input: CreateNatsStreamRequest, userId?: string): Prisma.NatsStreamCreateInput {
  return {
    name: input.name,
    account: { connect: { id: input.accountId } },
    description: input.description ?? null,
    subjects: input.subjects as unknown as Prisma.InputJsonValue,
    retention: input.retention ?? "limits",
    storage: input.storage ?? "file",
    maxMsgs: input.maxMsgs ?? null,
    maxBytes: input.maxBytes ?? null,
    maxAgeSeconds: input.maxAgeSeconds ?? null,
    createdById: userId ?? null,
    updatedById: userId ?? null,
  };
}

function consumerData(input: CreateNatsConsumerRequest, userId?: string): Prisma.NatsConsumerCreateInput {
  return {
    stream: { connect: { id: input.streamId } },
    name: input.name,
    durableName: input.durableName ?? input.name,
    description: input.description ?? null,
    filterSubject: input.filterSubject ?? null,
    deliverPolicy: input.deliverPolicy ?? "all",
    ackPolicy: input.ackPolicy ?? "explicit",
    maxDeliver: input.maxDeliver ?? null,
    ackWaitSeconds: input.ackWaitSeconds ?? null,
    createdById: userId ?? null,
    updatedById: userId ?? null,
  };
}

function streamConfig(stream: StreamWithAccount): Partial<StreamConfig> {
  return {
    name: stream.name,
    description: stream.description ?? undefined,
    subjects: readStringArray(stream.subjects),
    retention: retention(stream.retention),
    storage: storage(stream.storage),
    ...(stream.maxMsgs !== null ? { max_msgs: stream.maxMsgs } : {}),
    ...(stream.maxBytes !== null ? { max_bytes: stream.maxBytes } : {}),
    ...(stream.maxAgeSeconds !== null ? { max_age: stream.maxAgeSeconds * 1_000_000_000 } : {}),
  };
}

function consumerConfig(consumer: ConsumerWithStream): Partial<ConsumerConfig> {
  return {
    name: consumer.name,
    durable_name: consumer.durableName ?? consumer.name,
    description: consumer.description ?? undefined,
    filter_subject: consumer.filterSubject ?? undefined,
    deliver_policy: deliverPolicy(consumer.deliverPolicy),
    ack_policy: ackPolicy(consumer.ackPolicy),
    ...(consumer.maxDeliver !== null ? { max_deliver: consumer.maxDeliver } : {}),
    ...(consumer.ackWaitSeconds !== null ? { ack_wait: consumer.ackWaitSeconds * 1_000_000_000 } : {}),
  };
}

function retention(value: string): RetentionPolicy {
  if (value === "interest") return RetentionPolicy.Interest;
  if (value === "workqueue") return RetentionPolicy.Workqueue;
  return RetentionPolicy.Limits;
}

function storage(value: string): StorageType {
  return value === "memory" ? StorageType.Memory : StorageType.File;
}

function deliverPolicy(value: string): DeliverPolicy {
  switch (value) {
    case "last": return DeliverPolicy.Last;
    case "new": return DeliverPolicy.New;
    case "by_start_sequence": return DeliverPolicy.StartSequence;
    case "by_start_time": return DeliverPolicy.StartTime;
    case "last_per_subject": return DeliverPolicy.LastPerSubject;
    default: return DeliverPolicy.All;
  }
}

function ackPolicy(value: string): AckPolicy {
  switch (value) {
    case "none": return AckPolicy.None;
    case "all": return AckPolicy.All;
    default: return AckPolicy.Explicit;
  }
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  }
  return grouped;
}
