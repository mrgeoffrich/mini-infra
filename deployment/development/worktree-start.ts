#!/usr/bin/env -S pnpm dlx tsx@^4.21.0
// Mini Infra Per-Worktree Development Startup (TypeScript)
//
// Runs one fully isolated Mini Infra instance per worktree by giving each a
// dedicated Colima VM (its own Docker daemon) and a namespaced Compose project.
// Ports are allocated from ~/.mini-infra/worktrees.yaml so re-runs are stable.
//
// Usage: tsx worktree-start.ts [--profile <name>] [--description <short>] [--long-description <long>] [--reset] [--skip-seed] [--seed]
//
// After the app is healthy, this script calls the in-process seeder (POST
// /setup, issue an admin API key, seed service configs, apply HAProxy stack)
// and then writes admin credentials into the central worktrees.yaml.

import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';
import { logInfo, logOk, logWarn, logError } from './lib/log.js';
import {
  allocatePorts,
  DEV_ENV_FILE,
  MINI_INFRA_HOME,
  migrateFromJsonIfNeeded,
  upsertEntry,
  loadRegistry,
} from './lib/registry.js';
import { readEnvironmentDetails, writeMinimalEnvironmentDetails } from './lib/env-details.js';
import { isColimaRunning, startColima } from './lib/colima.js';
import {
  assertWslAvailable,
  defaultBaseTarballPath,
  defaultInstallDir,
  distroExists,
  distroName,
  ensureDockerReady,
  importDistro,
  isDistroRunning,
  startDocker as startWslDocker,
} from './lib/wsl.js';
import { seed, ensureVaultUnlocked } from './lib/seeder.js';
import { ApiClient } from './lib/api.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const COMPOSE_FILE = path.join(SCRIPT_DIR, 'docker-compose.worktree.yaml');

const COLIMA_CPUS = 2;
const COLIMA_MEMORY_GIB = 8;

type Driver = 'colima' | 'wsl';

function pickDriver(): Driver {
  const env = process.env.MINI_INFRA_DRIVER;
  if (env === 'colima' || env === 'wsl') return env;
  if (env) {
    logWarn(`Unknown MINI_INFRA_DRIVER='${env}' — falling back to platform default`);
  }
  return process.platform === 'darwin' ? 'colima' : 'wsl';
}

function usage(): void {
  const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  console.log(lines.slice(1, 12).join('\n'));
}

function normaliseProfile(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url: string, attempts: number, label: string): Promise<boolean> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // swallow — expected during startup
    }
    if (i % 10 === 0) logInfo(`Still waiting... (${i}s elapsed) — ${label}`);
    await sleep(1000);
  }
  return false;
}

function commandExists(cmd: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [cmd] : ['-v', cmd];
  const opts = process.platform === 'win32' ? {} : { shell: '/bin/bash' };
  return spawnSync(probe, args, opts).status === 0;
}

// On Windows, spawnSync without `shell:true` only resolves .exe — it can't
// find .cmd shims like corepack.cmd or pnpm.cmd. Enabling shell on Windows
// routes through cmd.exe which respects PATHEXT.
const NEEDS_SHELL = process.platform === 'win32';

function exec(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; stdio?: 'inherit' | 'pipe' } = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    cwd: opts.cwd,
    stdio: opts.stdio || 'pipe',
    shell: NEEDS_SHELL,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function compose(args: string[], env: NodeJS.ProcessEnv, stdio: 'inherit' | 'pipe' = 'inherit'): number {
  const res = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    env: { ...process.env, ...env },
    stdio,
    shell: NEEDS_SHELL,
  });
  return res.status ?? 1;
}

interface Args {
  profile?: string;
  reset: boolean;
  skipSeed: boolean;
  forceSeed: boolean;
  description?: string;
  longDescription?: string;
}

