import { createHash } from 'crypto';
import {
  StackServiceDefinition,
  StackConfigFile,
  StackContainerConfig,
  SyntheticServiceInfo,
  JobPoolConfig,
  JobPoolTrigger,
} from '@mini-infra/types';

/**
 * Strip apply-time dynamic-env metadata from containerConfig before hashing.
 *
 * Dynamic env values (e.g. vault-wrapped-secret-id) are resolved at apply time
 * and intentionally not part of stack identity — including them in the hash
 * would cause drift false-positives and force spurious recreates.
 */
function stripDynamic(cc: StackContainerConfig | undefined): StackContainerConfig | undefined {
  if (!cc || !cc.dynamicEnv) return cc;
  const { dynamicEnv: _omit, ...rest } = cc;
  void _omit;
  return rest;
}

/**
 * Canonicalise a JobPoolConfig for hashing. Sorts `triggers[]` by
 * `(kind, name)` so the hash is stable across re-orderings the operator
 * might do in the template. Only the drift-relevant fields are included —
 * `managedBy` is reserved-for-future and not hashed; `maxConcurrent` is
 * not hashed either (changing the cap doesn't require a service recreate,
 * just a registry refresh at apply time).
 */
function canonicaliseJobPoolConfig(cfg: JobPoolConfig | null | undefined): unknown {
  if (!cfg) return null;
  const sortedTriggers = [...(cfg.triggers ?? [])]
    .map(canonicaliseTrigger)
    .sort((a, b) => {
      const ka = `${a.kind}:${a.name}`;
      const kb = `${b.kind}:${b.name}`;
      return ka.localeCompare(kb);
    });
  return {
    triggers: sortedTriggers,
    history: cfg.history ?? null,
    killAfterSeconds: cfg.killAfterSeconds ?? null,
    onFailure: cfg.onFailure ?? null,
  };
}

/** Normalise a trigger to a plain object that only contains the kind-specific fields. */
function canonicaliseTrigger(t: JobPoolTrigger): { kind: string; name: string } & Record<string, unknown> {
  switch (t.kind) {
    case 'cron':
      return { kind: 'cron', name: t.name, schedule: t.schedule, timezone: t.timezone ?? null };
    case 'nats-request':
      return { kind: 'nats-request', name: t.name, subject: t.subject, ackWithRunId: t.ackWithRunId };
    case 'manual':
      return { kind: 'manual', name: t.name };
  }
}

function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => stableStringify(item)).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const sorted = Object.keys(obj as Record<string, unknown>)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + stableStringify((obj as Record<string, unknown>)[key]));
    return '{' + sorted.join(',') + '}';
  }
  return JSON.stringify(obj);
}

export function computeDefinitionHash(
  service: StackServiceDefinition,
  resolvedConfigFiles?: StackConfigFile[]
): string {
  let canonical: unknown;

  if (service.serviceType === 'AdoptedWeb') {
    // AdoptedWeb services don't manage the container itself — but we do attach
    // it to networks at apply time, so hash the adoption ref, routing, and the
    // network-join fields. Including joinNetworks/joinResourceNetworks means
    // adding or removing a linked-container connection triggers a recreate that
    // re-runs the attach. Both sides of the drift comparison are re-hashed live
    // (see stack-plan-computer), so widening this canonical is safe for
    // existing adopted services whose join fields are simply absent.
    canonical = {
      serviceType: 'AdoptedWeb',
      adoptedContainer: service.adoptedContainer ?? null,
      routing: service.routing ?? null,
      joinNetworks: service.containerConfig?.joinNetworks ?? null,
      joinResourceNetworks: service.containerConfig?.joinResourceNetworks ?? null,
    };
  } else {
    const configFiles = resolvedConfigFiles ?? service.configFiles ?? [];
    const sortedConfigFiles = [...configFiles].sort((a, b) =>
      `${a.volumeName}:${a.path}`.localeCompare(`${b.volumeName}:${b.path}`)
    );
    const sortedInitCommands = [...(service.initCommands ?? [])].sort((a, b) =>
      `${a.volumeName}:${a.mountPath}`.localeCompare(`${b.volumeName}:${b.mountPath}`)
    );

    canonical = {
      dockerImage: service.dockerImage,
      dockerTag: service.dockerTag,
      containerConfig: stripDynamic(service.containerConfig),
      configFiles: sortedConfigFiles,
      initCommands: sortedInitCommands,
      routing: service.routing ?? null,
      // Service Addons §7: hash the *authored* `addons:` block, not the
      // rendered sidecars. Rendered (synthetic) services are hashed
      // independently by the reconciler; including the authored block here
      // means changing addon-config triggers a recreate of the target while
      // mint-on-render values (authkeys, secrets) never enter this hash.
      addons: service.addons ?? null,
      // JobPool drift inputs (Phase 3): the fields that affect *what* the
      // pool does — triggers, history retention, kill-after-seconds,
      // retry policy. The running-or-not state of `PoolInstance` rows is
      // deliberately NOT hashed (it oscillates per-run; that's not drift).
      // Per-instance/per-run credential injection happens at spawn time
      // and is already excluded via `stripDynamic`.
      jobPoolConfig: service.serviceType === 'JobPool'
        ? canonicaliseJobPoolConfig(service.jobPoolConfig)
        : null,
    };
  }

  const hash = createHash('sha256')
    .update(stableStringify(canonical))
    .digest('hex');

  return `sha256:${hash}`;
}

/**
 * Stable hash for an addon-derived synthetic sidecar.
 *
 * Synthetic services live outside the authored DB rows — their rendered shape
 * (image, env, mounts) is computed at apply time by the addon's `provision()`
 * and `buildServiceDefinition()`. Some of that shape is deterministic
 * (image, capAdd, state-volume mount) and some is per-mint (TS_AUTHKEY,
 * hostnames derived from runtime state). Hashing the rendered definition
 * directly would change the hash on every apply, marking the sidecar as
 * permanently drifted.
 *
 * Instead we hash the *authoring intent* — the synthetic's identity (addon
 * ids, kind, target service) plus the target's authored addon-config block.
 * Two applies with the same authored input yield the same hash regardless
 * of when provisioning ran or what authkey was minted.
 */
export function computeSyntheticDefinitionHash(
  synthetic: SyntheticServiceInfo,
  targetAuthoredAddons: Record<string, unknown> | undefined,
): string {
  const sortedAddonIds = [...synthetic.addonIds].sort();
  const relevantConfigs: Record<string, unknown> = {};
  for (const id of sortedAddonIds) {
    relevantConfigs[id] = targetAuthoredAddons?.[id] ?? null;
  }
  const canonical = {
    syntheticAddonIds: sortedAddonIds,
    syntheticKind: synthetic.kind ?? null,
    syntheticTarget: synthetic.targetService,
    addonConfigs: relevantConfigs,
  };
  const hash = createHash('sha256')
    .update(stableStringify(canonical))
    .digest('hex');
  return `sha256:${hash}`;
}
