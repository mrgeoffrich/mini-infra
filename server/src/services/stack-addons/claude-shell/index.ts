import {
  TAILSCALE_CONTROL_PLANE_HOSTNAMES,
  type EnvInjectionAddonDefinition,
  type EnvInjectionPlanStubValues,
} from '@mini-infra/types';
import { productionAddonRegistry, type RegisteredAddon } from '../registry';
import { claudeShellConfigSchema, claudeShellManifest } from './manifest';
import { provisionClaudeShell } from './provision';

/**
 * Plan-time stub: the static, side-effect-free subset of what `provision()`
 * would emit on apply. Returns the Tailscale control-plane egress, the caps
 * + devices tailscaled needs, and the addon-id label — i.e. everything that
 * does NOT depend on minting an authkey or reading Vault. Used by:
 *   - `expand-addons.ts` dryRun branch so plan diffs reflect the merged
 *     egress / caps / devices.
 *   - `egress-policy-lifecycle.ts` pass (b) so the env's egress firewall
 *     auto-allows the control-plane hostnames without an apply round-trip.
 *
 * MUST be synchronous and free of side effects. Anything dynamic (authkey,
 * hostname depending on tailscale-service lookups, GIT_SSH_KEY read from
 * Vault) lives in `provision()` and is unavailable here.
 */
function planStubClaudeShell(): EnvInjectionPlanStubValues {
  return {
    requiredEgress: [...TAILSCALE_CONTROL_PLANE_HOSTNAMES],
    capAddForTarget: ['NET_ADMIN', 'SYS_MODULE'],
    devicesForTarget: ['/dev/net/tun'],
    // `mini-infra.addon: 'claude-shell'` is applied unconditionally by the
    // framework (see `expand-addons.ts#applyEnvInjectionGroup`); leaving
    // labelsForTarget undefined here keeps that the single source of truth.
  };
}

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
  planStub: planStubClaudeShell,
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
