# Stack Tunnel Ingress Configuration

**Date:** 2026-03-29
**Status:** Approved

## Problem

When deploying a StatelessWeb application on an internet-facing environment, HAProxy is configured but the Cloudflare tunnel is not updated with the public hostname. The stack resource reconciler has a TODO where it should call the Cloudflare API but currently only writes to the local database.

## Solution

Wire the Cloudflare API into the stack resource reconciler so that tunnel ingress rules are automatically created/removed during stack deployment. Store tunnel configuration (tunnel ID and HAProxy service URL) on the environment model.

## Environment Model Changes

Add two nullable fields to the `Environment` model:

- `tunnelId` (String?) — Cloudflare tunnel UUID (e.g., `"277a978a-8a04-4761-a248-0464ced6a055"`)
- `tunnelServiceUrl` (String?) — Backend URL the tunnel routes to (e.g., `"http://internet-facing-haproxy-haproxy:80"`)

These are only relevant when `networkType === "internet"`. The environment API and edit UI should expose these fields.

## CloudflareService.addHostname() Change

The existing `addHostname()` method builds ingress rules without `originRequest`. Extend it to accept an optional `originRequest` parameter:

```typescript
async addHostname(
  tunnelId: string,
  hostname: string,
  service: string,
  path?: string,
  originRequest?: { httpHostHeader?: string },
): Promise<any>
```

When provided, include `originRequest` on the new ingress rule. This is needed so HAProxy can route by host header. The `httpHostHeader` value is always the same as the `hostname` (the user's chosen FQDN like `app.example.com`).

No DNS record creation is needed — Cloudflare tunnels handle DNS automatically via CNAME.

## Stack Template Creation

When the new application form submits with `enableTunnel: true`:

1. The form already sets `routing.tunnelIngress` to the hostname string
2. The API handler (stack-templates route) must also construct a top-level `tunnelIngress` array entry:
   - `name`: the hostname
   - `fqdn`: the hostname
   - `service`: resolved from the environment's `tunnelServiceUrl`

If the environment has no `tunnelServiceUrl` configured, the API should return an error explaining that the environment needs tunnel configuration before tunnel-enabled apps can be deployed.

## Reconciler Changes

In `stack-resource-reconciler.ts`, replace the TODO in `reconcileTunnel()`:

**On create/update:**
1. Look up the stack's environment to get `tunnelId` and `tunnelServiceUrl`
2. If environment has no `tunnelId`, skip with a warning (don't fail the deployment)
3. Call `CloudflareService.addHostname(tunnelId, fqdn, tunnelServiceUrl, undefined, { httpHostHeader: fqdn })`
4. Store the tunnel ID in `stackResource.externalId` for later removal

**On remove:**
1. Read `externalId` (tunnel ID) from the stack resource record
2. Call `CloudflareService.removeHostname(tunnelId, fqdn)`
3. Delete the stack resource record

**Error handling:** If the Cloudflare API call fails, mark the resource as errored (`status: 'error'`, `error: message`) but do not fail the overall stack deployment. HAProxy routing is already configured — only the public tunnel route is missing.

## Data Flow

```
User creates app with tunnel enabled
  → Form sends routing.tunnelIngress = hostname
  → API builds tunnelIngress[] with {name, fqdn, service} from env config
  → Stack template saved

User deploys app
  → Reconciler plans tunnel resource (create action)
  → reconcileTunnel() runs:
    1. Reads environment.tunnelId and environment.tunnelServiceUrl
    2. Calls CloudflareService.addHostname(tunnelId, hostname, serviceUrl, null, {httpHostHeader: hostname})
    3. Cloudflare creates CNAME + ingress rule
    4. Saves stackResource with externalId = tunnelId

User stops/removes app
  → Reconciler plans tunnel resource (remove action)
  → reconcileTunnel() runs:
    1. Reads externalId from stackResource
    2. Calls CloudflareService.removeHostname(tunnelId, hostname)
    3. Deletes stackResource record
```

## Scope

- Environment model: add `tunnelId` and `tunnelServiceUrl` fields, migration, API update
- CloudflareService: extend `addHostname()` with `originRequest` parameter
- Stack resource reconciler: implement tunnel API calls in `reconcileTunnel()`
- Stack template creation: build `tunnelIngress[]` from environment config when tunnel is enabled
- Environment edit UI: add tunnel ID and service URL fields (for internet-type environments only)
