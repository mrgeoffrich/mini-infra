# CRIT-03: Per-Environment HAProxy DataPlane API Credentials

**Security Finding:** CRIT-03 from `docs/security-review.md`
**Date:** 2026-02-24
**Status:** Planned

---

## Problem

The HAProxy DataPlane API credentials are hardcoded as `admin` / `adminpwd` in three places:

| Location | What it does |
|----------|-------------|
| `server/docker-compose/haproxy/haproxy.cfg:31-32` | `userlist dataplaneapi` — the HAProxy-side user definition |
| `server/docker-compose/haproxy/dataplaneapi.yml:11-14` | DataPlane API config — login credentials |
| `server/src/services/haproxy/haproxy-dataplane-client.ts:137-138` | Client-side — credentials used to authenticate API calls |

Every HAProxy instance uses the same credentials. Anyone with network access to port 5555/5556 can control the load balancer.

---

## Solution

Generate unique random credentials per environment when the HAProxy service is created. Store them in the `EnvironmentService.config` JSON field. Template them into the config files at container start time. Pass them to the client when connecting.

**Migration:** Users can stop an environment, remove the HAProxy service, re-add it, and restart. The new service will get fresh random credentials and new config files written to the volume.

---

## Design

### Credential Format

- **Username:** `dp_<8 random alphanumeric chars>` (e.g., `dp_k7Xm9pQ2`)
- **Password:** 32 random characters from the set `[A-Za-z0-9\-\_\~\.]`
- Generated via `crypto.randomBytes()` mapped to the allowed charset
- **Why this charset:** Safe for HTTP Basic Auth (no `:`), safe in HAProxy config (no spaces or special quoting issues), safe in YAML (no `#`, `{`, `}`, or leading `*`/`&`)

### Storage

Stored in the existing `EnvironmentService.config` JSON field (`environment_services` table):

```json
{
  "dataplaneUsername": "dp_k7Xm9pQ2",
  "dataplanePassword": "aB3x-Km9_pQ2w.Yz7Nf8Hj4Ls6Rt0Uv1X"
}
```

**Note:** This field is unencrypted JSON in SQLite. This is the same risk level as the current hardcoded values (any process with DB file access can read them). Encrypting this field is tracked separately under HIGH-05/HIGH-07 and should not block this fix.

### Credential Lookup

The `EnvironmentService` record is discoverable from any HAProxy container via:
1. Container labels include `mini-infra.environment: {environmentId}`
2. Query `environment_services` WHERE `environmentId` = X AND `serviceType` = `'haproxy'`
3. Read `config` JSON field

---

## Implementation Steps

### Step 1: Create credential generation utility

**New file:** `server/src/services/haproxy/haproxy-credential-generator.ts`

```typescript
import crypto from 'crypto';

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~';

export function generateDataPlaneCredentials(): { username: string; password: string } {
  const usernameSuffix = generateRandomString(8);
  const password = generateRandomString(32);
  return {
    username: `dp_${usernameSuffix}`,
    password
  };
}

function generateRandomString(length: number): string {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes)
    .map(b => CHARSET[b % CHARSET.length])
    .join('');
}
```

### Step 2: Generate and store credentials on service creation

**File:** `server/src/services/environment/environment-manager.ts`
**Method:** `addServiceToEnvironment()` (line 879)

When `serviceType === 'haproxy'`, generate credentials and merge them into the `config` field before writing to the database:

```typescript
if (serviceConfig.serviceType === 'haproxy') {
  const { generateDataPlaneCredentials } = await import('../haproxy/haproxy-credential-generator');
  const credentials = generateDataPlaneCredentials();
  serviceConfig.config = {
    ...serviceConfig.config,
    dataplaneUsername: credentials.username,
    dataplanePassword: credentials.password,
  };
}
```

This runs at line ~940, before the `prisma.environmentService.create()` call.

### Step 3: Pass credentials through to HAProxyService

**File:** `server/src/services/application-service-factory.ts`
**Method:** `instantiateService()` (line 130)

The `config` object is already available here but not passed to the HAProxy constructor. Update:

```typescript
case 'haproxy':
  return new implementation(projectName || serviceName, environmentId, config);
```

