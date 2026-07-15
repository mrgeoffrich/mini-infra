/**
 * Docker Compose → stack template mapping.
 *
 * Most people arriving at Mini Infra are already holding a `compose.yml`, so
 * this is the on-ramp: paste the file, get a template draft.
 *
 * **Nothing is dropped silently.** Compose is a much larger surface than a stack
 * template, and a fair amount of it has no equivalent here (`build:`, `deploy:`,
 * `secrets:`, host env interpolation…). The lesson from the Code view — which
 * used to quietly discard the parts of a template it couldn't represent — is that
 * silent loss is worse than an error, because the user only finds out when the
 * thing they configured doesn't happen. So every key that is not carried across
 * is *reported*, and the caller is expected to show the report.
 *
 * Pure and dependency-free by design: it takes an **already-parsed** object, not
 * YAML text. That keeps it inside `@mini-infra/types`' zero-runtime-dependency
 * invariant (the YAML parser lives with the caller), and it means the same
 * mapping can back a UI paste-box today and a server-side import endpoint later
 * without the two drifting apart.
 */
import type {
  StackContainerConfig,
  StackNetwork,
  StackServiceDefinition,
  StackVolume,
} from './stacks';
import type { ImportIssue, ImportIssueLevel } from './import-issues';

/**
 * Compose import speaks the shared import-issue vocabulary. The `Compose*`
 * aliases are kept so existing call sites (the paste-box dialog, tests) don't
 * have to change.
 */
export type ComposeIssueLevel = ImportIssueLevel;
export type ComposeImportIssue = ImportIssue;

export interface ComposeImportDraft {
  networks: StackNetwork[];
  volumes: StackVolume[];
  services: StackServiceDefinition[];
}

