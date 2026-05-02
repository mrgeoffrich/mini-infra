import { z } from 'zod';
import type {
  AddonDefinition,
  ProvisionContext,
  ProvisionedValues,
  StackServiceDefinition,
} from '@mini-infra/types';
import type { RegisteredAddon } from '../registry';

/**
 * Test-only addon that exercises the validate → provision → materialise →
 * target-integration path without touching Vault, Tailscale, or any other
 * external service. Used by `expand-addons.test.ts` to prove the framework
 * without registering a production addon.
 *
 * **Not registered into the production singleton.** Tests instantiate their
 * own registry via `createAddonRegistry()` and call `register(noopAddon)`.
 *
 * Sidecar shape: a tiny alpine container that sleeps. Its `serviceName` is
 * `<target>-noop`, `peer-on-target-network` integration so the target is
 * untouched, and a single env var so we can assert on the rendered output.
 */
const noopConfigSchema = z
  .object({
    label: z.string().min(1).max(64).optional(),
  })
  .strict();

type NoopConfig = z.infer<typeof noopConfigSchema>;

const noopDefinition: AddonDefinition = {
  manifest: {
    id: 'noop',
    description:
      'No-op test addon. Adds an empty alpine sidecar; takes no external dependencies.',
    appliesTo: ['Stateful', 'StatelessWeb', 'Pool'],
  },
  targetIntegration: {
    network: 'peer-on-target-network',
  },
  async provision(ctx: ProvisionContext): Promise<ProvisionedValues> {
    const config = ctx.addonConfig as NoopConfig;
    return {
      envForSidecar: {
        NOOP_TARGET: ctx.service.name,
        ...(config.label ? { NOOP_LABEL: config.label } : {}),
      },
      templateVars: {
        targetServiceName: ctx.service.name,
      },
    };
  },
  buildServiceDefinition(
    ctx: ProvisionContext,
    provisioned: ProvisionedValues,
  ): StackServiceDefinition {
    return {
      serviceName: `${ctx.service.name}-noop`,
      serviceType: 'Stateful',
      dockerImage: 'alpine',
      dockerTag: '3.20',
      containerConfig: {
        command: ['sleep', 'infinity'],
        env: provisioned.envForSidecar,
        labels: {
          'mini-infra.addon': 'noop',
        },
        restartPolicy: 'unless-stopped',
      },
      dependsOn: [ctx.service.name],
      order: 1000,
    };
  },
};

export const noopAddon: RegisteredAddon = {
  manifest: noopDefinition.manifest,
  configSchema: noopConfigSchema,
  definition: noopDefinition,
};