**File:** `server/src/services/haproxy/haproxy-service.ts`
**Constructor** (line 97)

Add `config` parameter:

```typescript
constructor(
  projectName: string = 'haproxy',
  private environmentId?: string,
  private config: Record<string, any> = {}
) {
  // ... existing init
}
```

### Step 4: Template credentials into config files

**File:** `server/src/services/haproxy/haproxy-service.ts`
**Method:** `writeConfigsToVolume()` (line 255)

After reading the template files (line 261-267), replace the hardcoded credentials before escaping:

```typescript
// Get credentials from config, fall back to defaults for backward compat
const dpUsername = this.config.dataplaneUsername || 'admin';
const dpPassword = this.config.dataplanePassword || 'adminpwd';

// Template credentials into haproxy.cfg
let templatedHaproxyCfg = haproxyCfg
  .replace('user admin insecure-password adminpwd',
           `user ${dpUsername} insecure-password ${dpPassword}`);

// Template credentials into dataplaneapi.yml
let templatedDataplaneApiYml = dataplaneApiYml
  .replace('name: admin', `name: ${dpUsername}`)
  .replace('password: adminpwd', `password: ${dpPassword}`);
```

Also template the stats auth line in `haproxy.cfg:46`:
```typescript
templatedHaproxyCfg = templatedHaproxyCfg
  .replace('stats auth admin:admin',
           `stats auth ${dpUsername}:${dpPassword}`);
```

Then use the templated versions for the rest of the method (escaping, writing to volume).

### Step 5: Update HAProxyDataPlaneClient to accept credentials

**File:** `server/src/services/haproxy/haproxy-dataplane-client.ts`

Change the constructor and initialize method:

```typescript
export class HAProxyDataPlaneClient {
  private axiosInstance: AxiosInstance;
  private dockerService: DockerService;
  private endpointInfo: HAProxyEndpointInfo | null = null;
  private username: string;
  private password: string;

  constructor(credentials?: { username: string; password: string }) {
    this.dockerService = DockerService.getInstance();
    this.username = credentials?.username || 'admin';
    this.password = credentials?.password || 'adminpwd';
    // ... rest of constructor
  }
}
```

The fallback to `admin`/`adminpwd` provides backward compatibility for any existing environments that haven't been migrated yet.

### Step 6: Create helper to look up credentials from environment ID

**New file or addition to:** `server/src/services/haproxy/haproxy-credential-lookup.ts`

```typescript
import prisma from '../../lib/prisma';

export async function getDataPlaneCredentials(
  environmentId: string
): Promise<{ username: string; password: string } | null> {
  const service = await prisma.environmentService.findFirst({
    where: {
      environmentId,
      serviceType: 'haproxy',
    },
    select: { config: true },
  });

  if (!service?.config) return null;

  const config = service.config as Record<string, any>;
  if (config.dataplaneUsername && config.dataplanePassword) {
    return {
      username: config.dataplaneUsername,
      password: config.dataplanePassword,
    };
  }

  return null;
}
```

### Step 7: Update callsites that create HAProxyDataPlaneClient

There are 18 non-test callsites that do `new HAProxyDataPlaneClient()`. These fall into two patterns:

**Pattern A — Helper functions that already look up the environment** (4 callsites):

These already have the environment ID and query the DB. Add credential lookup:

| File | Line | Function |
|------|------|----------|
| `routes/environments.ts` | 696 | `getHAProxyClientForEnvironment()` |
| `routes/haproxy-frontends.ts` | 656 | `getHAProxyClientForFrontend()` |
| `routes/haproxy-backends.ts` | 111 | `getHAProxyClient()` |
| `routes/manual-haproxy-frontends.ts` | 129 | `getHAProxyClient()` |

Update pattern:
```typescript
const credentials = await getDataPlaneCredentials(environmentId);
const client = new HAProxyDataPlaneClient(credentials || undefined);
```

**Pattern B — Inline instantiations in routes** (2 callsites):

| File | Line |
|------|------|
| `routes/haproxy-frontends.ts` | 215 |
| `routes/haproxy-frontends.ts` | 332 |

