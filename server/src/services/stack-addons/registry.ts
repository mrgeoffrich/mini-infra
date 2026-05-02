import { z } from 'zod';
import type {
  AddonDefinition,
  AddonManifest,
  AddonMergeStrategy,
} from '@mini-infra/types';

/**
 * Manifest paired with the zod schema used to validate user-supplied addon
 * config. The runtime keeps zod off the shared `AddonManifest` interface so
 * `lib/` stays runtime-dep-free; this server-side wrapper holds the schema.
 */
export interface RegisteredAddon {
  manifest: AddonManifest;
  configSchema: z.ZodTypeAny;
  definition: AddonDefinition;
}

/**
 * Live registry of active addons + merge strategies. A stack template's
 * `addons:` block is validated and rendered against this registry.
 *
 * The production registry is empty at Phase 1 — the render pass is a no-op
 * for every existing stack. Per-addon directories register themselves into
 * the production singleton starting Phase 3 (`tailscale-ssh`).
 *
 * Tests construct their own registries via `createAddonRegistry()` so they
 * don't pollute the production singleton.
 */
export class AddonRegistry {
  private addons = new Map<string, RegisteredAddon>();
  private mergeStrategies = new Map<string, AddonMergeStrategy>();

  register(addon: RegisteredAddon): void {
    if (this.addons.has(addon.manifest.id)) {
      throw new Error(`Addon "${addon.manifest.id}" is already registered`);
    }
    this.addons.set(addon.manifest.id, addon);
  }

  registerMergeStrategy(strategy: AddonMergeStrategy): void {
    if (this.mergeStrategies.has(strategy.kind)) {
      throw new Error(
        `Merge strategy for kind "${strategy.kind}" is already registered`,
      );
    }
    this.mergeStrategies.set(strategy.kind, strategy);
  }

  get(addonId: string): RegisteredAddon | undefined {
    return this.addons.get(addonId);
  }

  getMergeStrategy(kind: string): AddonMergeStrategy | undefined {
    return this.mergeStrategies.get(kind);
  }

  has(addonId: string): boolean {
    return this.addons.has(addonId);
  }

  list(): RegisteredAddon[] {
    return [...this.addons.values()];
  }
}

export function createAddonRegistry(): AddonRegistry {
  return new AddonRegistry();
}

/**
 * Production singleton populated by addon directories in this folder. Empty
 * at Phase 1 — the render pass is a no-op for every existing stack.
 *
 * Per-addon registration entry points are added here starting Phase 3
 * (`tailscale-ssh`). Tests should construct an isolated registry via
 * `createAddonRegistry()` rather than mutating this one.
 */
export const productionAddonRegistry: AddonRegistry = createAddonRegistry();
