import { describe, it, expect, beforeEach, vi } from "vitest";
import { VaultKVError } from "../../vault/vault-kv-paths";

// Mock the vault KV service module before the bootstrap service imports it.
// The real `vault-kv-service` transitively pulls in Prisma; the bootstrap
// service only needs `getVaultKVService()`, so a flat mock is enough.
const kvStore = new Map<string, Record<string, string>>();
const writeMock = vi.fn(async (path: string, data: Record<string, unknown>) => {
  kvStore.set(path, { ...(kvStore.get(path) ?? {}), ...(data as Record<string, string>) });
});
const readFieldMock = vi.fn(async (path: string, field: string) => {
  const data = kvStore.get(path);
  if (!data || !(field in data)) {
    throw new VaultKVError(`KV ${path}/${field} missing`, "field_not_found", 404);
  }
  return data[field];
});

vi.mock("../../vault/vault-kv-service", () => ({
  getVaultKVService: () => ({
    write: writeMock,
    readField: readFieldMock,
    read: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }),
}));

import {
  NatsBootstrapService,
  NATS_OPERATOR_KV_PATH,
  NATS_ACCOUNT_KV_PATH,
  NATS_CONFIG_KV_PATH,
} from "../nats-bootstrap-service";

describe("NatsBootstrapService", () => {
  beforeEach(() => {
    kvStore.clear();
    writeMock.mockClear();
    readFieldMock.mockClear();
  });

  it("generates fresh operator and account seeds on first run", async () => {
    const svc = new NatsBootstrapService();
    const result = await svc.bootstrap();

    expect(result.generatedSeeds).toBe(true);
    expect(result.operatorPublic).toMatch(/^O/);
    expect(result.accountPublic).toMatch(/^A/);
    expect(kvStore.get(NATS_OPERATOR_KV_PATH)?.operator_seed).toMatch(/^SO/);
    expect(kvStore.get(NATS_ACCOUNT_KV_PATH)?.account_seed).toMatch(/^SA/);
    expect(kvStore.get(NATS_CONFIG_KV_PATH)?.conf).toContain("operator:");
    expect(kvStore.get(NATS_CONFIG_KV_PATH)?.conf).toContain("resolver: MEMORY");
  });

  it("reuses existing seeds on a subsequent bootstrap call", async () => {
    const svc = new NatsBootstrapService();
    const first = await svc.bootstrap();
    const seedAfterFirst = kvStore.get(NATS_OPERATOR_KV_PATH)?.operator_seed;
    const acctSeedAfterFirst = kvStore.get(NATS_ACCOUNT_KV_PATH)?.account_seed;

    const second = await svc.bootstrap();

    expect(second.generatedSeeds).toBe(false);
    expect(second.operatorPublic).toBe(first.operatorPublic);
    expect(second.accountPublic).toBe(first.accountPublic);
    expect(kvStore.get(NATS_OPERATOR_KV_PATH)?.operator_seed).toBe(seedAfterFirst);
    expect(kvStore.get(NATS_ACCOUNT_KV_PATH)?.account_seed).toBe(acctSeedAfterFirst);
  });

  it("re-renders the config so a renderer change is picked up without rotating seeds", async () => {
    const svc = new NatsBootstrapService();
    await svc.bootstrap();
    const firstConf = kvStore.get(NATS_CONFIG_KV_PATH)?.conf;

    // Simulate an out-of-date conf in Vault.
    kvStore.set(NATS_CONFIG_KV_PATH, { conf: "stale" });
    await svc.bootstrap();

    const refreshedConf = kvStore.get(NATS_CONFIG_KV_PATH)?.conf;
    expect(refreshedConf).not.toBe("stale");
    expect(refreshedConf).toBe(firstConf);
  });

  it("mintCreds returns a creds string scoped by permissions", async () => {
    const svc = new NatsBootstrapService();
    await svc.bootstrap();

    const creds = await svc.mintCreds(
      "test-user",
      { pub: ["test.>"], sub: ["replies.>"] },
      60,
    );

    expect(creds).toContain("BEGIN NATS USER JWT");
    expect(creds).toContain("BEGIN USER NKEY SEED");
  });
});