These need the environment ID extracted from context (the frontend/backend being operated on). Update to use the helper function pattern.

**Pattern C — Action classes in `services/haproxy/actions/`** (9 callsites):

| File |
|------|
| `actions/initiate-drain.ts` |
| `actions/validate-traffic.ts` |
| `actions/disable-traffic.ts` |
| `actions/remove-container-from-lb.ts` |
| `actions/configure-frontend.ts` |
| `actions/monitor-drain.ts` |
| `actions/enable-traffic.ts` |
| `actions/perform-health-checks.ts` |
| `actions/add-container-to-lb.ts` |

These action classes create the client in their constructor. Update to accept credentials as a constructor parameter, or accept a pre-built client.

**Pattern D — Other services** (3 callsites):

| File | Line |
|------|------|
| `services/haproxy/blue-green-deployment-state-machine.ts` | 470 |
| `services/tls/certificate-distributor.ts` | 402 |
| `routes/haproxy-frontends.ts` | 215, 332 |

Same approach — pass credentials or look them up from the environment ID available in context.

### Step 8: Update RetryableHAProxyClient

**File:** `server/src/services/haproxy/haproxy-dataplane-client.ts:1388`

`RetryableHAProxyClient extends HAProxyDataPlaneClient` — ensure it passes credentials through to `super()`:

```typescript
export class RetryableHAProxyClient extends HAProxyDataPlaneClient {
  constructor(credentials?: { username: string; password: string }) {
    super(credentials);
  }
}
```

---

## Files Changed Summary

| File | Change |
|------|--------|
| **New:** `server/src/services/haproxy/haproxy-credential-generator.ts` | Credential generation utility |
| **New:** `server/src/services/haproxy/haproxy-credential-lookup.ts` | DB lookup for stored credentials |
| `server/src/services/haproxy/haproxy-service.ts` | Accept config in constructor, template credentials into config files |
| `server/src/services/haproxy/haproxy-dataplane-client.ts` | Accept credentials in constructor, remove hardcoded values |
| `server/src/services/application-service-factory.ts` | Pass config to HAProxy constructor |
| `server/src/services/environment/environment-manager.ts` | Generate credentials on HAProxy service creation |
| `server/src/routes/environments.ts` | Credential lookup before client creation |
| `server/src/routes/haproxy-frontends.ts` | Credential lookup before client creation |
| `server/src/routes/haproxy-backends.ts` | Credential lookup before client creation |
| `server/src/routes/manual-haproxy-frontends.ts` | Credential lookup before client creation |
| `server/src/services/haproxy/actions/*.ts` (9 files) | Accept credentials in constructor |
| `server/src/services/haproxy/blue-green-deployment-state-machine.ts` | Pass credentials to client |
| `server/src/services/tls/certificate-distributor.ts` | Pass credentials to client |

---

## Testing

1. **Unit test** for `generateDataPlaneCredentials()` — verify charset, length, uniqueness
2. **Unit test** for `writeConfigsToVolume()` — verify templating replaces both config files correctly
3. **Integration test** — create an environment with HAProxy service, verify credentials stored in `EnvironmentService.config`, verify client can authenticate
4. **Manual test** — stop an existing environment, remove HAProxy service, re-add, restart. Verify new credentials are generated and the DataPlane API is accessible

---

## Migration Path

No automated migration needed. Existing environments will continue to work because:
- The `HAProxyDataPlaneClient` constructor falls back to `admin`/`adminpwd` when no credentials are provided
- The credential lookup returns `null` for old environments without credentials in config
- Old HAProxy containers still have the hardcoded config files in their volumes

To migrate an existing environment:
1. Stop the environment
2. Remove the HAProxy service (which removes the container)
3. Re-add the HAProxy service (generates new credentials)
4. Start the environment (writes new config files with new credentials)

---

## Future Improvements (Out of Scope)

- **Credential rotation** — regenerate credentials and restart HAProxy without full service removal
- **Encrypt `EnvironmentService.config`** — depends on HIGH-05/HIGH-07 encryption improvements
- **Remove fallback credentials** — once all environments are migrated, remove the `admin`/`adminpwd` fallback from the client constructor
