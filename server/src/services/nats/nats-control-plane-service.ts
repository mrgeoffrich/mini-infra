import { connect, credsAuthenticator, RetentionPolicy, StorageType, DeliverPolicy, AckPolicy } from "nats";
import type { ConsumerConfig, JetStreamManager, StreamConfig } from "nats";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import prisma from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";
import { getVaultKVService } from "../vault/vault-kv-service";
import { VaultKVError } from "../vault/vault-kv-paths";
import {
  generateAccount,
  generateOperator,
  loadKeyPair,
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

export const NATS_OPERATOR_KV_PATH = "shared/nats-operator";
export const NATS_CONFIG_KV_PATH = "shared/nats-config";
export const NATS_DEFAULT_ACCOUNT_KV_PATH = "shared/nats-account";

const FIELD_OPERATOR_SEED = "operator_seed";
const FIELD_OPERATOR_JWT = "operator_jwt";
const FIELD_OPERATOR_PUBLIC = "operator_public";
const FIELD_ACCOUNT_SEED = "account_seed";
const FIELD_ACCOUNT_JWT = "account_jwt";
const FIELD_ACCOUNT_PUBLIC = "account_public";
const FIELD_CONFIG = "conf";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const SUBJECT_RE = /^[A-Za-z0-9_$*>\-.]+$/;

export interface NatsApplyConfigResult {
  generatedSeeds: boolean;
  operatorPublic: string;
  systemAccountPublic: string | null;
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
  }): Promise<void> {
    await this.db.natsState.upsert({
      where: { kind: "primary" },
      create: {
        kind: "primary",
        stackId: input.stackId,
        clientUrl: input.clientUrl,
        monitorUrl: input.monitorUrl,
      },
      update: {
        stackId: input.stackId,
        clientUrl: input.clientUrl,
        monitorUrl: input.monitorUrl,
      },
    });
  }

  async ensureDefaultAccount(): Promise<NatsAccountInfo> {
    const account = await this.db.natsAccount.upsert({
      where: { name: DEFAULT_ACCOUNT_NAME },
      create: {
        name: DEFAULT_ACCOUNT_NAME,
        displayName: DEFAULT_ACCOUNT_DISPLAY,
        description: "Default NATS account managed by Mini Infra",
        isSystem: true,
        seedKvPath: NATS_DEFAULT_ACCOUNT_KV_PATH,
      },
      update: {},
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

    const accounts = await this.db.natsAccount.findMany({ orderBy: [{ isSystem: "desc" }, { name: "asc" }] });
    const renderedAccounts: RenderedNatsAccount[] = [];
    let systemAccountPublic: string | null = null;

    for (const account of accounts) {
      let accountSeed = await this.tryReadField(account.seedKvPath, FIELD_ACCOUNT_SEED);
      if (!accountSeed) {
        const generated = await generateAccount(account.name, operatorKp);
        accountSeed = generated.seed;
        generatedSeeds = true;
      }

      const accountMaterial = await reissueAccountJwt(account.name, accountSeed, operatorKp);
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
      }
    }

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

    log.info({ accountCount: accounts.length }, "NATS config rendered to Vault KV");
    return { generatedSeeds, operatorPublic: operatorMaterial.publicKey, systemAccountPublic };
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
