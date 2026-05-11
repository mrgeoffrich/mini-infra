import type { EnvInjectionAddonDefinition } from '@mini-infra/types';
import { productionAddonRegistry, type RegisteredAddon } from '../registry';
import { claudeShellConfigSchema, claudeShellManifest } from './manifest';
import { provisionClaudeShell } from './provision';

/**
 * `claude-shell` env-injection addon — Phase 3 of the Claude Shell plan.
 *
 * Mints a Tailscale authkey + hostname for the workload container's
 * in-process tailscaled and merges them onto the target service's
 * `containerConfig` (no synthetic sidecar). Self-registers into
 * `productionAddonRegistry` on import.
 */
export const claudeShellDefinition: EnvInjectionAddonDefinition = {
  manifest: claudeShellManifest,
  provision: provisionClaudeShell,
};

export const claudeShellAddon: RegisteredAddon = {
  manifest: claudeShellManifest,
  configSchema: claudeShellConfigSchema,
  definition: claudeShellDefinition,
};

// Self-register on import. `productionAddonRegistry` is the singleton the
// render pipeline reads from when an `addons:` block is present on a stack
// service. The barrel `../index.ts` imports this module once on server
// boot, which is sufficient to make the addon live.
productionAddonRegistry.register(claudeShellAddon);
