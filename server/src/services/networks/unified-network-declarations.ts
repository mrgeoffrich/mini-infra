/**
 * Unified network declaration — network overhaul Phase 10 (optional,
 * reader-side sugar).
 *
 * Templates/stacks today declare networks and attachments through four
 * separate legacy mechanisms: stack-owned `networks[]`, docker-network
 * `resourceOutputs[]`/`resourceInputs[]`, and per-service
 * `containerConfig.joinNetworks`/`joinResourceNetworks`. This module adds a
 * single alternative input shape — a `networks[]` entry can be either the
 * legacy `StackNetwork` (`{name, driver?, options?}`) or the unified
 * `UnifiedStackNetworkDeclaration` (`{purpose, scope?}`), and a service can
 * declare a plain `networks: string[]` purpose list instead of
 * `joinNetworks`/`joinResourceNetworks`.
 *
 * `translateUnifiedNetworkDeclarations()` is the ONLY code that understands
 * the unified shape. It runs once, at the authoring boundary (immediately
 * after Zod validation succeeds, before the payload is persisted or used),
 * and produces the exact same legacy shapes the rest of the pipeline
 * already reads — `membership-compiler.ts`, `StackReconciler`,
 * `attachServiceNetworks`, `definition-hash.ts`, etc. never see a unified
 * entry and need no changes. See
 * docs/planning/not-shipped/docker-network-overhaul-plan.md §6 Phase 10 and
 * docs/designs/docker-network-management-redesign.md §3.4.
 *
 * ## Translation rules
 *
 * Stack-level `networks[]` entries:
 *  - `{purpose, scope: 'stack'}` (or `scope` omitted) → appended to the
 *    legacy `networks[]` array as `{name: purpose}`. Every non-host-mode
 *    service already joins every stack-owned network
 *    (`membership-compiler.ts`'s mechanism 3a) — unchanged.
 *  - `{purpose, scope: 'environment' | 'host'}` → appended to
 *    `resourceOutputs[]` as `{type: 'docker-network', purpose}`. The
 *    network's real resulting scope is still governed by whether the
 *    *owning* stack itself is environment- or host-scoped
 *    (`StackInfraResourceManager.reconcileOutputs`, unchanged) — `scope`
 *    here is authoring documentation, not a scope override.
 *
 * Per-service `networks: string[]` entries — each name is resolved against
 * every purpose declared at the stack level (legacy `networks[].name`,
 * unified `networks[].purpose`, and legacy `resourceOutputs`/`resourceInputs`
 * purposes):
 *  - resolves to a stack-owned network → no-op (already auto-joined).
 *  - resolves to a resource-scoped network → merged into that service's
 *    `containerConfig.joinResourceNetworks`.
 *  - does not resolve to any declared purpose → rejected
 *    (`UnifiedNetworkDeclarationError`).
 * There is no unified equivalent of `joinNetworks` (joining an arbitrary
 * external Docker network by literal name, not tied to any declared
 * purpose) — that remains a legacy-only escape hatch.
 *
 * ## Mixing rule
 *
 * Legacy and unified entries may coexist in the same `networks[]` array,
 * and a unified stack-level declaration may sit alongside legacy
 * `resourceOutputs[]`/`resourceInputs[]` — this function merges them. Two
 * *legacy* `StackNetwork` entries may share the same `name` (unchanged
 * pre-existing tolerance; this function does not newly validate that). A
 * collision between a *unified* declaration and any other declaration of
 * the same name/purpose (a legacy `networks[]` entry, another unified
 * entry, or an existing `resourceOutputs[]` entry) is rejected as
 * ambiguous — pick one spelling per network.
 *
 * A service's unified `networks[]` list requires the SAME request to also
 * carry the stack-level `networks[]` array (so purposes can be resolved) —
 * see the `services[].networks requires...` error below. In practice this
 * only matters for partial stack updates (`PATCH`-style `updateStackSchema`)
 * that touch `services` without resending `networks`.
 */
import type {
  StackContainerConfig,
  StackNetwork,
  StackNetworkEntry,
  StackResourceInput,
  StackResourceOutput,
  UnifiedStackNetworkDeclaration,
} from '@mini-infra/types';

