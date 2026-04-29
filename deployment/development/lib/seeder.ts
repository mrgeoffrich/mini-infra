// Mini Infra worktree seeder — TypeScript port of worktree_seed.sh.
//
// Drives the running app via its REST API to skip onboarding:
//   1. Create the first admin user via POST /auth/setup
//   2. Exchange admin credentials for a full-admin API key via
//      POST /api/dev/issue-api-key (requires ENABLE_DEV_API_KEY_ENDPOINT=true)
//   3. Complete the setup wizard (docker host) via POST /auth/setup/complete
//   3b. Upsert docker_host_ip system setting (needed for application DNS)
//   4. Upsert Azure / Cloudflare / GitHub credentials
//   5. Create a local environment
//   6. Instantiate + apply the built-in HAProxy stack template
//   7. Mark onboarding complete
//   8. Write environment-details.xml at the project root.
//
// Each step is idempotent-ish: already-configured state is skipped, but the
// seeder does not back out partial state on failure — fix the env file and re-run.

import * as dgram from 'node:dgram';
import { ApiClient, pickItems, pickObject, type ApiResponse } from './api.js';
import { loadDevEnv, type DevEnv } from './dev-env.js';
import {
  writeFullEnvironmentDetails,
  type LocalEnvironmentSummary,
  type StackSummary,
} from './env-details.js';
import { logInfo, logOk, logError, logSkip } from './log.js';

export interface SeederInput {
  uiPort: number;
  registryPort: number;
  vaultPort: number;
  // Per-worktree HAProxy host ports — passed as parameterValues to the
  // haproxy stack template so two worktrees (or any other process binding
  // 80/443) don't collide.
  haproxyHttpPort: number;
  haproxyHttpsPort: number;
  haproxyStatsPort: number;
  haproxyDataplanePort: number;
  profile: string;
  projectRoot: string;
  dockerHost: string;
  composeProject: string;
  agentSidecarImageTag: string;
  // /22 slice of 172.30.0.0/16 allocated for this worktree's slot.
  egressPoolCidr: string;
  devEnvPath: string;
  detailsFile: string;
  shortDescription?: string;
  longDescription?: string;
}

export interface SeederOutput {
  adminEmail: string;
  adminPassword: string;
  apiKey: string;
  localEnvId?: string;
  haproxyStackId?: string;
}

interface SetupStatus {
  setupComplete?: boolean;
  hasUsers?: boolean;
}

interface ApiKeyResponse {
  apiKey?: string;
}

interface Environment {
  id?: string;
  name?: string;
  type?: string;
  networkType?: string;
}

interface Stack {
  id?: string;
  name?: string;
  status?: string;
  lastAppliedAt?: string;
}

interface Template {
  id?: string;
  name?: string;
}

interface SystemSetting {
  id?: string;
  category?: string;
  key?: string;
  value?: string;
}

const HEALTH_PATH = '/health';
const SEED_DEBUG = process.env.SEED_DEBUG === '1';

// Fixed passphrase used for the dev-only managed Vault. Persisted to
// environment-details.xml so re-runs of this seeder (and skills like
// diagnose-dev) can call /api/vault/passphrase/unlock after a server restart
// without operator intervention. NOT for production use.
export const DEV_VAULT_PASSPHRASE = 'UnWrapMiniInfra100';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debug(msg: string): void {
  if (SEED_DEBUG) console.log(`  [seed debug] ${msg}`);
}

async function waitForHealthy(baseUrl: string, maxSeconds: number, label: string): Promise<void> {
  logInfo(`Waiting for ${label} to become healthy (up to ${maxSeconds}s)...`);
  for (let i = 1; i <= maxSeconds; i++) {
    try {
      const res = await fetch(`${baseUrl}${HEALTH_PATH}`);
      if (res.ok) {
        logOk(`${label} is healthy`);
        return;
      }
    } catch {
      // swallow — expected during startup
    }
    debug(`health check ${i}/${maxSeconds} failed`);
    await sleep(1000);
  }
  throw new Error(`${label} did not become healthy within ${maxSeconds}s`);
}

