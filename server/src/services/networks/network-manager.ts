import type Docker from 'dockerode';
import { getLogger } from '../../lib/logger-factory';
import type { DockerExecutorService } from '../docker-executor';

const logger = getLogger('docker', 'network-manager');

/**
 * Tri-state existence check result. A Docker daemon outage (or any
 * non-404 error while inspecting) is `unknown` — never coerced to
 * `absent` — so callers don't race a `create` against a network that
 * actually exists but was momentarily unreachable (defect F3 in the
 * network overhaul audit).
 */
export type NetworkExistence = 'present' | 'absent' | 'unknown';

export interface NetworkOwner {
  kind: 'stack' | 'environment' | 'host';
  /** Stack id / environment id. Omitted (and omitted from labels) for `host`. */
  id?: string;
}

export interface EnsureNetworkSpec {
  name: string;
  owner: NetworkOwner;
  /** Resource purpose (e.g. `applications`, `egress`). Stack-owned networks omit this — it defaults to `_stack`. */
  purpose?: string;
  driver?: string;
  /** Docker driver options (e.g. bridge options). Values are coerced to strings — Docker's network API only accepts string option values. */
  options?: Record<string, unknown>;
  /** Additional labels to stamp alongside the standard `mini-infra.*` ownership labels — e.g. the legacy `mini-infra.stack` / `mini-infra.stack-id` labels stack-owned networks have carried since before this module existed. */
  extraLabels?: Record<string, string>;
}

export interface NetworkSpecMismatch {
  driver?: { expected: string; actual: string };
  labels?: {
    expected: Record<string, string>;
    actual: Record<string, string>;
    missing: string[];
    changed: string[];
  };
  options?: { expected: Record<string, string>; actual: Record<string, string> };
}

export interface EnsureNetworkResult {
  name: string;
  /** True only when this call created the network. False for "already present" and for the race-on-create case (409). */
  created: boolean;
  existence: NetworkExistence;
  /** Set when the network already existed but its driver/labels/options don't match the desired spec. Never triggers a recreate in Phase 1 — logged as a structured warning only. */
  mismatch?: NetworkSpecMismatch;
}

export interface ConnectOptions {
  aliases?: string[];
  staticIp?: string;
}

export interface ConnectResult {
  connected: boolean;
  /** True when the container was already attached (no-op) rather than freshly connected by this call. */
  alreadyConnected: boolean;
}

export interface RemoveNetworkOptions {
  /** Force-disconnect any attached containers before removing, instead of refusing. */
  forceDisconnect?: boolean;
}

export interface RemoveNetworkResult {
  name: string;
  removed: boolean;
  reason?: 'not-found' | 'has-containers' | 'error';
}

export interface NetworkIpamConfig {
  subnet?: string;
  gateway?: string;
}

export interface NetworkInspectResult {
  name: string;
  id?: string;
  driver?: string;
  labels: Record<string, string>;
  ipam?: NetworkIpamConfig;
  /** Container IDs currently attached, per Docker's live inspect. */
  connectedContainerIds: string[];
}

export interface RemoveByOwnerOptions extends RemoveNetworkOptions {
  /**
   * Additional network names to check even if the owner-label query didn't
   * return them — covers networks created before this module stamped
   * ownership labels (Docker labels are immutable after creation, so this
   * fallback is permanent, not a transition shim; see plan §4/§7).
   */
  nameFallbackCandidates?: string[];
}

export interface ListManagedFilter {
  owner?: NetworkOwner;
  purpose?: string;
}

/**
 * Summary of a `mini-infra.managed=true` network as reported by Docker's
 * label-filtered list endpoint — cheap (one `listNetworks` call), unlike
 * {@link NetworkInspectResult} which requires one `inspect` per network.
 * Used by GC (`network-gc.ts`) to enumerate candidates before doing the more
 * expensive per-network inspect only for the ones that need it.
 */
export interface ManagedNetworkInfo {
  name: string;
  id?: string;
  driver?: string;
  ownerKind: NetworkOwner['kind'];
  /** Absent for `host`-scoped networks (no owner id is ever labelled for those). */
  ownerId?: string;
  purpose: string;
  labels: Record<string, string>;
}

function statusCodeOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const code = (err as { statusCode?: unknown }).statusCode;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

