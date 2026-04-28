/**
 * In-memory state store: stack policies (with built tries), container IP map, stats, version.
 *
 * All mutations are atomic — new state is built fully before swapping the reference.
 */

import type {
  ContainerMapEntry,
  StackPolicy,
  StatsResponse,
} from "./types";
import { buildTrie, RuleTrie } from "./rules";

// ---------------------------------------------------------------------------
// Compiled policy (policy + pre-built trie)
// ---------------------------------------------------------------------------

export interface CompiledPolicy {
  policy: StackPolicy;
  trie: RuleTrie;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface State {
  /** Current rules version (as provided by server on last push) */
  rulesVersion: number;
  /** Compiled policies keyed by stackId */
  stackPolicies: Map<string, CompiledPolicy>;
  /** Optional upstream DNS override from last rules push */
  defaultUpstreamOverride: string[] | null;

  /** Current container map version */
  containerMapVersion: number;
  /** IP -> { stackId, serviceName } */
  containerMap: Map<string, { stackId: string; serviceName: string; containerId?: string }>;

  /** Stats */
  stats: StatsResponse;

  /** Upstream tracking */
  upstreamLastSuccessAt: Date | null;
  upstreamLastFailureAt: Date | null;
}

// ---------------------------------------------------------------------------
// Singleton state instance
// ---------------------------------------------------------------------------

const startedAt = new Date();

let _state: State = {
  rulesVersion: 0,
  stackPolicies: new Map(),
  defaultUpstreamOverride: null,

  containerMapVersion: 0,
  containerMap: new Map(),

  stats: {
    queriesTotal: 0,
    queriesByAction: { allowed: 0, blocked: 0, observed: 0 },
    queriesByQType: {},
    uniqueSourcesSeen: 0,
    upstreamErrors: 0,
    startedAt: startedAt.toISOString(),
  },

  upstreamLastSuccessAt: null,
  upstreamLastFailureAt: null,
};

// Track unique source IPs seen.
const _seenSources: Set<string> = new Set();

export function getState(): State {
  return _state;
}

// ---------------------------------------------------------------------------
// Rules mutations
// ---------------------------------------------------------------------------

export interface ApplyRulesOptions {
  version: number;
  stackPolicies: Record<string, StackPolicy>;
  defaultUpstream?: string[];
}

export function applyRules(opts: ApplyRulesOptions): void {
  // Build new compiled policies atomically before swapping.
  const compiled = new Map<string, CompiledPolicy>();
  for (const [stackId, policy] of Object.entries(opts.stackPolicies)) {
    compiled.set(stackId, { policy, trie: buildTrie(policy) });
  }

  _state = {
    ..._state,
    rulesVersion: opts.version,
    stackPolicies: compiled,
    defaultUpstreamOverride: opts.defaultUpstream ?? null,
  };
}

// ---------------------------------------------------------------------------
// Container map mutations
// ---------------------------------------------------------------------------

export interface ApplyContainerMapOptions {
  version: number;
  entries: ContainerMapEntry[];
}

export function applyContainerMap(opts: ApplyContainerMapOptions): void {
  const newMap = new Map<
    string,
    { stackId: string; serviceName: string; containerId?: string }
  >();
  for (const entry of opts.entries) {
    newMap.set(entry.ip, {
      stackId: entry.stackId,
      serviceName: entry.serviceName,
      containerId: entry.containerId,
    });
  }

  _state = {
    ..._state,
    containerMapVersion: opts.version,
    containerMap: newMap,
  };
}

// ---------------------------------------------------------------------------
// Stats mutations
// ---------------------------------------------------------------------------

export function recordQuery(
  action: "allowed" | "blocked" | "observed",
  qtype: string,
  srcIp: string,
  upstreamError: boolean,
): void {
  const isNew = !_seenSources.has(srcIp);
  if (isNew) _seenSources.add(srcIp);

  const stats = _state.stats;
  _state = {
    ..._state,
    stats: {
      ...stats,
      queriesTotal: stats.queriesTotal + 1,
      queriesByAction: {
        ...stats.queriesByAction,
        [action]: stats.queriesByAction[action] + 1,
      },
      queriesByQType: {
        ...stats.queriesByQType,
        [qtype]: (stats.queriesByQType[qtype] ?? 0) + 1,
      },
      uniqueSourcesSeen: _seenSources.size,
      upstreamErrors: upstreamError
        ? stats.upstreamErrors + 1
        : stats.upstreamErrors,
    },
  };
}

export function recordUpstreamSuccess(): void {
  _state = { ..._state, upstreamLastSuccessAt: new Date() };
}

export function recordUpstreamFailure(): void {
  _state = { ..._state, upstreamLastFailureAt: new Date() };
}