async function detectDockerHostIp(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ip: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(ip);
    };

    let socket: dgram.Socket;
    try {
      socket = dgram.createSocket('udp4');
    } catch {
      resolve(null);
      return;
    }
    socket.once('error', () => finish(null));
    const timer = setTimeout(() => finish(null), 2000);

    socket.connect(80, '8.8.8.8', () => {
      clearTimeout(timer);
      try {
        const addr = socket.address().address;
        finish(addr || null);
      } catch {
        finish(null);
      }
    });
  });
}

function assertStatus(res: ApiResponse<unknown>, expected: number[], label: string): void {
  if (!expected.includes(res.status)) {
    throw new Error(`${label} returned ${res.status}: ${res.bodyText}`);
  }
}

async function getSetupStatus(api: ApiClient): Promise<SetupStatus> {
  const res = await api.get<SetupStatus>('/auth/setup-status');
  assertStatus(res, [200], 'setup-status');
  return res.body || {};
}

async function ensureAdminUser(api: ApiClient, env: DevEnv): Promise<SetupStatus> {
  logInfo('Checking setup status');
  const status = await getSetupStatus(api);
  if (status.hasUsers) {
    logSkip('Admin user already exists');
    return status;
  }
  logInfo(`Creating admin user ${env.ADMIN_EMAIL}`);
  const res = await api.post('/auth/setup', {
    email: env.ADMIN_EMAIL,
    displayName: env.ADMIN_DISPLAY_NAME,
    password: env.ADMIN_PASSWORD,
  });
  assertStatus(res, [201], 'POST /auth/setup');
  logOk('Admin user created');
  return status;
}

async function issueApiKey(api: ApiClient, env: DevEnv): Promise<string> {
  logInfo('Issuing dev API key');
  const res = await api.post<ApiKeyResponse>('/api/dev/issue-api-key', {
    email: env.ADMIN_EMAIL,
    password: env.ADMIN_PASSWORD,
    name: 'worktree-seeder',
  });
  if (res.status !== 201) {
    logError(`issue-api-key returned ${res.status}: ${res.bodyText}`);
    logError('Is ENABLE_DEV_API_KEY_ENDPOINT=true set on the container?');
    throw new Error(`issue-api-key failed with status ${res.status}`);
  }
  const apiKey = res.body?.apiKey;
  if (!apiKey) {
    throw new Error(`issue-api-key response missing apiKey field: ${res.bodyText}`);
  }
  logOk('API key obtained');
  return apiKey;
}

async function completeSetupWizardIfNeeded(
  api: ApiClient,
  baseUrl: string,
  setupComplete: boolean,
): Promise<void> {
  if (setupComplete) {
    logSkip('Setup wizard already completed');
    return;
  }
  logInfo('Completing setup wizard');
  const res = await api.post('/auth/setup/complete', {
    dockerHost: 'unix:///var/run/docker.sock',
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`setup/complete returned ${res.status}: ${res.bodyText}`);
  }
  logOk('Setup wizard completed');
  // Server restarts after setup/complete to apply Docker host config.
  await waitForHealthy(baseUrl, 30, 'app after setup');
}

async function ensureDockerHostIp(api: ApiClient, env: DevEnv): Promise<void> {
  logInfo('Setting Docker host IP');
  let ip = env.DOCKER_HOST_IP || '';
  if (!ip) {
    const detected = await detectDockerHostIp();
    if (detected) ip = detected;
  }
  if (!ip) {
    logSkip(
      'Could not detect Docker host IP — set DOCKER_HOST_IP in dev.env to enable application DNS records',
    );
    return;
  }

  const listRes = await api.get<unknown>(
    '/api/settings?category=system&key=docker_host_ip&isActive=true',
  );
  let existingId = '';
  let existingValue = '';
  if (listRes.status === 200) {
    const items = pickItems<SystemSetting>(listRes.body);
    const match = items.find((s) => s.category === 'system' && s.key === 'docker_host_ip');
    if (match) {
      existingId = match.id || '';
      existingValue = match.value || '';
    }
  }

  if (existingId && existingValue === ip) {
    logSkip(`Docker host IP already set (${ip})`);
    return;
  }
  if (existingId) {
    const res = await api.put(`/api/settings/${existingId}`, { value: ip });
    if (res.status === 200) {
      logOk(`Docker host IP updated (${ip})`);
    } else {
      logSkip(`Docker host IP update returned ${res.status} (non-fatal): ${res.bodyText}`);
    }
    return;
  }
  const res = await api.post('/api/settings', {
    category: 'system',
    key: 'docker_host_ip',
    value: ip,
    isEncrypted: false,
  });
  if (res.status === 200 || res.status === 201) {
    logOk(`Docker host IP set (${ip})`);
  } else {
    logSkip(`Docker host IP create returned ${res.status} (non-fatal): ${res.bodyText}`);
  }
}

