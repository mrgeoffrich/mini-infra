/**
 * Shared test mocks for the stack-vault test suite.
 *
 * Replaces the near-identical `makePolicySvc` / `makeAppRoleSvc` / `makeKVSvc`
 * factories that lived inline in three different test files (the reconciler
 * unit test, the reconciler integration test, and the builtin-reconcile
 * integration test).
 *
 * The factories accept the union of opts every caller used:
 *   - `existing`        — pre-seeded record returned from `getByName`
 *   - `throwOnCreate`   — `create()` rejects (apply-failure tests)
 *   - `throwOnPublish`  — `publish()` rejects (policy phase)
 *   - `throwOnApply`    — `apply()` rejects (appRole phase)
 *   - `throwOnWrite`    — `write()` rejects (kv phase)
 *
 * Created IDs are sequence-numbered (`pol-1`, `pol-2`, …) so multi-resource
 * scenarios get unique IDs without further configuration.
 */

import { vi } from "vitest";
import type {
  PolicyServiceFacade,
  AppRoleServiceFacade,
  KVServiceFacade,
} from "../../services/stacks/stack-vault-reconciler";

export interface PolicySvcOpts {
  existing?: { id: string; displayName: string } | null;
  throwOnCreate?: boolean;
  throwOnPublish?: boolean;
}

export function makePolicySvc(opts: PolicySvcOpts = {}): PolicyServiceFacade {
  const existing = opts.existing !== undefined ? opts.existing : null;
  let n = 0;
  return {
    getByName: vi.fn().mockResolvedValue(existing),
    create: opts.throwOnCreate
      ? vi.fn().mockRejectedValue(new Error("policy create failed"))
      : vi.fn().mockImplementation((input: { name: string }) => {
          n++;
          return Promise.resolve({ id: `pol-${n}`, displayName: input.name });
        }),
    update: vi.fn().mockImplementation(
      (id: string, input: { displayName?: string }) =>
        Promise.resolve({ id, displayName: input.displayName ?? "updated" }),
    ),
    publish: opts.throwOnPublish
      ? vi.fn().mockRejectedValue(new Error("policy publish failed"))
      : vi.fn().mockImplementation((id: string) =>
          Promise.resolve({ id: existing?.id ?? id }),
        ),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

export interface AppRoleSvcOpts {
  existing?: { id: string } | null;
  throwOnCreate?: boolean;
  throwOnApply?: boolean;
}

export function makeAppRoleSvc(opts: AppRoleSvcOpts = {}): AppRoleServiceFacade {
  const existing = opts.existing !== undefined ? opts.existing : null;
  let n = 0;
  return {
    getByName: vi.fn().mockResolvedValue(existing),
    create: opts.throwOnCreate
      ? vi.fn().mockRejectedValue(new Error("approle create failed"))
      : vi.fn().mockImplementation(() => {
          n++;
          return Promise.resolve({ id: `ar-${n}` });
        }),
    update: vi.fn().mockImplementation((id: string) => Promise.resolve({ id })),
    apply: opts.throwOnApply
      ? vi.fn().mockRejectedValue(new Error("approle apply failed"))
      : vi.fn().mockImplementation((id: string) =>
          Promise.resolve({ id: existing?.id ?? id }),
        ),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

export interface KVSvcOpts {
  throwOnWrite?: boolean;
}

export function makeKVSvc(opts: KVSvcOpts = {}): KVServiceFacade {
  return {
    write: opts.throwOnWrite
      ? vi.fn().mockRejectedValue(new Error("kv write failed"))
      : vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Bundle the three facade mocks into the loader-shaped `services` override
 * accepted by `runStackVaultReconciler`. Each loader is itself a `vi.fn()`
 * spy so tests can assert "lazy load only happened for non-empty phases."
 */
export function makeVaultServiceLoaders(overrides: {
  policy?: PolicyServiceFacade;
  appRole?: AppRoleServiceFacade;
  kv?: KVServiceFacade;
} = {}) {
  return {
    getPolicyService: vi.fn().mockResolvedValue(overrides.policy ?? makePolicySvc()),
    getAppRoleService: vi.fn().mockResolvedValue(overrides.appRole ?? makeAppRoleSvc()),
    getKVService: vi.fn().mockResolvedValue(overrides.kv ?? makeKVSvc()),
  };
}

// =====================
// Logger stub
// =====================

type FakeLog = ReturnType<typeof import("../../lib/logger-factory").getLogger>;

/** Plain object that satisfies the `getLogger()` return shape — pino calls become no-ops. */
export function makeFakeLog(): FakeLog {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as FakeLog;
}