function parseCliArgs(): Args {
  try {
    const { values } = parseArgs({
      options: {
        profile: { type: 'string' },
        reset: { type: 'boolean', default: false },
        'skip-seed': { type: 'boolean', default: false },
        seed: { type: 'boolean', default: false },
        description: { type: 'string' },
        'long-description': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    });
    if (values.help) {
      usage();
      process.exit(0);
    }
    return {
      profile: values.profile as string | undefined,
      reset: Boolean(values.reset),
      skipSeed: Boolean(values['skip-seed']),
      forceSeed: Boolean(values.seed),
      description: values.description as string | undefined,
      longDescription: values['long-description'] as string | undefined,
    };
  } catch (err) {
    logError(`Unknown arg: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function warnWordCount(value: string, max: number, label: string): void {
  const count = value.trim().split(/\s+/).filter(Boolean).length;
  if (count > max) logWarn(`${label} is ${count} words (recommended max ${max})`);
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    return /^[Yy]$/.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const driver = pickDriver();
  logInfo(`VM driver: ${driver}`);

  let profile = args.profile;
  if (!profile) {
    profile = path.basename(PROJECT_ROOT);
  }
  profile = normaliseProfile(profile);
  if (!profile) {
    logError('Could not derive a valid profile name');
    process.exit(1);
  }
  logInfo(`Worktree profile: ${profile}`);

  // Prereqs — driver-specific tools first, then the always-required ones.
  if (driver === 'colima' && !commandExists('colima')) {
    logError('colima is not installed. Install with: brew install colima');
    process.exit(1);
  }
  if (driver === 'wsl') {
    try {
      assertWslAvailable();
    } catch (err) {
      logError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
  if (!commandExists('docker')) {
    const hint =
      driver === 'wsl'
        ? 'Install the Docker CLI: https://download.docker.com/win/static/stable/'
        : 'Install with: brew install docker';
    logError(`docker CLI is not installed. ${hint}`);
    process.exit(1);
  }
  if (!commandExists('corepack')) {
    logError('corepack is not available. Install a recent Node.js (>=16.9) or run: npm install -g corepack');
    process.exit(1);
  }

  // Sync host-side Node dependencies via pnpm (pinned in package.json
  // via the `packageManager` field). Idempotent; fast on warm installs.
  logInfo('Syncing host-side Node dependencies via pnpm...');
  const prep = exec('corepack', ['prepare', '--activate'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
  if (prep.status !== 0) {
    logError('corepack prepare failed — is your Node version recent enough?');
    process.exit(1);
  }
  const install = exec('pnpm', ['install', '--frozen-lockfile'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
  if (install.status !== 0) {
    logError('pnpm install failed');
    process.exit(1);
  }
  logOk('Host dependencies synced');

  fs.mkdirSync(MINI_INFRA_HOME, { recursive: true });
  migrateFromJsonIfNeeded();

  // Description resolution
  const existingEntry = loadRegistry()[profile];
  let shortDesc: string | undefined;
  let longDesc: string | undefined;

  if (args.description) {
    shortDesc = args.description;
    longDesc = args.longDescription;
    warnWordCount(shortDesc, 10, 'Short description');
    if (longDesc) warnWordCount(longDesc, 50, 'Long description');
  } else if (existingEntry?.description) {
    shortDesc = existingEntry.description;
    logInfo(`Worktree description: ${shortDesc}`);
  } else {
    logInfo(
      'Tip: pass --description "<short>" (and optionally --long-description "<long>") to skip these prompts.',
    );
    const rl = readline.createInterface({ input, output });
    try {
      shortDesc = (await rl.question('Short description (≤10 words, what is this worktree for?): ')).trim();
      warnWordCount(shortDesc, 10, 'Short description');
      const longRaw = (await rl.question('Long description (≤50 words, optional — press Enter to skip): ')).trim();
      if (longRaw) {
        longDesc = longRaw;
        warnWordCount(longDesc, 50, 'Long description');
      }
    } finally {
      rl.close();
    }
  }

  // Port allocation
  const {
    ui_port: uiPort,
    registry_port: registryPort,
    vault_port: vaultPort,
    docker_port: dockerPort,
    haproxy_http_port: haproxyHttpPort,
    haproxy_https_port: haproxyHttpsPort,
    haproxy_stats_port: haproxyStatsPort,
    haproxy_dataplane_port: haproxyDataplanePort,
  } = allocatePorts(profile);
  // Persist early so the entry exists even if later steps fail
  upsertEntry({
    profile,
    worktree_path: PROJECT_ROOT,
    colima_vm: driver === 'wsl' ? distroName(profile) : profile,
    ui_port: uiPort,
    registry_port: registryPort,
    vault_port: vaultPort,
    docker_port: dockerPort,
    haproxy_http_port: haproxyHttpPort,
    haproxy_https_port: haproxyHttpsPort,
    haproxy_stats_port: haproxyStatsPort,
    haproxy_dataplane_port: haproxyDataplanePort,
    url: `http://localhost:${uiPort}`,
    description: shortDesc,
  });
  logInfo(
    `Ports: UI=${uiPort}, registry=${registryPort}, vault=${vaultPort}` +
      (driver === 'wsl' ? `, docker=${dockerPort}` : '') +
      `, haproxy(http/https/stats/dataplane)=${haproxyHttpPort}/${haproxyHttpsPort}/${haproxyStatsPort}/${haproxyDataplanePort}`,
  );

  // Bring the VM up via the selected driver. For environment-details.xml,
  // colima exposes a host-side unix socket path; wsl exposes only TCP, so
  // the socket field is empty there.
  let dockerHost: string;
  let dockerSockPath = '';
  if (driver === 'colima') {
    if (!isColimaRunning(profile)) {
      logInfo(`Starting Colima profile '${profile}' (vz, ${COLIMA_CPUS} CPU, ${COLIMA_MEMORY_GIB}G RAM)...`);
      startColima({ profile, cpus: COLIMA_CPUS, memoryGib: COLIMA_MEMORY_GIB });
      logOk(`Colima profile '${profile}' started`);
    } else {
      logInfo(`Colima profile '${profile}' already running`);
    }
    dockerSockPath = path.join(process.env.HOME || '', '.colima', profile, 'docker.sock');
    if (!fs.existsSync(dockerSockPath)) {
      logError(`Expected Colima socket not found at ${dockerSockPath}`);
      process.exit(1);
    }
    dockerHost = `unix://${dockerSockPath}`;
  } else {
    const distro = distroName(profile);
    if (!distroExists(distro)) {
      const baseTar = defaultBaseTarballPath(MINI_INFRA_HOME);
      if (!fs.existsSync(baseTar)) {
        logError(`Base tarball not found at ${baseTar}.`);
        logError('Run scripts\\build-wsl-base.ps1 from the project root first.');
        process.exit(1);
      }
      logInfo(`Importing WSL distro '${distro}' from ${baseTar}...`);
      importDistro({
        name: distro,
        baseTarball: baseTar,
        installDir: defaultInstallDir(MINI_INFRA_HOME, profile),
      });
      logOk(`WSL distro '${distro}' imported`);
    } else {
      logInfo(`WSL distro '${distro}' already exists`);
    }
    if (!isDistroRunning(distro)) {
      logInfo(`Starting dockerd inside '${distro}' on tcp port ${dockerPort}...`);
    }
    startWslDocker({ name: distro, dockerPort });
    const ready = await ensureDockerReady(dockerPort, 60);
    if (!ready) {
      logError(`dockerd in '${distro}' did not become ready on port ${dockerPort} within 60s`);
      logError(`Check the daemon log: wsl -d ${distro} -- cat /var/log/mini-infra/dockerd.log`);
      process.exit(1);
    }
    logOk(`dockerd ready at tcp://localhost:${dockerPort}`);
    dockerHost = `tcp://localhost:${dockerPort}`;
  }

  const composeProjectName = `mini-infra-${profile}`;
  const agentSidecarImageTag = `localhost:${registryPort}/mini-infra-agent-sidecar:latest`;
  // EGRESS_SIDECAR_IMAGE_TAG is consumed by the egress-gateway stack template's `dockerImage` field;
  // the template specifies its own `dockerTag`, so this value must NOT include a `:tag` suffix.
  const egressSidecarImageTag = `localhost:${registryPort}/mini-infra-egress-sidecar`;
  const egressSidecarPushRef = `${egressSidecarImageTag}:latest`;

  const stackEnv: NodeJS.ProcessEnv = {
    DOCKER_HOST: dockerHost,
    COMPOSE_PROJECT_NAME: composeProjectName,
    UI_PORT: String(uiPort),
    REGISTRY_PORT: String(registryPort),
    AGENT_SIDECAR_IMAGE_TAG: agentSidecarImageTag,
    EGRESS_SIDECAR_IMAGE_TAG: egressSidecarImageTag,
    PROJECT_ROOT,
    PROFILE: profile,
  };

  // --reset
  if (args.reset) {
    logWarn(`⚠  WARNING: This will destroy ALL data for profile '${profile}' including:`);
    console.log('  - The database (users, settings, configuration)');
    console.log('  - All log files');
    console.log('  - Registry images');
    console.log('');
    const ok = await confirm('Are you sure? [y/N] ');
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
    logInfo(`Stopping containers and removing volumes for ${composeProjectName}...`);
    compose(['down', '-v'], stackEnv);
    logOk('Reset complete. Rebuilding...');
    console.log('');
  }

  // Registry first
  logInfo('Ensuring local Docker registry is running...');
  if (compose(['up', '-d', 'registry'], stackEnv) !== 0) {
    logError('Failed to start registry container');
    process.exit(1);
  }
  let ok = await waitForHttp(`http://localhost:${registryPort}/v2/`, 15, 'registry');
  if (!ok) {
    logError(`Local registry failed to become ready on port ${registryPort} after 15s`);
    compose(['logs', '--tail=30', 'registry'], stackEnv);
    process.exit(1);
  }
  logOk(`Local registry is ready at localhost:${registryPort}`);

  // Pre-pull alpine (stack reconciler uses it for ephemeral helpers)
  logInfo('Pre-pulling alpine:latest (used by stack reconciler for ephemeral helpers)...');
  const pull = exec('docker', ['pull', 'alpine:latest'], { env: stackEnv });
  if (pull.status !== 0) {
    logError('Failed to pull alpine:latest');
    process.stderr.write(pull.stderr);
    process.exit(1);
  }
  logOk('alpine:latest ready');

  // Build + push sidecar image
  logInfo('Building agent sidecar image...');
  const build = exec(
    'docker',
    [
      'build',
      '-t',
      agentSidecarImageTag,
      '-f',
      path.join(PROJECT_ROOT, 'agent-sidecar', 'Dockerfile'),
      PROJECT_ROOT,
    ],
    { env: stackEnv, stdio: 'inherit' },
  );
  if (build.status !== 0) {
    logError('Agent sidecar build failed');
    process.exit(1);
  }
  logInfo(`Pushing agent sidecar image to ${agentSidecarImageTag}...`);
  const push = exec('docker', ['push', agentSidecarImageTag], { env: stackEnv, stdio: 'inherit' });
  if (push.status !== 0) {
    logError('Agent sidecar push failed');
    process.exit(1);
  }
  logOk('Agent sidecar image pushed');

  // Build + push egress sidecar image
  logInfo('Building egress sidecar image...');
  const egressBuild = exec(
    'docker',
    [
      'build',
      '-t',
      egressSidecarPushRef,
      path.join(PROJECT_ROOT, 'egress-sidecar'),
    ],
    { env: stackEnv, stdio: 'inherit' },
  );
  if (egressBuild.status !== 0) {
    logError('Egress sidecar build failed');
    process.exit(1);
  }
  logInfo(`Pushing egress sidecar image to ${egressSidecarPushRef}...`);
  const egressPush = exec('docker', ['push', egressSidecarPushRef], { env: stackEnv, stdio: 'inherit' });
  if (egressPush.status !== 0) {
    logError('Egress sidecar push failed');
    process.exit(1);
  }
  logOk('Egress sidecar image pushed');

  // Capture extra networks joined at runtime (e.g. vault) so they survive rebuild
  const miniInfraContainer = `${composeProjectName}-mini-infra-1`;
  const extraNetworks: string[] = [];
  const inspect = exec('docker', ['inspect', miniInfraContainer], { env: stackEnv });
  if (inspect.status === 0) {
    const cfg = exec('docker', ['compose', '-f', COMPOSE_FILE, 'config', '--format', 'json'], {
      env: stackEnv,
    });
    const composeNetworks = new Set<string>();
    if (cfg.status === 0) {
      try {
        const parsed = JSON.parse(cfg.stdout) as {
          name?: string;
          services?: Record<string, { networks?: Record<string, unknown> }>;
        };
        const projectName = parsed.name || '';
        const nets = new Set<string>(['default']);
        for (const svc of Object.values(parsed.services || {})) {
          for (const netName of Object.keys(svc.networks || {})) {
            nets.add(netName);
          }
        }
        for (const n of nets) composeNetworks.add(`${projectName}_${n}`);
      } catch {
        // ignore — cfg parsing best-effort
      }
    }

    const currentRes = exec(
      'docker',
      [
        'inspect',
        miniInfraContainer,
        '--format',
        '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\\n"}}{{end}}',
      ],
      { env: stackEnv },
    );
    if (currentRes.status === 0) {
      for (const net of currentRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
        if (!composeNetworks.has(net)) extraNetworks.push(net);
      }
    }
    if (extraNetworks.length) {
      logInfo(`Will restore extra networks after rebuild: ${extraNetworks.join(' ')}`);
    }
  }

  // Build + start
  logInfo(`Building and starting Mini Infra (project=${composeProjectName})...`);
  if (compose(['up', '-d', '--build'], stackEnv) !== 0) {
    logError('docker compose up --build failed');
    process.exit(1);
  }

  // Restore extra networks
  if (extraNetworks.length) {
    logInfo(`Waiting for ${miniInfraContainer} to start before restoring networks...`);
    for (let i = 0; i < 30; i++) {
      const s = exec('docker', ['inspect', miniInfraContainer, '--format', '{{.State.Status}}'], {
        env: stackEnv,
      });
      if (s.status === 0 && s.stdout.trim() === 'running') break;
      await sleep(1000);
    }
    for (const net of extraNetworks) {
      const n = exec('docker', ['network', 'inspect', net], { env: stackEnv });
      if (n.status !== 0) {
        logWarn(`Skipping network ${net} (no longer exists)`);
        continue;
      }
      const c = exec('docker', ['network', 'connect', net, miniInfraContainer], { env: stackEnv });
      if (c.status === 0) {
        logOk(`Rejoined network: ${net}`);
      } else {
        logWarn(`Failed to rejoin network: ${net} (may already be connected)`);
      }
    }
  }

  // Health wait
  logInfo(`Waiting for Mini Infra to become healthy on port ${uiPort}...`);
  ok = await waitForHttp(`http://localhost:${uiPort}/health`, 60, 'Mini Infra');
  if (!ok) {
    logError('Mini Infra did not become healthy within 60s');
    logError('Last 100 lines of container logs:');
    compose(['logs', '--tail=100', 'mini-infra'], stackEnv);
    process.exit(1);
  }
  logOk('Mini Infra is healthy');

  // Seeder decision
  const detailsFile = path.join(PROJECT_ROOT, 'environment-details.xml');
  const alreadySeeded =
    fs.existsSync(detailsFile) && /<seeded>true<\/seeded>/.test(fs.readFileSync(detailsFile, 'utf8'));

  const minimalDetailsInput = {
    profile,
    projectRoot: PROJECT_ROOT,
    dockerHost,
    dockerSocket: dockerSockPath,
    composeProject: composeProjectName,
    uiPort,
    registryPort,
    vaultPort,
    agentSidecarImageTag,
    egressSidecarImageTag,
    shortDescription: shortDesc,
    longDescription: longDesc,
  };

  let seededThisRun = false;
  if (args.skipSeed) {
    logWarn('Skipping seed step (--skip-seed)');
    writeMinimalEnvironmentDetails(detailsFile, minimalDetailsInput);
  } else if (alreadySeeded && !args.forceSeed && !args.reset) {
    logInfo('Instance already seeded — skipping (pass --seed to re-run)');
  } else if (!fs.existsSync(DEV_ENV_FILE)) {
    logWarn(`Skipping seed step — ${DEV_ENV_FILE} not found`);
    logWarn(`Copy ${path.join(SCRIPT_DIR, 'dev.env.example')} to ${DEV_ENV_FILE} and fill in values.`);
    writeMinimalEnvironmentDetails(detailsFile, minimalDetailsInput);
  } else {
    logInfo('Running seeder...');
    try {
      const result = await seed({
        uiPort,
        registryPort,
        vaultPort,
        haproxyHttpPort,
        haproxyHttpsPort,
        haproxyStatsPort,
        haproxyDataplanePort,
        profile,
        projectRoot: PROJECT_ROOT,
        dockerHost,
        composeProject: composeProjectName,
        agentSidecarImageTag,
        egressSidecarImageTag,
        devEnvPath: DEV_ENV_FILE,
        detailsFile,
        shortDescription: shortDesc,
        longDescription: longDesc,
      });
      upsertEntry({
        profile,
        worktree_path: PROJECT_ROOT,
        colima_vm: driver === 'wsl' ? distroName(profile) : profile,
        ui_port: uiPort,
        registry_port: registryPort,
        vault_port: vaultPort,
        docker_port: dockerPort,
        haproxy_http_port: haproxyHttpPort,
        haproxy_https_port: haproxyHttpsPort,
        haproxy_stats_port: haproxyStatsPort,
        haproxy_dataplane_port: haproxyDataplanePort,
        url: `http://localhost:${uiPort}`,
        admin_email: result.adminEmail,
        admin_password: result.adminPassword,
        api_key: result.apiKey,
        description: shortDesc,
        seeded: true,
      });
      logOk('Updated central registry (~/.mini-infra/worktrees.yaml) with admin credentials');
      seededThisRun = true;
    } catch (err) {
      logError(`Seeder failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  // For already-seeded re-runs, copy creds from the existing XML into the
  // central registry (the YAML might be stale if it was wiped while the XML
  // survives). Skip-seed / no-dev-env paths leave creds blank.
  if (!seededThisRun) {
    const details = readEnvironmentDetails(detailsFile);
    upsertEntry({
      profile,
      worktree_path: PROJECT_ROOT,
      colima_vm: driver === 'wsl' ? distroName(profile) : profile,
      ui_port: uiPort,
      registry_port: registryPort,
      vault_port: vaultPort,
      docker_port: dockerPort,
      haproxy_http_port: haproxyHttpPort,
      haproxy_https_port: haproxyHttpsPort,
      haproxy_stats_port: haproxyStatsPort,
      haproxy_dataplane_port: haproxyDataplanePort,
      url: `http://localhost:${uiPort}`,
      seeded: details?.seeded ?? false,
      admin_email: details?.admin.email,
      admin_password: details?.admin.password,
      api_key: details?.admin.apiKey,
      description: shortDesc,
    });

    // Server restarts re-lock the operator passphrase; re-unlock here so admin
    // operations (publish policy, mint AppRole secret-id) keep working without
    // a manual visit to /vault. Only attempt if we have an API key from a
    // prior seed.
    if (details?.admin.apiKey) {
      const api = new ApiClient(`http://localhost:${uiPort}`, details.admin.apiKey);
      try {
        await ensureVaultUnlocked(api);
      } catch (err) {
        logWarn(
          `Vault unlock attempt failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  console.log('');
  logOk(`Mini Infra dev instance for '${profile}' is up`);
  console.log('');
  console.log(`  URL:         http://localhost:${uiPort}`);
  console.log(`  Registry:    localhost:${registryPort}`);
  console.log(`  Vault:       http://localhost:${vaultPort}`);
  console.log(`  HAProxy:     http://localhost:${haproxyHttpPort}  (https=${haproxyHttpsPort}, stats=${haproxyStatsPort}, dataplane=${haproxyDataplanePort})`);
  console.log(`  DOCKER_HOST: ${dockerHost}`);
  console.log('');
  console.log(`  Logs:   DOCKER_HOST=${dockerHost} docker compose -f ${COMPOSE_FILE} -p ${composeProjectName} logs -f`);
  console.log(`  Stop:   DOCKER_HOST=${dockerHost} docker compose -f ${COMPOSE_FILE} -p ${composeProjectName} down`);
  const startWrapper = process.platform === 'win32' ? 'worktree_start.cmd' : 'worktree_start.sh';
  const listWrapper = process.platform === 'win32' ? 'worktree_list.cmd' : 'worktree_list.sh';
  console.log(`  Re-seed: ${path.join(SCRIPT_DIR, startWrapper)} --seed --profile ${profile}`);
  console.log(`  Nuke:    ${path.join(SCRIPT_DIR, startWrapper)} --reset --profile ${profile}`);
  console.log(`  List all: ${path.join(SCRIPT_DIR, listWrapper)}`);
  console.log('');
}

main().catch((err) => {
  logError(err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