async function configureAzure(api: ApiClient, connectionString: string): Promise<void> {
  logInfo('Configuring Azure Storage');
  const put = await api.put('/api/settings/azure', { connectionString });
  if (put.status !== 200 && put.status !== 201) {
    logError(`Azure PUT returned ${put.status}: ${put.bodyText}`);
    return;
  }
  logOk('Azure configured');
  logInfo('Validating Azure connectivity');
  const val = await api.post('/api/settings/validate/azure', {});
  if (val.status === 200 || val.status === 201) {
    logOk('Azure connectivity verified');
  } else {
    logSkip(`Azure validation returned ${val.status} (non-fatal): ${val.bodyText}`);
  }
}

async function configureCloudflare(
  api: ApiClient,
  apiToken: string,
  accountId: string,
): Promise<void> {
  logInfo('Configuring Cloudflare');
  const post = await api.post('/api/settings/cloudflare', {
    api_token: apiToken,
    account_id: accountId,
  });
  if (post.status !== 200 && post.status !== 201) {
    logError(`Cloudflare POST returned ${post.status}: ${post.bodyText}`);
    return;
  }
  logOk('Cloudflare configured');
  logInfo('Validating Cloudflare connectivity');
  const val = await api.post('/api/settings/validate/cloudflare', {});
  if (val.status === 200 || val.status === 201) {
    logOk('Cloudflare connectivity verified');
  } else {
    logSkip(`Cloudflare validation returned ${val.status} (non-fatal): ${val.bodyText}`);
  }
}

async function configureGithub(api: ApiClient, token: string): Promise<void> {
  logInfo('Configuring GitHub');
  const put = await api.put('/api/settings/github', { token });
  if (put.status !== 200 && put.status !== 201) {
    // GitHub settings route shape may differ; surface and continue.
    logSkip(
      `GitHub PUT returned ${put.status} (likely a payload-shape mismatch): ${put.bodyText}`,
    );
    return;
  }
  logOk('GitHub configured');
  logInfo('Validating GitHub connectivity');
  const val = await api.post('/api/settings/validate/github-app', {});
  if (val.status === 200 || val.status === 201) {
    logOk('GitHub connectivity verified');
  } else {
    logSkip(`GitHub validation returned ${val.status} (non-fatal): ${val.bodyText}`);
  }
}

async function configureServices(api: ApiClient, env: DevEnv): Promise<void> {
  if (env.AZURE_STORAGE_CONNECTION_STRING) {
    await configureAzure(api, env.AZURE_STORAGE_CONNECTION_STRING);
  } else {
    logSkip('AZURE_STORAGE_CONNECTION_STRING not set — skipping');
  }
  if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
    await configureCloudflare(api, env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID);
  } else {
    logSkip('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set — skipping');
  }
  if (env.GITHUB_TOKEN) {
    await configureGithub(api, env.GITHUB_TOKEN);
  } else {
    logSkip('GITHUB_TOKEN not set — skipping');
  }
}

async function findLocalEnvironment(api: ApiClient): Promise<Environment | null> {
  const list = await api.get<unknown>('/api/environments');
  if (list.status !== 200) {
    debug(`GET /api/environments → status=${list.status} body=${list.bodyText.slice(0, 200)}`);
    return null;
  }
  const items = pickItems<Environment>(list.body);
  const existing = items.find((e) => e.networkType === 'local');
  if (!existing) {
    debug(
      `GET /api/environments → 200, ${items.length} item(s), none with networkType=local; body=${list.bodyText.slice(0, 200)}`,
    );
    return null;
  }
  return existing;
}