function ownerLabels(owner: NetworkOwner, purpose?: string): Record<string, string> {
  const labels: Record<string, string> = {
    'mini-infra.managed': 'true',
    'mini-infra.owner-kind': owner.kind,
    'mini-infra.purpose': purpose ?? '_stack',
  };
  if (owner.kind !== 'host' && owner.id) {
    labels['mini-infra.owner-id'] = owner.id;
  }
  return labels;
}

function normalizeOptions(options?: Record<string, unknown>): Record<string, string> | undefined {
  if (!options) return undefined;
  const entries = Object.entries(options).map(([key, value]) => [key, String(value)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Compare an existing network's driver/labels/options against the desired
 * spec. Only `mini-infra.*` labels are compared — an unlabelled pre-existing
 * network isn't flagged as "drifted", it's simply back-labelled next time
 * `ensure()` runs against it (label writes require a create, so in practice
 * that happens on next apply after a recreate, not in place).
 */
function detectMismatch(
  actual: Docker.NetworkInspectInfo,
  desired: { driver: string; labels: Record<string, string>; options?: Record<string, string> },
): NetworkSpecMismatch | undefined {
  const mismatch: NetworkSpecMismatch = {};

  if (actual.Driver && actual.Driver !== desired.driver) {
    mismatch.driver = { expected: desired.driver, actual: actual.Driver };
  }

  const actualLabels = actual.Labels ?? {};
  const relevantExpected = Object.fromEntries(
    Object.entries(desired.labels).filter(([key]) => key.startsWith('mini-infra.')),
  );
  const missing = Object.keys(relevantExpected).filter((key) => !(key in actualLabels));
  const changed = Object.keys(relevantExpected).filter(
    (key) => key in actualLabels && actualLabels[key] !== relevantExpected[key],
  );
  if (missing.length > 0 || changed.length > 0) {
    mismatch.labels = { expected: relevantExpected, actual: actualLabels, missing, changed };
  }

  if (desired.options && Object.keys(desired.options).length > 0) {
    const actualOptions = actual.Options ?? {};
    const optionsChanged = Object.keys(desired.options).some(
      (key) => actualOptions[key] !== desired.options?.[key],
    );
    if (optionsChanged) {
      mismatch.options = { expected: desired.options, actual: actualOptions };
    }
  }

  return Object.keys(mismatch).length > 0 ? mismatch : undefined;
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface NetworkManagerDeps {
  /**
   * Best-effort hook to invalidate any external network-list cache (e.g.
   * DockerService's) after a mutation. Always wrapped in try/catch — a
   * failure here must never fail the underlying network operation.
   */
  invalidateCache?: () => void;
}

/**
 * The single owner of Docker network operations for the stack subsystem.
 *
 * Replaces the copy-pasted create/connect/remove call sites and the
 * per-site error-message-substring idempotency checks with one
 * status-code-driven implementation. See
 * `docs/designs/docker-network-management-redesign.md` §2 for the full
 * rationale.
 *
 * Takes a `{ getDockerClient() }` source (satisfied by `DockerExecutorService`)
 * rather than storing a raw client directly, mirroring the rest of the
 * `docker-executor` sub-modules (`StackContainerManager`,
 * `InfrastructureManager`, ...) — the client is re-fetched on every call so a
 * client swap (e.g. `DockerExecutorService.refreshConnection()`) is picked up
 * rather than captured stale at construction time.
 */
export class NetworkManager {
  constructor(
    private readonly dockerSource: Pick<DockerExecutorService, 'getDockerClient'>,
    private readonly deps: NetworkManagerDeps = {},
  ) {}

  private get docker(): Docker {
    return this.dockerSource.getDockerClient();
  }

  private invalidateCache(): void {
    try {
      this.deps.invalidateCache?.();
    } catch {
      /* best-effort only — must never break the underlying network op */
    }
  }

  /**
   * Tri-state existence check, classified by Docker's own status code
   * rather than treating "any error" as "absent" (defect F3).
   */
  async exists(name: string): Promise<NetworkExistence> {
    try {
      await this.docker.getNetwork(name).inspect();
      return 'present';
    } catch (err) {
      const statusCode = statusCodeOf(err);
      if (statusCode === 404) return 'absent';
      logger.warn(
        { name, statusCode, error: err instanceof Error ? err.message : String(err) },
        'Unable to determine network existence — Docker may be unreachable; treating as unknown',
      );
      return 'unknown';
    }
  }

  /**
   * Read Docker-owned facts about a network — IPAM subnet/gateway, labels,
   * and currently-attached container IDs — without exposing dockerode's own
   * inspect shape to callers. Returns `undefined` (not an error) when the
   * network doesn't exist; rethrows on any other inspect failure (Docker
   * unreachable) so callers can distinguish "absent" from "unknown", the
   * same contract as {@link exists}.
   *
   * Added so callers that need more than existence — e.g. reading the
   * subnet Docker's IPAM assigned to the egress network at creation time —
   * never need their own raw `docker.getNetwork(name).inspect()` call.
   */
  async inspect(name: string): Promise<NetworkInspectResult | undefined> {
    try {
      const info = await this.docker.getNetwork(name).inspect();
      const ipamCfg = info.IPAM?.Config?.[0];
      return {
        name: info.Name ?? name,
        id: info.Id,
        driver: info.Driver,
        labels: info.Labels ?? {},
        ipam: ipamCfg ? { subnet: ipamCfg.Subnet, gateway: ipamCfg.Gateway } : undefined,
        connectedContainerIds: Object.keys(info.Containers ?? {}),
      };
    } catch (err) {
      const statusCode = statusCodeOf(err);
      if (statusCode === 404) return undefined;
      logger.warn(
        { name, statusCode, error: err instanceof Error ? err.message : String(err) },
        'Failed to inspect network — Docker may be unreachable',
      );
      throw err;
    }
  }

  /**
   * Create the network if it doesn't exist, stamping the standard
   * `mini-infra.*` ownership labels (plus any `extraLabels`) and passing
   * `options` through to Docker (previously silently dropped — defect B2,
   * partial fix: create-time only, no recreate-on-mismatch yet).
   *
   * If the network already exists, verifies driver/labels/options against
   * the spec and logs a structured warning on mismatch — it does not
   * recreate or otherwise mutate an existing network (full drift
   * remediation is a later phase, on the desired-state model).
   *
   * A non-404 inspect error is treated as `unknown` (Docker unreachable) and
   * rethrown rather than racing a `create` against a network that might
   * actually be present.
   */
  async ensure(spec: EnsureNetworkSpec): Promise<EnsureNetworkResult> {
    const driver = spec.driver ?? 'bridge';
    const labels = { ...ownerLabels(spec.owner, spec.purpose), ...(spec.extraLabels ?? {}) };
    const options = normalizeOptions(spec.options);

    let inspectInfo: Docker.NetworkInspectInfo | undefined;
    try {
      inspectInfo = await this.docker.getNetwork(spec.name).inspect();
    } catch (err) {
      const statusCode = statusCodeOf(err);
      if (statusCode !== 404) {
        logger.error(
          { name: spec.name, statusCode, error: err instanceof Error ? err.message : String(err) },
          'Failed to inspect network while ensuring it exists — Docker may be unreachable',
        );
        throw err;
      }
    }

    if (!inspectInfo) {
      try {
        await this.docker.createNetwork({
          Name: spec.name,
          Driver: driver,
          Labels: labels,
          ...(options ? { Options: options } : {}),
        });
        this.invalidateCache();
        logger.info(
          { name: spec.name, owner: spec.owner, purpose: spec.purpose },
          'Created managed network',
        );
        return { name: spec.name, created: true, existence: 'present' };
      } catch (err) {
        const statusCode = statusCodeOf(err);
        if (statusCode === 409) {
          // Created concurrently by another apply racing this one.
          logger.debug({ name: spec.name }, 'Network already exists (race on create) — treating as present');
          return { name: spec.name, created: false, existence: 'present' };
        }
        throw err;
      }
    }

    const mismatch = detectMismatch(inspectInfo, { driver, labels, options });
    if (mismatch) {
      logger.warn({ name: spec.name, mismatch }, 'Existing network does not match desired spec');
    }
    return { name: spec.name, created: false, existence: 'present', mismatch };
  }

  /**
   * Idempotent connect: inspects the network's current endpoints first
   * (rather than matching error-message substrings) and treats an
   * already-attached container as success. If the pre-check is inconclusive
   * (inspect failed for a reason other than "network gone"), the connect
   * attempt itself is the fallback source of truth — a 403/409 from Docker
   * is its own idempotency signal for "already connected".
   */
  async connect(containerId: string, networkName: string, opts?: ConnectOptions): Promise<ConnectResult> {
    const network = this.docker.getNetwork(networkName);

    try {
      const info = await network.inspect();
      if (info.Containers && containerId in info.Containers) {
        return { connected: true, alreadyConnected: true };
      }
    } catch (err) {
      const statusCode = statusCodeOf(err);
      if (statusCode === 404) throw err;
      // Otherwise fall through — the connect attempt below is authoritative.
    }

    const endpointConfig: Docker.EndpointSettings = {};
    if (opts?.aliases && opts.aliases.length > 0) endpointConfig.Aliases = opts.aliases;
    if (opts?.staticIp) endpointConfig.IPAMConfig = { IPv4Address: opts.staticIp };

    try {
      await network.connect({
        Container: containerId,
        ...(Object.keys(endpointConfig).length > 0 ? { EndpointConfig: endpointConfig } : {}),
      });
      this.invalidateCache();
      return { connected: true, alreadyConnected: false };
    } catch (err) {
      const statusCode = statusCodeOf(err);
      if (statusCode === 403 || statusCode === 409) {
        // Docker's own "already connected" / duplicate-endpoint signal.
        return { connected: true, alreadyConnected: true };
      }
      throw err;
    }
  }

  /**
   * Idempotent disconnect: a 404 (network or endpoint already gone) is a
   * no-op success, not an error.
   */
  async disconnect(containerId: string, networkName: string, opts?: { force?: boolean }): Promise<void> {
    const network = this.docker.getNetwork(networkName);
    try {
      await network.disconnect({ Container: containerId, Force: opts?.force ?? false });
      this.invalidateCache();
    } catch (err) {
      const statusCode = statusCodeOf(err);
      if (statusCode === 404) return;
      throw err;
    }
  }

  /**
   * The sole "safe remove" implementation: inspect first, refuse when
   * containers are attached (unless `forceDisconnect` is explicitly set, in
   * which case attached containers are force-disconnected first), apply a
   * timeout to both the inspect and the remove call, and invalidate the
   * external network-list cache on success. Mirrors the semantics that used
   * to live only in `DockerService.removeNetwork` — never the blind
   * `InfrastructureManager.removeNetwork`.
   *
   * Does not throw on failure — returns a result with `reason` so batch
   * callers (`removeByOwner`) can continue past one bad network instead of
   * aborting the whole destroy.
   */
  async remove(networkName: string, opts?: RemoveNetworkOptions): Promise<RemoveNetworkResult> {
    const network = this.docker.getNetwork(networkName);

    let info: Docker.NetworkInspectInfo;
    try {
      info = await raceWithTimeout(
        network.inspect(),
        5000,
        `Docker API timeout while inspecting network ${networkName}`,
      );
    } catch (err) {
      const statusCode = statusCodeOf(err);
      if (statusCode === 404) {
        return { name: networkName, removed: false, reason: 'not-found' };
      }
      logger.warn(
        { name: networkName, error: err instanceof Error ? err.message : String(err) },
        'Failed to inspect network before removal, continuing',
      );
      return { name: networkName, removed: false, reason: 'error' };
    }

    const attachedContainers = Object.keys(info.Containers ?? {});
    if (attachedContainers.length > 0) {
      if (!opts?.forceDisconnect) {
        logger.warn(
          { name: networkName, containerCount: attachedContainers.length },
          'Refusing to remove network with attached containers',
        );
        return { name: networkName, removed: false, reason: 'has-containers' };
      }
      for (const containerId of attachedContainers) {
        try {
          await this.disconnect(containerId, networkName, { force: true });
        } catch (err) {
          logger.warn(
            { name: networkName, containerId, error: err instanceof Error ? err.message : String(err) },
            'Failed to force-disconnect container before network removal, continuing',
          );
        }
      }
    }

    try {
      await raceWithTimeout(
        network.remove(),
        5000,
        `Docker API timeout while removing network ${networkName}`,
      );
    } catch (err) {
      const statusCode = statusCodeOf(err);
      if (statusCode === 404) {
        return { name: networkName, removed: false, reason: 'not-found' };
      }
      logger.warn(
        { name: networkName, error: err instanceof Error ? err.message : String(err) },
        'Failed to remove network, continuing',
      );
      return { name: networkName, removed: false, reason: 'error' };
    }

    this.invalidateCache();
    logger.info({ name: networkName }, 'Removed managed network');
    return { name: networkName, removed: true };
  }

  /**
   * Label-driven bulk remove: queries Docker for every network carrying
   * `mini-infra.managed=true` + the owner's `owner-kind`/`owner-id` labels
   * and removes each one via {@link remove}. This is how stack destroy (and,
   * in a later phase, environment delete) reaps networks without
   * re-deriving names — the class of bug that orphaned networks on a
   * project-name mismatch (defect L1) can't recur here because there's no
   * name reconstruction on the primary path.
   *
   * `nameFallbackCandidates` covers networks created before this module
   * stamped ownership labels (Docker labels are immutable after creation —
   * this fallback is permanent, not a transition shim). Candidates already
   * removed via the label query are skipped; candidates that don't exist are
   * silently skipped (not an error); candidates whose existence is
   * `unknown` (Docker outage) are left alone rather than guessed at.
   */
  async removeByOwner(owner: NetworkOwner, opts?: RemoveByOwnerOptions): Promise<RemoveNetworkResult[]> {
    const labelFilters = [
      'mini-infra.managed=true',
      `mini-infra.owner-kind=${owner.kind}`,
      ...(owner.id ? [`mini-infra.owner-id=${owner.id}`] : []),
    ];

    const results: RemoveNetworkResult[] = [];
    const handledNames = new Set<string>();

    try {
      const matches = await this.docker.listNetworks({ filters: { label: labelFilters } });
      for (const net of matches) {
        results.push(await this.remove(net.Name, opts));
        handledNames.add(net.Name);
      }
    } catch (err) {
      logger.error(
        { owner, error: err instanceof Error ? err.message : String(err) },
        'Failed to list networks by owner label — Docker may be unreachable; falling back to name candidates only',
      );
    }

    for (const name of opts?.nameFallbackCandidates ?? []) {
      if (handledNames.has(name)) continue;
      handledNames.add(name);
      const existence = await this.exists(name);
      if (existence === 'present') {
        results.push(await this.remove(name, opts));
      }
      // 'absent' — nothing to do. 'unknown' — Docker outage; skip rather
      // than report a misleading not-found.
    }

    return results;
  }

  /**
   * Enumerate every `mini-infra.managed=true` network, optionally narrowed
   * by owner or purpose. This is the read side of the label-driven model
   * (§2.2 of the design doc): GC (`network-gc.ts`) uses it, unfiltered, to
   * find every candidate before resolving each one's owner against the DB —
   * it never enumerates or touches a network that isn't carrying this
   * label, so unlabelled/foreign networks on a shared Docker host are
   * invisible to it by construction, not by convention.
   *
   * One `listNetworks` call regardless of how many networks match — cheap
   * relative to {@link inspect}, which is one Docker API call per network
   * and is only worth paying for candidates GC has already narrowed down.
   */
  async listManaged(filter?: ListManagedFilter): Promise<ManagedNetworkInfo[]> {
    const labelFilters = ['mini-infra.managed=true'];
    if (filter?.owner) {
      labelFilters.push(`mini-infra.owner-kind=${filter.owner.kind}`);
      if (filter.owner.id) {
        labelFilters.push(`mini-infra.owner-id=${filter.owner.id}`);
      }
    }
    if (filter?.purpose) {
      labelFilters.push(`mini-infra.purpose=${filter.purpose}`);
    }

    const networks = await this.docker.listNetworks({ filters: { label: labelFilters } });
    return networks.map((net): ManagedNetworkInfo => {
      const labels = net.Labels ?? {};
      const ownerKind = (labels['mini-infra.owner-kind'] as NetworkOwner['kind'] | undefined) ?? 'host';
      return {
        name: net.Name,
        id: net.Id,
        driver: net.Driver,
        ownerKind,
        ownerId: labels['mini-infra.owner-id'],
        purpose: labels['mini-infra.purpose'] ?? '_stack',
        labels,
      };
    });
  }
}
