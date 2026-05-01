import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StackContainerConfig } from '@mini-infra/types';

// Stub the heavy collaborators so the unit test isolates the injector. The
// account-public path doesn't touch Vault or the control plane, but importing
// the injector pulls them in so they need module-level stubs.
vi.mock('../services/vault/vault-kv-service', () => ({
  getVaultKVService: () => ({ read: vi.fn() }),
}));
vi.mock('../services/nats/nats-control-plane-service', () => ({
  getNatsControlPlaneService: () => ({
    getInternalUrl: vi.fn(),
    mintCredentials: vi.fn(),
  }),
}));

import {
  NatsCredentialInjector,
  __clearNatsSignerCacheForTests,
} from '../services/nats/nats-credential-injector';

type SigningKeyRow = {
  publicKey: string;
  account: { publicKey: string | null };
};

function makePrismaWithSigner(row: SigningKeyRow | null) {
  return {
    natsSigningKey: {
      findUnique: vi.fn().mockResolvedValue(row),
    },
  } as unknown as ConstructorParameters<typeof NatsCredentialInjector>[0];
}

const containerConfigWithAccountPublic = (signer = 'minter'): StackContainerConfig => ({
  dynamicEnv: {
    NATS_ACCOUNT_PUB: { kind: 'nats-account-public', signer },
  },
});

describe('NatsCredentialInjector — nats-account-public', () => {
  beforeEach(() => {
    __clearNatsSignerCacheForTests();
  });

  it('resolves the account public key from the signing-key row', async () => {
    const prisma = makePrismaWithSigner({
      publicKey: 'SIGNER_PUB',
      account: { publicKey: 'AAAAAAAAAACCOUNTPUB' },
    });
    const injector = new NatsCredentialInjector(prisma);

    const out = await injector.resolve(null, containerConfigWithAccountPublic('minter'), {
      stackId: 'stack-1',
    });

    expect(out).toEqual({ NATS_ACCOUNT_PUB: 'AAAAAAAAAACCOUNTPUB' });
  });

  it('throws if no stackId is provided', async () => {
    const prisma = makePrismaWithSigner({
      publicKey: 'SIGNER_PUB',
      account: { publicKey: 'ACC_PUB' },
    });
    const injector = new NatsCredentialInjector(prisma);

    await expect(
      injector.resolve(null, containerConfigWithAccountPublic('minter'), {}),
    ).rejects.toThrow(/no stackId was provided/);
  });

  it('throws if the signing-key row does not exist', async () => {
    const prisma = makePrismaWithSigner(null);
    const injector = new NatsCredentialInjector(prisma);

    await expect(
      injector.resolve(null, containerConfigWithAccountPublic('ghost'), { stackId: 'stack-1' }),
    ).rejects.toThrow(/no NatsSigningKey row exists/);
  });

  it('throws if the bound account has no publicKey set', async () => {
    const prisma = makePrismaWithSigner({
      publicKey: 'SIGNER_PUB',
      account: { publicKey: null },
    });
    const injector = new NatsCredentialInjector(prisma);

    await expect(
      injector.resolve(null, containerConfigWithAccountPublic('minter'), { stackId: 'stack-1' }),
    ).rejects.toThrow(/no publicKey set/);
  });

  it('caches across calls — second resolve does not re-hit Prisma', async () => {
    const prisma = makePrismaWithSigner({
      publicKey: 'SIGNER_PUB',
      account: { publicKey: 'ACC_PUB' },
    });
    const injector = new NatsCredentialInjector(prisma);

    await injector.resolve(null, containerConfigWithAccountPublic('minter'), { stackId: 'stack-1' });
    await injector.resolve(null, containerConfigWithAccountPublic('minter'), { stackId: 'stack-1' });

    // findUnique called exactly once across both resolves.
    expect((prisma as unknown as { natsSigningKey: { findUnique: { mock: { calls: unknown[] } } } })
      .natsSigningKey.findUnique.mock.calls.length).toBe(1);
  });
});