async function ensureLocalEnvironment(api: ApiClient, env: DevEnv): Promise<string> {
  logInfo('Creating local environment');
  const existing = await findLocalEnvironment(api);
  if (existing?.id) {
    logSkip(`Local environment already exists (id=${existing.id})`);
    return existing.id;
  }
  const res = await api.post<Environment>('/api/environments', {
    name: env.LOCAL_ENV_NAME,
    description: 'Dev local environment (seeded)',
    type: 'nonproduction',
    networkType: 'local',
  });
  if (res.status === 409) {
    // Another caller (or a previous fetch retry that succeeded server-side after
    // its connection dropped — egress provisioning can stretch the request past
    // undici's headersTimeout) already created the local env. Re-list and adopt it.
    debug(`POST /api/environments → 409: ${res.bodyText.slice(0, 200)}`);
    const recovered = await findLocalEnvironment(api);
    if (recovered?.id) {
      logSkip(`Local environment was created concurrently — adopting (id=${recovered.id})`);
      return recovered.id;
    }
    throw new Error(
      `POST /api/environments returned 409 but no local environment found on re-list: ${res.bodyText}`,
    );
  }
  if (res.status !== 201) {
    throw new Error(`POST /api/environments returned ${res.status}: ${res.bodyText}`);
  }
  const created = pickObject<Environment>(res.body);
  const id = created?.id || '';
  if (!id) {
    throw new Error(`POST /api/environments response missing id: ${res.bodyText}`);
  }
  logOk(`Local environment created (id=${id})`);
  return id;
}

async function findTemplate(
  api: ApiClient,
  needle: string,
  opts: { exact?: boolean } = {},
): Promise<string | null> {
  const res = await api.get<unknown>('/api/stack-templates');
  if (res.status !== 200) return null;
  const items = pickItems<Template>(res.body);
  const lower = needle.toLowerCase();
  const match = items.find((t) => {
    const name = (t.name || '').toLowerCase();
    return opts.exact ? name === lower : name.includes(lower);
  });
  return match?.id || null;
}

interface HaproxyPorts {
  http: number;
  https: number;
  stats: number;
  dataplane: number;
}

async function ensureHaproxyStack(
  api: ApiClient,
  envId: string,
  ports: HaproxyPorts,
): Promise<string | null> {
  const stackName = 'haproxy-local';
  logInfo(`Looking for existing ${stackName} stack in local env`);
  const list = await api.get<unknown>(`/api/stacks?environmentId=${envId}`);
  if (list.status === 200) {
    const items = pickItems<Stack>(list.body);
    const existing = items.find((s) => s.name === stackName);
    if (existing?.id) {
      logSkip(`HAProxy stack already exists (id=${existing.id})`);
      return existing.id;
    }
  }
  logInfo('Locating HAProxy stack template');
  const templateId = await findTemplate(api, 'haproxy');
  if (!templateId) {
    logSkip('HAProxy template not found — skipping HAProxy setup');
    return null;
  }
  // Override host-ports per worktree. Defaults are 80/443/8404/5555 which
  // collide between worktrees and lose to anything else on the box already
  // binding those (Docker Desktop on Windows, an existing HTTP server on
  // macOS). Slot-aligned with the rest of the per-worktree port assignment.
  const res = await api.post<unknown>(
    `/api/stack-templates/${templateId}/instantiate`,
    {
      environmentId: envId,
      name: stackName,
      parameterValues: {
        'http-port': ports.http,
        'https-port': ports.https,
        'stats-port': ports.stats,
        'dataplane-port': ports.dataplane,
      },
    },
  );
  if (res.status !== 201) {
    logError(`HAProxy instantiate returned ${res.status}: ${res.bodyText}`);
    return null;
  }
  const created = pickObject<Stack>(res.body);
  const id = created?.id || '';
  if (!id) {
    logError(`HAProxy instantiate response missing id: ${res.bodyText}`);
    return null;
  }
  logOk(
    `HAProxy stack created (id=${id}, ports: http=${ports.http} https=${ports.https} stats=${ports.stats} dataplane=${ports.dataplane})`,
  );
  return id;
}