export class UnifiedNetworkDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnifiedNetworkDeclarationError';
  }
}

/** True for the unified `{purpose, scope?}` shape, false for legacy `{name, ...}`. */
export function isUnifiedStackNetworkDeclaration(
  entry: StackNetworkEntry,
): entry is UnifiedStackNetworkDeclaration {
  return !('name' in entry) && 'purpose' in entry;
}

export interface UnifiedNetworkTranslationService {
  containerConfig: StackContainerConfig;
  /** Unified per-service purpose list — see module doc. */
  networks?: string[];
  /** Only read for error messages; not required by the translation itself. */
  serviceName?: string;
}

export interface UnifiedNetworkTranslationInput<Svc extends UnifiedNetworkTranslationService> {
  networks?: StackNetworkEntry[];
  resourceOutputs?: StackResourceOutput[];
  resourceInputs?: StackResourceInput[];
  services?: Svc[];
}

export interface UnifiedNetworkTranslationResult<Svc extends UnifiedNetworkTranslationService> {
  /** `undefined` only when `input.networks` itself was `undefined` (partial update, untouched). */
  networks?: StackNetwork[];
  resourceOutputs?: StackResourceOutput[];
  resourceInputs?: StackResourceInput[];
  /** `undefined` only when `input.services` itself was `undefined`. */
  services?: Array<Omit<Svc, 'networks'>>;
}

/**
 * Translate a unified `networks[]` (+ per-service `networks[]`) declaration
 * into the legacy shapes the rest of the pipeline consumes. See module doc
 * for the full translation and mixing rules. Never mutates its input.
 *
 * Throws `UnifiedNetworkDeclarationError` on genuinely ambiguous input
 * (colliding declarations, or a per-service reference to an undeclared
 * purpose) — callers should catch this and surface a 400.
 */