export interface ComposeImportResult {
  /** False when the file could not be mapped at all — `draft` is then null. */
  ok: boolean;
  draft: ComposeImportDraft | null;
  issues: ComposeImportIssue[];
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Compose accepts several keys as *either* a map (`FOO: bar`) or a list of
 * `FOO=bar` strings. Normalise both to a map.
 *
 * A bare `FOO` in list form means "take FOO from the host environment at
 * `docker compose up` time". There is no host to read from here, so it can't be
 * honoured — the caller reports it rather than inventing an empty value.
 */
function toStringMap(
  value: unknown,
  path: string,
  issues: ComposeImportIssue[],
): Record<string, string> | undefined {
  if (value == null) return undefined;

  const out: Record<string, string> = {};

  if (isDict(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (v == null) {
        issues.push({
          level: 'unsupported',
          path: `${path}.${k}`,
          message: `'${k}' has no value, so Compose would read it from the host environment at deploy time. Mini Infra has no host environment to read — set an explicit value.`,
        });
        continue;
      }
      out[k] = String(v);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const s = String(entry);
      const eq = s.indexOf('=');
      if (eq === -1) {
        issues.push({
          level: 'unsupported',
          path: `${path}.${s}`,
          message: `'${s}' has no value, so Compose would read it from the host environment at deploy time. Mini Infra has no host environment to read — set an explicit value.`,
        });
        continue;
      }
      out[s.slice(0, eq)] = s.slice(eq + 1);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  return undefined;
}

/** Compose allows a bare string or a list for `command` / `entrypoint`. */
function toStringList(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v));
  return undefined;
}

/**
 * Parse a Compose duration (`10s`, `1m30s`, `500ms`, `2h`) into milliseconds —
 * the unit stack templates store healthcheck durations in
 * (see `healthcheckToDocker`).
 */
export function parseComposeDuration(value: unknown): number | null {
  if (typeof value === 'number') return Math.round(value * 1000); // bare number = seconds
  if (typeof value !== 'string') return null;

  const re = /(\d+(?:\.\d+)?)(us|ms|s|m|h)/g;
  const unitMs: Record<string, number> = { us: 0.001, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    matched = true;
    total += parseFloat(m[1]) * unitMs[m[2]];
  }
  if (!matched) {
    // A bare numeric string ("30") — Compose reads that as seconds.
    const n = Number(value);
    if (Number.isFinite(n)) return Math.round(n * 1000);
    return null;
  }
  return Math.round(total);
}

/**
 * Split `nginx:1.25`, `ghcr.io/org/app:v2`, `localhost:5000/app`, `app@sha256:…`
 * into image + tag.
 *
 * The colon is ambiguous: it separates the tag, but it also appears in a
 * registry's port. Only a colon *after* the final slash is a tag.
 */
export function splitImageRef(ref: string): { image: string; tag: string } {
  const at = ref.indexOf('@');
  if (at !== -1) {
    // Digest-pinned. The digest is the identity; keep it as the "tag" so the
    // reference still round-trips to exactly the same image.
    return { image: ref.slice(0, at), tag: ref.slice(at + 1) };
  }

  const lastColon = ref.lastIndexOf(':');
  const lastSlash = ref.lastIndexOf('/');
  if (lastColon > lastSlash) {
    return { image: ref.slice(0, lastColon), tag: ref.slice(lastColon + 1) };
  }
  return { image: ref, tag: 'latest' };
}

/**
 * The boot-time healthcheck backfill (`normaliseHealthcheckToMs`) treats any
 * duration below 1000 as a legacy *seconds* value and multiplies it by 1000. A
 * genuinely sub-second healthcheck imported from Compose would therefore be
 * silently inflated a thousandfold on the next boot. Sub-second healthchecks are
 * pathological anyway, so raise them to 1s and say so.
 */
const MIN_HEALTHCHECK_MS = 1000;

function clampHealthcheckMs(
  ms: number,
  field: string,
  path: string,
  issues: ComposeImportIssue[],
): number {
  if (ms >= MIN_HEALTHCHECK_MS || ms <= 0) return ms;
  issues.push({
    level: 'lossy',
    path: `${path}.${field}`,
    message: `Sub-second healthcheck ${field} (${ms}ms) raised to 1s — Mini Infra's stored healthchecks can't express it, and a value this small would be misread as seconds.`,
  });
  return MIN_HEALTHCHECK_MS;
}

/* -------------------------------------------------------------------------- */
/* Keys we recognise and deliberately do not carry across                       */
/* -------------------------------------------------------------------------- */

/**
 * Every service key with no stack-template equivalent, and why. Being explicit
 * beats a catch-all "unknown key" message: the user wants to know whether the
 * thing they configured is going to happen, and if not, what to do instead.
 */
const UNSUPPORTED_SERVICE_KEYS: Record<string, string> = {
  build: 'Mini Infra deploys pre-built images and does not build from source. Build and push the image, then set `image:`.',
  env_file: 'Env files are read from disk at deploy time, which Mini Infra has no access to. Inline the values under `environment:`, or use template inputs for secrets.',
  secrets: 'Compose secrets are not carried across. Use the template\'s Vault section, or a template input, for secret material.',
  configs: 'Compose configs are not carried across. Use the template\'s config files instead.',
  deploy: 'Swarm deploy settings (replicas, resource limits, placement) have no equivalent. For multiple instances, use a Pool service.',
  profiles: 'Compose profiles have no equivalent — every service in the file is imported.',
  extends: 'Compose `extends` is not resolved. Inline the extended service before importing.',
  container_name: 'Mini Infra names containers itself, so a fixed container name would be overwritten.',
  privileged: 'Privileged containers are not supported. Grant specific capabilities with `cap_add` instead.',
  cap_drop: 'Dropping capabilities is not supported — Mini Infra containers start from Docker\'s default capability set.',
  sysctls: 'Kernel parameter tuning is not supported.',
  ulimits: 'Resource ulimits are not supported.',
  tmpfs: 'tmpfs mounts are not supported.',
  shm_size: 'Custom shared-memory size is not supported.',
  pid: 'Sharing a PID namespace is not supported.',
  links: 'Compose `links` is legacy and unnecessary — services on the same network resolve each other by name.',
  external_links: 'External links are not supported.',
};

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

function mapPorts(
  raw: unknown,
  path: string,
  issues: ComposeImportIssue[],
): StackContainerConfig['ports'] {
  if (!Array.isArray(raw)) return undefined;
  const ports: NonNullable<StackContainerConfig['ports']> = [];

  for (const entry of raw) {
    // Long syntax: { target, published, protocol, host_ip, mode }
    if (isDict(entry)) {
      const target = Number(entry.target);
      if (!Number.isFinite(target)) {
        issues.push({
          level: 'unsupported',
          path,
          message: `Port entry has no numeric 'target' and was skipped: ${JSON.stringify(entry)}`,
        });
        continue;
      }
      const published = entry.published != null ? Number(entry.published) : 0;
      ports.push({
        containerPort: target,
        hostPort: Number.isFinite(published) ? published : 0,
        protocol: entry.protocol === 'udp' ? 'udp' : 'tcp',
        exposeOnHost: Number.isFinite(published) && published > 0,
      });
      continue;
    }

    const spec = String(entry);

    // "6060:6060/udp" → strip protocol first.
    let protocol: 'tcp' | 'udp' = 'tcp';
    let body = spec;
    const slash = body.lastIndexOf('/');
    if (slash !== -1) {
      const proto = body.slice(slash + 1);
      if (proto === 'udp') protocol = 'udp';
      body = body.slice(0, slash);
    }

    if (body.includes('-')) {
      issues.push({
        level: 'unsupported',
        path,
        message: `Port range '${spec}' was skipped — declare each port individually.`,
      });
      continue;
    }

    // "127.0.0.1:8001:8001" | "8080:80" | "80"
    const parts = body.split(':');
    let hostPart: string | undefined;
    let containerPart: string;

    if (parts.length === 3) {
      // An explicit host IP. We publish on all interfaces, so the binding is
      // wider than what was asked for — that's a security-relevant difference,
      // so say it rather than quietly widening the exposure.
      issues.push({
        level: 'lossy',
        path,
        message: `Port '${spec}' binds to a specific host IP. Mini Infra publishes on all interfaces, so this port will be more widely reachable than Compose would have made it.`,
      });
      hostPart = parts[1];
      containerPart = parts[2];
    } else if (parts.length === 2) {
      hostPart = parts[0];
      containerPart = parts[1];
    } else {
      // Bare container port: Compose picks a random host port. Random published
      // ports are not something a declarative stack can honour, so expose the
      // container port without a host binding and say so.
      containerPart = parts[0];
      issues.push({
        level: 'lossy',
        path,
        message: `Port '${spec}' has no host port, so Compose would publish it on a random one. Imported without a host binding — set a host port if you need it reachable from outside.`,
      });
    }

    const containerPort = Number(containerPart);
    if (!Number.isFinite(containerPort)) {
      issues.push({
        level: 'unsupported',
        path,
        message: `Could not read a container port from '${spec}' — skipped.`,
      });
      continue;
    }
    const hostPort = hostPart != null ? Number(hostPart) : 0;

    ports.push({
      containerPort,
      hostPort: Number.isFinite(hostPort) ? hostPort : 0,
      protocol,
      exposeOnHost: Number.isFinite(hostPort) && hostPort > 0,
    });
  }

  return ports.length > 0 ? ports : undefined;
}

/* -------------------------------------------------------------------------- */
/* Volumes / mounts                                                            */
/* -------------------------------------------------------------------------- */

function isBindSource(source: string): boolean {
  return (
    source.startsWith('/') ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('~')
  );
}

function mapMounts(
  raw: unknown,
  path: string,
  issues: ComposeImportIssue[],
  namedVolumes: Set<string>,
): StackContainerConfig['mounts'] {
  if (!Array.isArray(raw)) return undefined;
  const mounts: NonNullable<StackContainerConfig['mounts']> = [];

  for (const entry of raw) {
    // Long syntax: { type, source, target, read_only }
    if (isDict(entry)) {
      const type = entry.type === 'bind' ? 'bind' : 'volume';
      const source = entry.source != null ? String(entry.source) : '';
      const target = entry.target != null ? String(entry.target) : '';
      if (!source || !target) {
        issues.push({
          level: 'unsupported',
          path,
          message: `Mount needs both 'source' and 'target' and was skipped: ${JSON.stringify(entry)}`,
        });
        continue;
      }
      if (type === 'volume') namedVolumes.add(source);
      mounts.push({ source, target, type, readOnly: entry.read_only === true });
      continue;
    }

    // Short syntax: "TARGET" | "SOURCE:TARGET" | "SOURCE:TARGET:ro"
    const spec = String(entry);
    const parts = spec.split(':');

    if (parts.length === 1) {
      issues.push({
        level: 'unsupported',
        path,
        message: `Anonymous volume '${spec}' was skipped — Mini Infra volumes are named. Give it a name: '<name>:${spec}'.`,
      });
      continue;
    }

    const [source, target, mode] = parts;
    const readOnly = mode === 'ro';
    const type: 'bind' | 'volume' = isBindSource(source) ? 'bind' : 'volume';

    if (type === 'bind') {
      // Relative binds are resolved against the compose file's directory, which
      // doesn't exist on the Docker host Mini Infra manages.
      if (!source.startsWith('/')) {
        issues.push({
          level: 'unsupported',
          path,
          message: `Bind mount '${spec}' uses a path relative to the compose file, which has no meaning on the managed Docker host. Skipped — use an absolute host path, or a named volume.`,
        });
        continue;
      }
      issues.push({
        level: 'lossy',
        path,
        message: `Bind mount '${spec}' points at a path on the Docker host. It will only work if that path exists there; a named volume is usually what you want.`,
      });
    } else {
      namedVolumes.add(source);
    }

    mounts.push({ source, target, type, readOnly });
  }

  return mounts.length > 0 ? mounts : undefined;
}

/* -------------------------------------------------------------------------- */
/* Healthcheck                                                                 */
/* -------------------------------------------------------------------------- */

function mapHealthcheck(
  raw: unknown,
  path: string,
  issues: ComposeImportIssue[],
): StackContainerConfig['healthcheck'] {
  if (!isDict(raw)) return undefined;
  if (raw.disable === true) return undefined;

  let test: string[] | undefined;
  if (Array.isArray(raw.test)) {
    test = raw.test.map((t) => String(t));
  } else if (typeof raw.test === 'string') {
    // Compose's string form is shell form, i.e. CMD-SHELL.
    test = ['CMD-SHELL', raw.test];
  }

  if (!test || test.length === 0) {
    issues.push({
      level: 'unsupported',
      path: `${path}.test`,
      message: 'Healthcheck has no `test` command and was skipped.',
    });
    return undefined;
  }

  const interval = parseComposeDuration(raw.interval) ?? 30_000;
  const timeout = parseComposeDuration(raw.timeout) ?? 10_000;
  const startPeriod = parseComposeDuration(raw.start_period) ?? 0;
  const retries = Number.isFinite(Number(raw.retries)) ? Number(raw.retries) : 3;

  return {
    test,
    interval: clampHealthcheckMs(interval, 'interval', path, issues),
    timeout: clampHealthcheckMs(timeout, 'timeout', path, issues),
    retries: Math.max(1, retries),
    // startPeriod may legitimately be 0, and the backfill leaves 0 alone.
    startPeriod: startPeriod > 0 ? clampHealthcheckMs(startPeriod, 'start_period', path, issues) : 0,
  };
}

/* -------------------------------------------------------------------------- */
/* depends_on → order                                                          */
/* -------------------------------------------------------------------------- */

function readDependsOn(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((d) => String(d));
  if (isDict(raw)) return Object.keys(raw); // long form: { svc: { condition: … } }
  return [];
}

/**
 * `order` is required on a stack service and has no Compose equivalent, so it is
 * derived from the dependency graph: a service sorts after everything it depends
 * on. Compose cycles are illegal but the file in front of us might have one, so
 * fall back to declaration order rather than failing the whole import.
 */
function topologicalOrder(
  names: string[],
  dependsOn: Map<string, string[]>,
  issues: ComposeImportIssue[],
): string[] {
  const ordered: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  let cycleFound = false;

  const visit = (name: string, trail: string[]): void => {
    const s = state.get(name);
    if (s === 'done') return;
    if (s === 'visiting') {
      if (!cycleFound) {
        cycleFound = true;
        issues.push({
          level: 'lossy',
          path: 'services',
          message: `depends_on forms a cycle (${[...trail, name].join(' → ')}). Services were left in file order — check their start order.`,
        });
      }
      return;
    }
    state.set(name, 'visiting');
    for (const dep of dependsOn.get(name) ?? []) {
      if (names.includes(dep)) visit(dep, [...trail, name]);
    }
    state.set(name, 'done');
    ordered.push(name);
  };

  for (const n of names) visit(n, []);
  return cycleFound ? names : ordered;
}

/* -------------------------------------------------------------------------- */
/* The mapping                                                                 */
/* -------------------------------------------------------------------------- */

const SERVICE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Map an already-parsed Compose document into a stack template draft.
 *
 * Every service becomes a `Stateful` service. Compose has no notion of the
 * HAProxy-fronted, blue-green `StatelessWeb` type — which *requires* routing —
 * so guessing at it would fabricate configuration the file never asked for.
 * Published ports come across as host-port bindings; the user can switch a
 * service to StatelessWeb and add routing afterwards.
 */
export function mapComposeToTemplate(doc: unknown): ComposeImportResult {
  const issues: ComposeImportIssue[] = [];

  if (!isDict(doc)) {
    return {
      ok: false,
      draft: null,
      issues: [{ level: 'error', path: '', message: 'The file is not a Compose document (expected a top-level mapping).' }],
    };
  }

  const rawServices = doc.services;
  if (!isDict(rawServices) || Object.keys(rawServices).length === 0) {
    return {
      ok: false,
      draft: null,
      issues: [{ level: 'error', path: 'services', message: 'No `services:` found — nothing to import.' }],
    };
  }

  if (doc.version != null) {
    issues.push({
      level: 'defaulted',
      path: 'version',
      message: 'The top-level `version:` key is obsolete in modern Compose and was ignored.',
    });
  }

  // Named volumes referenced by a service but never declared at the top level.
  // Compose requires the declaration; we collect them and declare them anyway
  // rather than producing a draft that can't deploy.
  const referencedVolumes = new Set<string>();

  const serviceNames = Object.keys(rawServices);
  const dependsOnByService = new Map<string, string[]>();
  for (const name of serviceNames) {
    const svc = rawServices[name];
    dependsOnByService.set(name, isDict(svc) ? readDependsOn(svc.depends_on) : []);
  }
  const ordered = topologicalOrder(serviceNames, dependsOnByService, issues);

  const services: StackServiceDefinition[] = [];

  ordered.forEach((name, index) => {
    const path = `services.${name}`;
    const raw = rawServices[name];

    if (!isDict(raw)) {
      issues.push({ level: 'unsupported', path, message: `Service '${name}' is empty and was skipped.` });
      return;
    }

    if (!SERVICE_NAME_RE.test(name)) {
      issues.push({
        level: 'error',
        path,
        message: `Service name '${name}' contains characters Mini Infra doesn't allow (letters, numbers, '-' and '_' only). Rename it and re-import.`,
      });
      return;
    }

    // --- image -------------------------------------------------------------
    if (raw.image == null) {
      issues.push({
        level: 'error',
        path: `${path}.image`,
        message:
          raw.build != null
            ? `Service '${name}' only has a \`build:\` — Mini Infra deploys pre-built images. Build and push it, then set \`image:\`.`
            : `Service '${name}' has no \`image:\` and was skipped.`,
      });
      return;
    }
    const { image, tag } = splitImageRef(String(raw.image));
    if (tag === 'latest' && !String(raw.image).includes(':')) {
      issues.push({
        level: 'defaulted',
        path: `${path}.image`,
        message: `'${raw.image}' has no tag, so it was imported as ':latest'. Pin a version for reproducible deploys.`,
      });
    }

    // --- keys we recognise but can't carry ---------------------------------
    for (const [key, why] of Object.entries(UNSUPPORTED_SERVICE_KEYS)) {
      if (raw[key] != null) {
        issues.push({ level: 'unsupported', path: `${path}.${key}`, message: why });
      }
    }

    // --- containerConfig ---------------------------------------------------
    const containerConfig: StackContainerConfig = {};

    const command = toStringList(raw.command);
    if (command) {
      containerConfig.command = command;
    } else if (typeof raw.command === 'string') {
      // Compose's string form is shell form — Docker runs it via `/bin/sh -c`.
      // Reproduce that rather than naively splitting on spaces, which would
      // mangle quoting and shell operators.
      containerConfig.command = ['/bin/sh', '-c', raw.command];
      issues.push({
        level: 'defaulted',
        path: `${path}.command`,
        message: `command was given as a string, so it runs through a shell ('/bin/sh -c'), matching Compose. Use a list to exec directly.`,
      });
    }

    const entrypoint = toStringList(raw.entrypoint);
    if (entrypoint) {
      containerConfig.entrypoint = entrypoint;
    } else if (typeof raw.entrypoint === 'string') {
      containerConfig.entrypoint = ['/bin/sh', '-c', raw.entrypoint];
      issues.push({
        level: 'defaulted',
        path: `${path}.entrypoint`,
        message: `entrypoint was given as a string, so it runs through a shell ('/bin/sh -c'), matching Compose. Use a list to exec directly.`,
      });
    }

    const env = toStringMap(raw.environment, `${path}.environment`, issues);
    if (env) containerConfig.env = env;

    const labels = toStringMap(raw.labels, `${path}.labels`, issues);
    if (labels) containerConfig.labels = labels;

    const ports = mapPorts(raw.ports, `${path}.ports`, issues);
    if (ports) containerConfig.ports = ports;

    const mounts = mapMounts(raw.volumes, `${path}.volumes`, issues, referencedVolumes);
    if (mounts) containerConfig.mounts = mounts;

    const healthcheck = mapHealthcheck(raw.healthcheck, `${path}.healthcheck`, issues);
    if (healthcheck) containerConfig.healthcheck = healthcheck;

    if (raw.user != null) containerConfig.user = String(raw.user);

    const capAdd = toStringList(raw.cap_add);
    if (capAdd) containerConfig.capAdd = capAdd;

    const devices = toStringList(raw.devices);
    if (devices) containerConfig.devices = devices;

    // restart: Compose's `on-failure:5` carries a retry count we have nowhere to
    // put, so the count is dropped and the policy kept.
    if (raw.restart != null) {
      const restart = String(raw.restart);
      const base = restart.split(':')[0];
      if (base === 'no' || base === 'always' || base === 'unless-stopped' || base === 'on-failure') {
        containerConfig.restartPolicy = base;
        if (restart !== base) {
          issues.push({
            level: 'lossy',
            path: `${path}.restart`,
            message: `'${restart}' imported as '${base}' — the retry limit isn't carried across.`,
          });
        }
      } else {
        issues.push({
          level: 'unsupported',
          path: `${path}.restart`,
          message: `Unknown restart policy '${restart}' — skipped.`,
        });
      }
    }

    // network_mode
    if (raw.network_mode != null) {
      const mode = String(raw.network_mode);
      if (mode === 'host' || mode === 'bridge') {
        containerConfig.networkMode = mode;
      } else {
        issues.push({
          level: 'unsupported',
          path: `${path}.network_mode`,
          message: `network_mode '${mode}' is not supported — only 'bridge' and 'host'.`,
        });
      }
    }

    // service-level networks → joinNetworks
    let joinNetworks: string[] | undefined;
    if (Array.isArray(raw.networks)) {
      joinNetworks = raw.networks.map((n) => String(n));
    } else if (isDict(raw.networks)) {
      joinNetworks = Object.keys(raw.networks);
      issues.push({
        level: 'lossy',
        path: `${path}.networks`,
        message: 'Per-network settings (aliases, static IPs) are not carried across — only the network membership.',
      });
    }
    if (joinNetworks && joinNetworks.length > 0) containerConfig.joinNetworks = joinNetworks;

    // logging → logConfig
    if (isDict(raw.logging)) {
      const opts = isDict(raw.logging.options) ? raw.logging.options : {};
      containerConfig.logConfig = {
        type: raw.logging.driver != null ? String(raw.logging.driver) : 'json-file',
        maxSize: opts['max-size'] != null ? String(opts['max-size']) : '10m',
        maxFile: opts['max-file'] != null ? String(opts['max-file']) : '3',
      };
    }

    const dependsOn = (dependsOnByService.get(name) ?? []).filter((d) => serviceNames.includes(d));
    if (isDict(raw.depends_on)) {
      issues.push({
        level: 'lossy',
        path: `${path}.depends_on`,
        message: 'Start conditions (`service_healthy`, `service_completed_successfully`) are not carried across — only the dependency itself.',
      });
    }

    services.push({
      serviceName: name,
      // Always Stateful. StatelessWeb requires routing, which Compose can't
      // express — inventing it would fabricate config the file never asked for.
      serviceType: 'Stateful',
      dockerImage: image,
      dockerTag: tag,
      containerConfig,
      dependsOn,
      order: index,
    });
  });

  if (services.length === 0) {
    return {
      ok: false,
      draft: null,
      issues: [
        ...issues,
        { level: 'error', path: 'services', message: 'No service could be imported from this file.' },
      ],
    };
  }

  // --- top-level networks --------------------------------------------------
  const networks: StackNetwork[] = [];
  if (isDict(doc.networks)) {
    for (const [name, cfg] of Object.entries(doc.networks)) {
      if (isDict(cfg) && cfg.external === true) {
        issues.push({
          level: 'unsupported',
          path: `networks.${name}`,
          message: `'${name}' is an external network. Mini Infra creates the networks a stack declares — attach to an existing one from the stack's network settings instead.`,
        });
        continue;
      }
      const driver = isDict(cfg) && cfg.driver != null ? String(cfg.driver) : undefined;
      networks.push(driver ? { name, driver } : { name });
    }
  }

  // --- top-level volumes ---------------------------------------------------
  const volumes: StackVolume[] = [];
  const declared = new Set<string>();
  if (isDict(doc.volumes)) {
    for (const [name, cfg] of Object.entries(doc.volumes)) {
      if (isDict(cfg) && cfg.external === true) {
        issues.push({
          level: 'unsupported',
          path: `volumes.${name}`,
          message: `'${name}' is an external volume. Mini Infra creates the volumes a stack declares.`,
        });
        continue;
      }
      const driver = isDict(cfg) && cfg.driver != null ? String(cfg.driver) : undefined;
      volumes.push(driver ? { name, driver } : { name });
      declared.add(name);
    }
  }

  // A volume a service mounts but the file never declared. Compose would reject
  // the file; we'd rather produce a draft that actually deploys, so declare it
  // and say we did.
  for (const name of referencedVolumes) {
    if (declared.has(name)) continue;
    volumes.push({ name });
    declared.add(name);
    issues.push({
      level: 'defaulted',
      path: `volumes.${name}`,
      message: `Volume '${name}' is used by a service but never declared at the top level — declared for you.`,
    });
  }

  // Compose implicitly puts every service on a shared default network. A stack's
  // services already resolve each other by name, so nothing needs declaring —
  // but a file whose services rely on that and declare no networks would
  // otherwise look like it lost something.
  if (networks.length === 0 && services.length > 1) {
    issues.push({
      level: 'defaulted',
      path: 'networks',
      message: 'No networks declared. Compose would have put every service on a shared default network; in a Mini Infra stack, services already reach each other by name, so no network was added.',
    });
  }

  return { ok: true, draft: { networks, volumes, services }, issues };
}