async function applyAndWaitForSynced(
  api: ApiClient,
  stackId: string,
  label: string,
): Promise<void> {
  // Snapshot pre-apply status + lastAppliedAt. The status field may still read
  // "error" (or whatever) from a prior run until the reconciler finishes this
  // one, so lastAppliedAt is the authoritative "reconciler completed a new run"
  // signal.
  let prevStatus = '';
  let prevLastAppliedAt = '';
  const pre = await api.get<unknown>(`/api/stacks/${stackId}`);
  if (pre.status === 200) {
    const s = pickObject<Stack>(pre.body);
    prevStatus = s?.status || '';
    prevLastAppliedAt = s?.lastAppliedAt || '';
  }

  if (prevStatus.toLowerCase() === 'synced') {
    logSkip(`${label} stack is already Synced — skipping apply`);
    return;
  }

  logInfo(`Applying ${label} stack (current status: ${prevStatus || 'unknown'})`);
  const applyRes = await api.post(`/api/stacks/${stackId}/apply`, {});
  if (applyRes.status !== 200 && applyRes.status !== 202) {
    logError(`Apply returned ${applyRes.status}: ${applyRes.bodyText}`);
    return;
  }

  logInfo('Apply started — polling for completion (timeout 120s)');
  let lastStatus = '';
  for (let i = 1; i <= 40; i++) {
    await sleep(3000);
    const res = await api.get<unknown>(`/api/stacks/${stackId}`);
    if (res.status !== 200) continue;
    const s = pickObject<Stack>(res.body);
    const polledStatus = s?.status || '';
    const polledLastApplied = s?.lastAppliedAt || '';
    // Only treat a terminal status as meaningful once lastAppliedAt has advanced.
    if (polledLastApplied === prevLastAppliedAt) continue;
    lastStatus = polledStatus;
    const lower = polledStatus.toLowerCase();
    if (lower === 'synced') {
      logOk(`${label} stack is Synced`);
      return;
    }
    if (lower === 'error') {
      logError(`${label} stack apply failed (status=error)`);
      return;
    }
  }
  logSkip(`Timed out waiting for ${label} to sync (last status: ${lastStatus || 'unknown'})`);
}

async function ensureVaultStack(api: ApiClient, vaultPort: number): Promise<string | null> {
  const stackName = 'vault';
  logInfo(`Looking for existing ${stackName} host stack`);
  // Vault is host-scoped — no environmentId filter, but the listing returns
  // all stacks the caller can see, so we still match by name.
  const list = await api.get<unknown>('/api/stacks');
  if (list.status === 200) {
    const items = pickItems<Stack>(list.body);
    const existing = items.find((s) => s.name === stackName);
    if (existing?.id) {
      logSkip(`Vault stack already exists (id=${existing.id})`);
      return existing.id;
    }
  }
  logInfo('Locating Vault stack template');
  // Exact-name match: there's also a `hello-vault` template in the catalog
  // which is environment-scoped, so a substring match would land on the wrong
  // one and reject our host-scoped instantiate.
  const templateId = await findTemplate(api, 'vault', { exact: true });
  if (!templateId) {
    logSkip('Vault template not found — skipping Vault setup');
    return null;
  }
  // Host-scoped instantiate: no environmentId. Override host-port so each
  // worktree's Vault binds a unique macOS host port — the colima VMs all
  // publish on their VM's :8200 internally, but only one wins host:8200 via
  // colima's port forwarder, so distinct host ports are essential.
  const res = await api.post<unknown>(
    `/api/stack-templates/${templateId}/instantiate`,
    { name: stackName, parameterValues: { 'host-port': vaultPort } },
  );
  if (res.status !== 201) {
    logError(`Vault instantiate returned ${res.status}: ${res.bodyText}`);
    return null;
  }
  const created = pickObject<Stack>(res.body);
  const id = created?.id || '';
  if (!id) {
    logError(`Vault instantiate response missing id: ${res.bodyText}`);
    return null;
  }
  logOk(`Vault stack created (id=${id})`);
  return id;
}

interface VaultStatusResponse {
  initialised?: boolean;
  bootstrappedAt?: string | null;
  reachable?: boolean;
  address?: string | null;
  stackId?: string | null;
  passphrase?: { state?: 'uninitialised' | 'locked' | 'unlocked' };
}

