/**
 * Integration test for Phase 5 of the Claude Shell plan — Vault-stored git
 * deploy key.
 *
 * Stitches the route and the addon together against an in-memory Vault KV
 * store so the round-trip "operator PUTs a key → next apply injects
 * `GIT_SSH_KEY`" path is exercised end-to-end. The real apply pipeline is
 * heavy and not needed to verify the contract; the contract is:
 *
 *   1. PUT writes to `stacks/${stackId}/services/${serviceName}/git-deploy-key`
 *   2. The addon's `provisionClaudeShell` reads from the same path
 *   3. When present, the addon emits `GIT_SSH_KEY: <value>` in `envForTarget`
 *   4. After DELETE, the addon no longer emits `GIT_SSH_KEY`
 *   5. No code path returns or logs the private key material
 *
 * The Vault store, Tailscale fetch, and Tailscale service are all stubbed —
 * the rest of the addon framework runs for real.
 */

import supertest from 'supertest';
import express from 'express';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TAILSCALE_DEFAULT_TAG,
  type StackServiceDefinition,
} from '@mini-infra/types';

// ── Shared in-memory Vault KV store ───────────────────────────────────────

interface VaultStore {
  data: Map<string, Record<string, unknown>>;
}

const vaultStore: VaultStore = { data: new Map() };
const mockKvService = {
  read: vi.fn(async (path: string) => vaultStore.data.get(path) ?? null),
  write: vi.fn(async (path: string, data: Record<string, unknown>) => {
    vaultStore.data.set(path, { ...data });
  }),
  delete: vi.fn(async (path: string) => {
    vaultStore.data.delete(path);
  }),
};

vi.mock('../services/vault/vault-kv-service', async () => {
  const paths = await vi.importActual<typeof import('../services/vault/vault-kv-paths')>(
    '../services/vault/vault-kv-paths',
  );
  return {
    KV_MOUNT: paths.KV_MOUNT,
    VaultKVError: paths.VaultKVError,
    validateKvPath: paths.validateKvPath,
    validateKvFieldName: paths.validateKvFieldName,
    getVaultKVService: () => mockKvService,
  };
});

// Prisma stub for the route's existence guard.
const mockStackServiceFindFirst = vi.fn();
vi.mock('../lib/prisma', () => ({
  default: {
    stackService: {
      findFirst: (...args: unknown[]) => mockStackServiceFindFirst(...args),
    },
  },
}));

vi.mock('../middleware/auth', () => ({
  requirePermission:
    () => (req: { user?: unknown; apiKey?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'test-user' };
      req.apiKey = { id: 'test-key', permissions: ['stacks:write'] };
      next();
    },
  getAuthenticatedUser: (req: { user?: unknown }) => req.user ?? null,
}));

vi.mock('../lib/logger-factory', () => {
  const mk = () => {
    const l: Record<string, unknown> = {};
    for (const fn of ['info', 'error', 'warn', 'debug', 'fatal', 'trace', 'silent']) {
      l[fn] = vi.fn();
    }
    l.child = vi.fn(() => l);
    return l;
  };
  return {
    getLogger: vi.fn(() => mk()),
    createLogger: vi.fn(() => mk()),
    appLogger: vi.fn(() => mk()),
    httpLogger: vi.fn(() => mk()),
    servicesLogger: vi.fn(() => mk()),
    buildPinoHttpOptions: vi.fn(() => ({ level: 'silent' })),
  };
});

// Stub the Tailscale module the addon imports for authkey minting. The real
// minter goes through the global `fetch` — we stub fetch instead so we
// exercise the actual minter path.
import router from '../routes/stacks/stacks-git-deploy-key-route';
import { createAddonRegistry } from '../services/stack-addons/registry';
import { expandAddons } from '../services/stack-addons/expand-addons';
import { claudeShellAddon } from '../services/stack-addons/claude-shell';

const FAKE_PEM = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'AAAA-test-integration-payload-not-a-real-key-AAAA',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/stacks', router);
  return app;
}

function makeStubTailscaleService(): unknown {
  return {
    getAccessToken: async () => 'stub-access-token',
    getAllManagedTags: async () => [TAILSCALE_DEFAULT_TAG],
    purgeStaleManagedDevicesByHostname: async () => ({ deleted: 0, errors: 0 }),
  };
}

