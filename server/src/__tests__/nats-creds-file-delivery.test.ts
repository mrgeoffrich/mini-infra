import { describe, it, expect, vi } from 'vitest';
import type { StackContainerConfig } from '@mini-infra/types';
import type { DockerExecutorService } from '../services/docker-executor';

// Control the minted creds blob so we can assert it lands in the file, never
// the env. The account-public/signer paths are stubbed out — this suite only
// exercises the `nats-creds` file-delivery contract (Phase 5, §4.3).
const FAKE_CREDS_BLOB =
  '-----BEGIN NATS USER JWT-----\naaaaa.bbbbb.ccccc\n------END NATS USER JWT------\n' +
  '-----BEGIN USER NKEY SEED-----\nSUAFAKESEED\n------END USER NKEY SEED------\n';

vi.mock('../services/vault/vault-kv-service', () => ({
  getVaultKVService: () => ({ read: vi.fn() }),
}));
vi.mock('../services/nats/nats-control-plane-service', () => ({
  getNatsControlPlaneService: () => ({
    getInternalUrl: vi.fn().mockResolvedValue('nats://mini-infra-nats-nats:4222'),
    getHostUrl: vi.fn().mockResolvedValue('nats://127.0.0.1:4222'),
    mintCredentials: vi.fn().mockResolvedValue(FAKE_CREDS_BLOB),
  }),
}));

import { NatsCredentialInjector } from '../services/nats/nats-credential-injector';
import { writeNatsCredsFiles } from '../services/nats/nats-creds-volume';

function prismaWithProfile() {
  return {
    natsCredentialProfile: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'cred-1', account: { id: 'acc-1' } }),
    },
  } as unknown as ConstructorParameters<typeof NatsCredentialInjector>[0];
}

const natsCredsFileConfig: StackContainerConfig = {
  dynamicEnv: {
    NATS_URL: { kind: 'nats-url' },
    NATS_CREDS_FILE: { kind: 'nats-creds-file' },
  },
};

// The legacy env-blob variant used by generic NATS consumers must be untouched.
const natsCredsEnvConfig: StackContainerConfig = {
  dynamicEnv: {
    NATS_CREDS: { kind: 'nats-creds' },
  },
};

describe('NatsCredentialInjector — nats-creds-file (Phase 5 file delivery)', () => {
  it('emits the file path in env and hands the secret back as a creds file (never in env)', async () => {
    const injector = new NatsCredentialInjector(prismaWithProfile());

    const out = await injector.resolve('cred-1', natsCredsFileConfig, { stackId: 'stack-xyz' });

    expect(out).not.toBeNull();
    // The env carries only the path — the secret is NOT in any env value.
    expect(out!.values.NATS_CREDS_FILE).toBe('/etc/nats-creds/stack-xyz.creds');
    expect(out!.values.NATS_CREDS_FILE).not.toContain('NKEY SEED');
    expect(Object.values(out!.values)).not.toContain(FAKE_CREDS_BLOB);
    // No legacy secret env var.
    expect(out!.values.NATS_CREDS).toBeUndefined();

    // The secret is delivered as a per-stack file for the create path to write.
    expect(out!.credsFiles).toEqual([
      { fileName: 'stack-xyz.creds', contents: FAKE_CREDS_BLOB },
    ]);
  });

  it('throws when nats-creds-file is declared but no stackId is provided (needed to name the file)', async () => {
    const injector = new NatsCredentialInjector(prismaWithProfile());
    await expect(injector.resolve('cred-1', natsCredsFileConfig, {})).rejects.toThrow(
      /no stackId was provided/,
    );
  });

  it('throws when nats-creds-file is declared but no credential profile is bound', async () => {
    const injector = new NatsCredentialInjector(prismaWithProfile());
    await expect(injector.resolve(null, natsCredsFileConfig, { stackId: 'stack-xyz' })).rejects.toThrow(
      /no NATS credential profile is bound/,
    );
  });
});

describe('NatsCredentialInjector — nats-creds (legacy env-blob, unchanged)', () => {
  it('delivers the secret in the env var and writes no creds file', async () => {
    const injector = new NatsCredentialInjector(prismaWithProfile());

    // No stackId required for the legacy env-blob variant.
    const out = await injector.resolve('cred-1', natsCredsEnvConfig, {});

    expect(out).not.toBeNull();
    // The blob is delivered directly in the env var (pre-Phase-5 contract).
    expect(out!.values.NATS_CREDS).toBe(FAKE_CREDS_BLOB);
    expect(out!.credsFiles).toEqual([]);
  });
});

describe('writeNatsCredsFiles — one-shot volume writer', () => {
  function fakeExecutor(exitCode = 0) {
    const executeContainer = vi.fn().mockResolvedValue({ exitCode, stdout: '', stderr: 'boom' });
    const executor = {
      volumeExists: vi.fn().mockResolvedValue(false),
      createVolume: vi.fn().mockResolvedValue(undefined),
      pullImageWithAutoAuth: vi.fn().mockResolvedValue(undefined),
      executeContainer,
    };
    return { executor: executor as unknown as DockerExecutorService, spies: executor };
  }

  it('writes the creds blob into the per-stack volume via a base64-decoding one-shot', async () => {
    const { executor, spies } = fakeExecutor(0);

    await writeNatsCredsFiles(executor, {
      projectName: 'mini-infra-egress-fw-agent',
      files: [{ fileName: 'stack-xyz.creds', contents: FAKE_CREDS_BLOB }],
    });

    const volumeName = 'mini-infra-egress-fw-agent_nats_creds';
    // Ensures the volume exists (Docker would auto-create on agent start, but
    // the writer must have it to mount + write into).
    expect(spies.volumeExists).toHaveBeenCalledWith(volumeName);
    expect(spies.createVolume).toHaveBeenCalledWith(volumeName, 'mini-infra-egress-fw-agent', expect.any(Object));
    expect(spies.pullImageWithAutoAuth).toHaveBeenCalled();

    const call = spies.executeContainer.mock.calls[0][0];
    // Volume mounted writable at /creds.
    expect(call.binds).toEqual([`${volumeName}:/creds`]);
    // Content passed base64-encoded (no shell-quoting of the multi-line blob),
    // decoded back into the file inside the container.
    const b64 = call.env.CREDS_B64_0 as string;
    expect(Buffer.from(b64, 'base64').toString('utf-8')).toBe(FAKE_CREDS_BLOB);
    expect(call.env.CREDS_NAME_0).toBe('stack-xyz.creds');
    expect(call.cmd.join(' ')).toContain('base64 -d');
    expect(call.cmd.join(' ')).toContain('/creds/$CREDS_NAME_0');
  });

  it('is a no-op when there are no files', async () => {
    const { executor, spies } = fakeExecutor(0);
    await writeNatsCredsFiles(executor, { projectName: 'p', files: [] });
    expect(spies.executeContainer).not.toHaveBeenCalled();
    expect(spies.volumeExists).not.toHaveBeenCalled();
  });

  it('throws (aborting apply) when the writer container exits non-zero', async () => {
    const { executor } = fakeExecutor(1);
    await expect(
      writeNatsCredsFiles(executor, {
        projectName: 'p',
        files: [{ fileName: 'stack-xyz.creds', contents: FAKE_CREDS_BLOB }],
      }),
    ).rejects.toThrow(/Failed to write NATS creds into volume/);
  });
});