/**
 * Bootstrap-or-unlock the managed Vault using the dev passphrase. Idempotent:
 * - already unlocked → skip
 * - locked          → POST /api/vault/passphrase/unlock
 * - uninitialised   → POST /api/vault/bootstrap (requires address + stackId
 *                     populated by the post-install action of a vault stack apply)
 * - unreachable     → log skip
 *
 * Always returns. Failures are logged but non-fatal so a partly-broken Vault
 * never breaks the rest of the dev environment.
 */
export async function ensureVaultUnlocked(api: ApiClient): Promise<void> {
  // Refresh status — the server reads VaultState and probes the address.
  const statusRes = await api.get<{ data?: VaultStatusResponse } | VaultStatusResponse>(
    '/api/vault/status',
  );
  if (statusRes.status !== 200) {
    logSkip(`Vault status returned ${statusRes.status} — skipping unlock`);
    return;
  }
  const body = statusRes.body as { data?: VaultStatusResponse } | VaultStatusResponse | null;
  const status = (body && 'data' in body && body.data ? body.data : body) as
    | VaultStatusResponse
    | null;
  if (!status) {
    logSkip('Vault status response missing body — skipping unlock');
    return;
  }
  if (!status.reachable) {
    logSkip('Vault unreachable — skipping unlock (deploy the vault stack first)');
    return;
  }
  const passphraseState = status.passphrase?.state ?? 'uninitialised';

  if (passphraseState === 'unlocked') {
    logSkip('Vault passphrase already unlocked');
    return;
  }

  if (passphraseState === 'locked') {
    logInfo('Unlocking Vault passphrase');
    const res = await api.post('/api/vault/passphrase/unlock', {
      passphrase: DEV_VAULT_PASSPHRASE,
    });
    if (res.status === 200 || res.status === 201) {
      logOk('Vault passphrase unlocked');
    } else {
      logError(
        `Vault unlock returned ${res.status}: ${res.bodyText} (passphrase mismatch? wipe colima VM to reset)`,
      );
    }
    return;
  }

  // passphraseState === 'uninitialised' → bootstrap.
  if (!status.address || !status.stackId) {
    logSkip(
      'Vault is reachable but address/stackId missing — re-apply the vault stack so register-vault-address runs',
    );
    return;
  }
  logInfo('Bootstrapping Vault (one-time)');
  const res = await api.post('/api/vault/bootstrap', {
    passphrase: DEV_VAULT_PASSPHRASE,
    address: status.address,
    stackId: status.stackId,
  });
  if (res.status === 200 || res.status === 201) {
    logOk('Vault bootstrapped');
  } else {
    logError(`Vault bootstrap returned ${res.status}: ${res.bodyText}`);
  }
}

interface VaultPolicySummary {
  id?: string;
  name?: string;
  publishedVersion?: number;
}

/**
 * Publish the two system Vault policies (`mini-infra-admin` and
 * `mini-infra-operator`) so the DB tracks them as published. The bootstrap
 * flow already writes the HCL to Vault directly, but leaves the DB rows in
 * draft state — without this step they show as unpublished in the UI on a
 * fresh dev environment. Idempotent: skips policies already at version >= 1.
 */
async function publishSystemVaultPolicies(api: ApiClient): Promise<void> {
  const SYSTEM_POLICY_NAMES = ['mini-infra-admin', 'mini-infra-operator'];

  const res = await api.get<unknown>('/api/vault/policies');
  if (res.status !== 200) {
    logSkip(`Vault policies list returned ${res.status} — skipping system policy publish`);
    return;
  }
  const policies = pickItems<VaultPolicySummary>(res.body);

  for (const name of SYSTEM_POLICY_NAMES) {
    const policy = policies.find((p) => p.name === name);
    if (!policy?.id) {
      logSkip(`System Vault policy '${name}' not found — skipping publish`);
      continue;
    }
    if ((policy.publishedVersion ?? 0) > 0) {
      logSkip(`Vault policy '${name}' already published (v${policy.publishedVersion})`);
      continue;
    }
    logInfo(`Publishing Vault policy '${name}'`);
    const publishRes = await api.post(`/api/vault/policies/${policy.id}/publish`);
    if (publishRes.status === 200 || publishRes.status === 201) {
      logOk(`Vault policy '${name}' published`);
    } else {
      logError(
        `Publishing Vault policy '${name}' returned ${publishRes.status}: ${publishRes.bodyText}`,
      );
    }
  }
}