function withStubbedFetch<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: 'k-int',
        key: 'tskey-auth-int-stub',
        created: '2026-01-01T00:00:00Z',
        expires: '2026-01-01T01:00:00Z',
        capabilities: {
          devices: {
            create: {
              reusable: false,
              ephemeral: true,
              preauthorized: true,
              tags: [TAILSCALE_DEFAULT_TAG],
            },
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function makeShellService(): StackServiceDefinition {
  return {
    serviceName: 'shell',
    serviceType: 'Stateful',
    dockerImage: 'ghcr.io/mrgeoffrich/mini-infra-claude-shell',
    dockerTag: 'dev',
    dependsOn: [],
    order: 1,
    containerConfig: { env: {}, restartPolicy: 'unless-stopped' },
    addons: {
      'claude-shell': { gitRepo: 'git@github.com:example/private.git' },
    },
  };
}

const baseExpansionContext = {
  stack: { id: 'stack-int-1', name: 'shopcorp' },
  environment: {
    id: 'env-int-1',
    name: 'staging',
    networkType: 'local' as const,
  },
};

async function applyOnce(): Promise<StackServiceDefinition[]> {
  const registry = createAddonRegistry();
  registry.register(claudeShellAddon);
  return withStubbedFetch(() =>
    expandAddons([makeShellService()], {
      ...baseExpansionContext,
      registry,
      connectedServices: { tailscale: makeStubTailscaleService() },
    }),
  );
}

beforeEach(() => {
  vaultStore.data.clear();
  mockKvService.read.mockClear();
  mockKvService.write.mockClear();
  mockKvService.delete.mockClear();
  mockStackServiceFindFirst.mockReset();
  mockStackServiceFindFirst.mockResolvedValue({ id: 'svc-int-1' });
});

describe('claude-shell git-deploy-key — route + addon round trip', () => {
  it('on first apply with no key uploaded, GIT_SSH_KEY is absent', async () => {
    const rendered = await applyOnce();
    expect(rendered[0].containerConfig.env).not.toHaveProperty('GIT_SSH_KEY');
  });

  it('after PUT, the next apply injects GIT_SSH_KEY from the Vault path', async () => {
    const app = buildApp();

    // GET shows hasKey: false before the upload.
    const before = await supertest(app)
      .get('/api/stacks/stack-int-1/services/shell/git-deploy-key')
      .expect(200);
    expect(before.body.data.hasKey).toBe(false);

    // Upload the key.
    await supertest(app)
      .put('/api/stacks/stack-int-1/services/shell/git-deploy-key')
      .send({ privateKey: FAKE_PEM })
      .expect(200);

    // GET now reports hasKey: true — but NEVER the value itself.
    const after = await supertest(app)
      .get('/api/stacks/stack-int-1/services/shell/git-deploy-key')
      .expect(200);
    expect(after.body.data.hasKey).toBe(true);
    expect(JSON.stringify(after.body)).not.toContain(FAKE_PEM);

    // Next apply: addon reads the path and emits GIT_SSH_KEY.
    const rendered = await applyOnce();
    expect(rendered[0].containerConfig.env?.GIT_SSH_KEY).toBe(FAKE_PEM);
  });

  it('after DELETE, subsequent applies stop injecting GIT_SSH_KEY', async () => {
    const app = buildApp();

    // Seed the store with a key, confirm it's injected.
    await supertest(app)
      .put('/api/stacks/stack-int-1/services/shell/git-deploy-key')
      .send({ privateKey: FAKE_PEM })
      .expect(200);
    expect((await applyOnce())[0].containerConfig.env?.GIT_SSH_KEY).toBe(FAKE_PEM);

    // Delete the key.
    await supertest(app)
      .delete('/api/stacks/stack-int-1/services/shell/git-deploy-key')
      .expect(200);

    // GET reflects the deletion.
    const after = await supertest(app)
      .get('/api/stacks/stack-int-1/services/shell/git-deploy-key')
      .expect(200);
    expect(after.body.data.hasKey).toBe(false);

    // Apply again — GIT_SSH_KEY is absent.
    const rendered = await applyOnce();
    expect(rendered[0].containerConfig.env).not.toHaveProperty('GIT_SSH_KEY');
  });

  it('uses the convention path `stacks/<id>/services/<name>/git-deploy-key`', async () => {
    const app = buildApp();
    await supertest(app)
      .put('/api/stacks/stack-int-1/services/shell/git-deploy-key')
      .send({ privateKey: FAKE_PEM })
      .expect(200);

    // The in-memory store records exactly the convention path — pinned so a
    // future refactor of either side can't drift unilaterally.
    expect(Array.from(vaultStore.data.keys())).toEqual([
      'stacks/stack-int-1/services/shell/git-deploy-key',
    ]);
  });
});