export function translateUnifiedNetworkDeclarations<Svc extends UnifiedNetworkTranslationService>(
  input: UnifiedNetworkTranslationInput<Svc>,
): UnifiedNetworkTranslationResult<Svc> {
  const declaredNetworks = input.networks;

  if (!declaredNetworks) {
    const offender = input.services?.find((s) => (s.networks?.length ?? 0) > 0);
    if (offender) {
      throw new UnifiedNetworkDeclarationError(
        'services[].networks requires the request to also include a top-level "networks" array declaring each referenced purpose (with an optional "scope").',
      );
    }
    return {
      networks: undefined,
      resourceOutputs: input.resourceOutputs,
      resourceInputs: input.resourceInputs,
      services: input.services as Array<Omit<Svc, 'networks'>> | undefined,
    };
  }

  // name/purpose -> which authoring style declared it. Lets us reject an
  // ambiguous mix while tolerating legacy dupes (pre-existing behavior).
  const declaredBy = new Map<string, 'legacy' | 'unified'>();
  const legacyNetworks: StackNetwork[] = [];
  const outputsFromUnified: StackResourceOutput[] = [];
  // purpose/name -> 'stack' (already auto-joined, no-op) | 'resource' (joinResourceNetworks)
  const purposeClass = new Map<string, 'stack' | 'resource'>();

  // Pre-existing (legacy) docker-network resource purposes, used to reject an
  // ambiguous collision with a unified declaration of the same purpose — for
  // BOTH scopes, not just environment/host (a stack-scoped unified entry and a
  // resourceOutputs[] entry sharing a purpose string are two distinct networks
  // a per-service `networks[]` reference could not unambiguously resolve).
  const preExistingResourcePurposes = new Set<string>([
    ...(input.resourceOutputs ?? []).map((o) => o.purpose),
    ...(input.resourceInputs ?? []).map((i) => i.purpose),
  ]);

  for (const entry of declaredNetworks) {
    if (isUnifiedStackNetworkDeclaration(entry)) {
      const prior = declaredBy.get(entry.purpose);
      if (prior === 'legacy') {
        throw new UnifiedNetworkDeclarationError(
          `networks[]: "${entry.purpose}" is declared both as a legacy network and a unified network declaration — pick one spelling.`,
        );
      }
      if (prior === 'unified') {
        throw new UnifiedNetworkDeclarationError(
          `networks[]: duplicate unified declaration for purpose "${entry.purpose}".`,
        );
      }
      declaredBy.set(entry.purpose, 'unified');

      const scope = entry.scope ?? 'stack';
      if (scope === 'stack') {
        // A stack-scoped unified network and a resource network sharing one
        // purpose string are two distinct networks in different classes, so a
        // per-service `networks: [purpose]` reference can't unambiguously
        // resolve — and `purposeClass` would otherwise be silently overwritten
        // to 'resource' below (PR #479 review low). Reject it. (The env/host
        // scope case already becomes a resourceOutput and is caught by the
        // resourceOutputs-collision check further down.)
        if (preExistingResourcePurposes.has(entry.purpose)) {
          throw new UnifiedNetworkDeclarationError(
            `networks[]: stack-scoped unified purpose "${entry.purpose}" collides with an existing resourceOutputs[]/resourceInputs[] entry of the same purpose.`,
          );
        }
        legacyNetworks.push({ name: entry.purpose });
        purposeClass.set(entry.purpose, 'stack');
      } else {
        outputsFromUnified.push({ type: 'docker-network', purpose: entry.purpose });
        purposeClass.set(entry.purpose, 'resource');
      }
    } else {
      const prior = declaredBy.get(entry.name);
      if (prior === 'unified') {
        throw new UnifiedNetworkDeclarationError(
          `networks[]: "${entry.name}" is declared both as a legacy network and a unified network declaration — pick one spelling.`,
        );
      }
      declaredBy.set(entry.name, 'legacy');
      purposeClass.set(entry.name, 'stack');
      legacyNetworks.push(entry);
    }
  }

  // Merge unified-derived resourceOutputs with any pre-existing legacy ones,
  // rejecting a purpose collision between the two spellings.
  let resourceOutputs = input.resourceOutputs;
  if (outputsFromUnified.length > 0) {
    const existing = input.resourceOutputs ?? [];
    const existingPurposes = new Set(existing.map((o) => o.purpose));
    for (const o of outputsFromUnified) {
      if (existingPurposes.has(o.purpose)) {
        throw new UnifiedNetworkDeclarationError(
          `networks[]: purpose "${o.purpose}" collides with an existing resourceOutputs[] entry of the same purpose.`,
        );
      }
    }
    resourceOutputs = [...existing, ...outputsFromUnified];
  }

  // A service's unified `networks[]` list may reference a purpose regardless
  // of which authoring style declared it, so fold in the legacy
  // resourceOutputs/resourceInputs purposes too (pre-existing ones only —
  // unified-derived outputs are already registered above).
  for (const o of input.resourceOutputs ?? []) purposeClass.set(o.purpose, 'resource');
  for (const i of input.resourceInputs ?? []) purposeClass.set(i.purpose, 'resource');

  const services = input.services?.map((svc) => {
    const { networks: unifiedServiceNetworks, ...rest } = svc;
    if (!unifiedServiceNetworks || unifiedServiceNetworks.length === 0) {
      return rest as Omit<Svc, 'networks'>;
    }
    const extraJoinResourceNetworks: string[] = [];
    for (const purpose of unifiedServiceNetworks) {
      const cls = purposeClass.get(purpose);
      if (!cls) {
        throw new UnifiedNetworkDeclarationError(
          `services[].networks: service "${rest.serviceName ?? '?'}" references undeclared network purpose "${purpose}".`,
        );
      }
      if (cls === 'resource') extraJoinResourceNetworks.push(purpose);
      // cls === 'stack' -> no-op: every non-host-mode service already joins
      // every stack-owned network (membership-compiler mechanism 3a).
    }
    if (extraJoinResourceNetworks.length === 0) {
      return rest as Omit<Svc, 'networks'>;
    }
    const mergedJoinResourceNetworks = [
      ...new Set([...(rest.containerConfig.joinResourceNetworks ?? []), ...extraJoinResourceNetworks]),
    ];
    return {
      ...rest,
      containerConfig: { ...rest.containerConfig, joinResourceNetworks: mergedJoinResourceNetworks },
    } as Omit<Svc, 'networks'>;
  });

  return {
    networks: legacyNetworks,
    resourceOutputs,
    resourceInputs: input.resourceInputs,
    services,
  };
}