async function markOnboardingComplete(api: ApiClient): Promise<void> {
  logInfo('Marking onboarding complete');
  const res = await api.post('/api/onboarding/complete', {});
  if (res.status === 200 || res.status === 201 || res.status === 204) {
    logOk('Onboarding marked complete');
  } else {
    logSkip(`onboarding/complete returned ${res.status} (may already be complete): ${res.bodyText}`);
  }
}

async function fetchEnvironmentSummary(
  api: ApiClient,
  envId: string,
): Promise<LocalEnvironmentSummary | null> {
  const res = await api.get<unknown>('/api/environments');
  if (res.status !== 200) return null;
  const items = pickItems<Environment>(res.body);
  const match = items.find((e) => e.id === envId);
  if (!match) return null;
  return {
    id: match.id,
    name: match.name,
    type: match.type,
    networkType: match.networkType,
  };
}

async function fetchStackSummaries(api: ApiClient, envId: string): Promise<StackSummary[]> {
  const res = await api.get<unknown>(`/api/stacks?environmentId=${envId}`);
  if (res.status !== 200) return [];
  const items = pickItems<Stack>(res.body);
  return items.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    lastAppliedAt: s.lastAppliedAt,
  }));
}

export async function seed(input: SeederInput): Promise<SeederOutput> {
  const env = loadDevEnv(input.devEnvPath);
  const baseUrl = `http://localhost:${input.uiPort}`;
  const api = new ApiClient(baseUrl);

  const setupStatus = await ensureAdminUser(api, env);
  const apiKey = await issueApiKey(api, env);
  api.setApiKey(apiKey);

  await completeSetupWizardIfNeeded(api, baseUrl, setupStatus.setupComplete === true);
  await ensureDockerHostIp(api, env);
  await configureServices(api, env);

  const localEnvId = await ensureLocalEnvironment(api, env);
  const haproxyStackId = await ensureHaproxyStack(api, localEnvId, {
    http: input.haproxyHttpPort,
    https: input.haproxyHttpsPort,
    stats: input.haproxyStatsPort,
    dataplane: input.haproxyDataplanePort,
  });
  if (haproxyStackId) {
    await applyAndWaitForSynced(api, haproxyStackId, 'HAProxy');
  }
  const vaultStackId = await ensureVaultStack(api, input.vaultPort);
  if (vaultStackId) {
    await applyAndWaitForSynced(api, vaultStackId, 'Vault');
  }
  await ensureVaultUnlocked(api);
  await publishSystemVaultPolicies(api);
  await markOnboardingComplete(api);

  logInfo(`Writing ${input.detailsFile}`);
  const localEnvironment = await fetchEnvironmentSummary(api, localEnvId);
  const stacks = await fetchStackSummaries(api, localEnvId);
  writeFullEnvironmentDetails(input.detailsFile, {
    profile: input.profile,
    projectRoot: input.projectRoot,
    dockerHost: input.dockerHost,
    composeProject: input.composeProject,
    uiPort: input.uiPort,
    registryPort: input.registryPort,
    vaultPort: input.vaultPort,
    egressPool: input.egressPoolCidr,
    agentSidecarImageTag: input.agentSidecarImageTag,
    adminEmail: env.ADMIN_EMAIL,
    adminPassword: env.ADMIN_PASSWORD,
    apiKey,
    vaultPassphrase: DEV_VAULT_PASSPHRASE,
    azureConfigured: Boolean(env.AZURE_STORAGE_CONNECTION_STRING),
    cloudflareConfigured: Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID),
    githubConfigured: Boolean(env.GITHUB_TOKEN),
    localEnvironment,
    stacks,
    shortDescription: input.shortDescription,
    longDescription: input.longDescription,
  });
  logOk(`Wrote ${input.detailsFile}`);

  console.log('');
  logOk('Seeder finished');

  return {
    adminEmail: env.ADMIN_EMAIL,
    adminPassword: env.ADMIN_PASSWORD,
    apiKey,
    localEnvId,
    haproxyStackId: haproxyStackId ?? undefined,
  };
}
