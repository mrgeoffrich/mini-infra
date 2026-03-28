# Stack-Level Resource Management: TLS, DNS, and Cloudflare Tunnel Ingress

**Date:** 2026-03-28
**Status:** Approved

## Problem

Today, TLS certificates, DNS records, and Cloudflare tunnel configuration are managed in different places:

- TLS certificates are provisioned via a separate API call and referenced by ID in deployment configs
- DNS records are created inline during deployment state machine execution (initial/blue-green/removal)
- Cloudflare tunnel ingress is partially implemented at the environment level
- HAProxy frontend/route configuration is split between the deployment state machines and `StackRoutingManager`

This creates several issues:
- Stateful services (databases, caches) cannot get DNS records or TLS certificates because these resources are tied to the StatelessWeb deployment flow
- Resource lifecycle is entangled with container deployment — removing a service also removes its DNS, which may not be desired
- No unified plan/diff view for infrastructure resources
- Two parallel systems (deployment state machines and stack reconciler) managing overlapping concerns

## Solution

Elevate TLS certificates, DNS records, and Cloudflare tunnel ingress to first-class stack-level resources — declared in the stack definition alongside networks and volumes, reconciled during plan/apply, and referenced by name from services.

## Design

### Stack Definition Changes

Three new top-level arrays added to `StackDefinition`:

```typescript
interface StackDefinition {
  name: string
  description?: string
  parameters?: StackParameterDefinition[]
  networks: StackNetwork[]
  volumes: StackVolume[]
  tlsCertificates: StackTlsCertificate[]
  dnsRecords: StackDnsRecord[]
  tunnelIngress: StackTunnelIngress[]
  services: StackServiceDefinition[]
}
```

#### TLS Certificate Resource

```typescript
interface StackTlsCertificate {
  name: string   // Reference key (e.g., "api-cert")
  fqdn: string   // Fully qualified domain name (e.g., "api.example.com")
}
```

- The reconciler looks up the certificate in the TLS store by FQDN.
- If no certificate exists, it provisions one via the existing ACME flow (blocking).
- If a certificate exists, it reuses it.
- On stack destroy or resource removal, the certificate stays in the TLS store. Only the HAProxy binding is removed.

#### DNS Record Resource

```typescript
interface StackDnsRecord {
  name: string        // Reference key (e.g., "api-dns")
  fqdn: string        // Hostname (e.g., "api.example.com")
  recordType: 'A'     // Only A records initially, extensible later
  target: string      // IP address (host IP for local network apps)
  ttl?: number        // Defaults to 300
  proxied?: boolean   // Cloudflare proxy, defaults to false
}
```

Initially used for "local" network type applications, pointing to the host IP where HAProxy listens. The record type and schema are designed to be extended for CNAME, AAAA, etc. in the future.

#### Tunnel Ingress Resource

```typescript
interface StackTunnelIngress {
  name: string    // Reference key (e.g., "api-tunnel")
  fqdn: string    // Public hostname routed through the tunnel
  service: string // Target service URL (e.g., "http://container:8080")
}
```

- The tunnel itself (the `cloudflared` connector) is managed separately at the host/environment level.
- This resource manages Cloudflare tunnel ingress configuration — routing a public hostname through an existing tunnel to a service.
- The tunnel to use is determined by the stack's environment/host context (one tunnel per environment/host).

### Service Routing Changes

Services reference stack-level resources by name, replacing the current inline TLS/DNS configuration.

**New `StackServiceRouting`:**

```typescript
interface StackServiceRouting {
  hostname: string
  listeningPort: number
  backendOptions?: StackBackendOptions
  tlsCertificate?: string    // references StackTlsCertificate.name
  dnsRecord?: string         // references StackDnsRecord.name
  tunnelIngress?: string     // references StackTunnelIngress.name
}
```

**Removed fields:**
- `enableSsl` — implied by whether `tlsCertificate` is set
- `tlsCertificateId` — replaced by stack-level TLS resource lookup by FQDN
- `dns` block — replaced by reference to stack-level DNS resource

**Key behaviors:**
- Any service type (Stateful or StatelessWeb) can declare routing with resource references.
- A service can reference any combination of resources, or none.
- If `tlsCertificate` is set, the HAProxy route gets HTTPS binding. Otherwise, HTTP only.
- Stateful services with routing get DNS/TLS/tunnel resources configured but do not go through blue-green deployment.

### Plan Phase

The plan phase extends to diff all resource types alongside containers.

```typescript
interface StackPlan {
  stackId: string
  version: number
  serviceActions: ServiceAction[]
  resourceActions: ResourceAction[]
  warnings: PlanWarning[]
}

interface ResourceAction {
  resourceType: 'tls' | 'dns' | 'tunnel'
  resourceName: string
  action: 'create' | 'update' | 'remove' | 'no-op'
  reason?: string
  diff?: FieldDiff[]
}
```

**Diffing logic per resource type:**

Each resource type is compared against `StackResource` records in the database, matched by `(stackId, resourceType, resourceName)`:

- No record exists → `create`
- Record exists but `externalState` differs from definition → `update`
- Record exists in DB but not in definition → `remove`
- Record matches → `no-op`

**TLS-specific diffing:**
- Cert exists in TLS store and is bound to HAProxy → `no-op`
- Cert exists but not bound → `create` (bind it)
- Cert doesn't exist in TLS store → `create` (provision + bind)
- Previously bound but removed from definition → `remove` (unbind only)

**Validation during plan:**
- Resource names referenced in service routing must exist in the stack's resource arrays
- FQDNs must be valid hostnames
- Warn if a TLS cert FQDN doesn't match any service hostname (likely misconfiguration)

### Apply Phase — Execution Order

Apply executes in dependency order within a single blocking flow:

```
1. Networks       (create stack-owned Docker networks)
2. Volumes        (create stack-owned Docker volumes)
3. TLS Certs      (lookup/provision certificates, deploy to HAProxy)
4. DNS Records    (create/update Cloudflare DNS records)
5. Tunnel Ingress (configure Cloudflare tunnel ingress rules)
6. Services       (create/recreate/remove containers + HAProxy routing)
7. Cleanup        (remove resources no longer in definition)
```

**Why this order:**
- Networks and volumes must exist before containers start (same as today).
- TLS certs must be provisioned and deployed to HAProxy before services route traffic over HTTPS.
- DNS should point to the host before traffic arrives.
- Tunnel ingress should be configured before containers are ready to receive traffic.
- Cleanup runs last — removes old DNS records, unbinds old certs, removes old tunnel ingress rules after services are updated.

**Cleanup phase:**
- Resources present in the previous `lastAppliedSnapshot` but absent from the current definition are removed.
- TLS: unbind from HAProxy only (certificate stays in TLS store).
- DNS: delete record from Cloudflare.
- Tunnel: remove ingress rule from Cloudflare tunnel config.

**Error handling:**
- If TLS provisioning fails, apply fails before containers are touched — safe to retry.
- If DNS or tunnel config fails, apply fails — containers not yet started.
- If a service fails after resources are set up, resources stay in place (still valid). Stack status becomes `error` as today.

**Progress reporting:**
- The existing `onProgress` callback is extended to report resource actions alongside service actions.
- Each resource create/update is a progress step (e.g., "Provisioning TLS certificate for api.example.com...").

### Database Changes

**New table: `StackResource`**

Tracks the state of stack-level resources so the reconciler can diff against them.

```prisma
model StackResource {
  id        String   @id @default(uuid())
  stackId   String
  stack     Stack    @relation(fields: [stackId], references: [id], onDelete: Cascade)

  resourceType  String   // 'tls' | 'dns' | 'tunnel'
  resourceName  String   // name from the stack definition
  fqdn          String   // the domain this resource manages

  externalId    String?  // Cloudflare record ID, tunnel ingress ID, or TlsCertificate ID
  externalState Json?    // snapshot of what was applied (target IP, TTL, proxied, etc.)

  status    String   @default("active")  // 'active' | 'pending' | 'error'
  error     String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([stackId, resourceType, resourceName])
}
```

**Design rationale — single table rather than three:**
- Consistent pattern: one place to query "what resources does this stack own?"
- `externalState` JSON holds type-specific details (same pattern as `containerConfig` on `StackService`)
- Extensible: adding a new resource type doesn't require a new migration

**Stack model changes:**
- Add `resources StackResource[]` relation to `Stack`.
- `lastAppliedSnapshot` already captures the full `StackDefinition` JSON including the new resource arrays — no change needed for audit.

**No changes to `TlsCertificate` table.** Certificates remain independent entities. `StackResource.externalId` references the `TlsCertificate.id` for binding.

### Reconciler Implementation

The `StackReconciler` class gains resource reconciliation methods called from within the existing `apply()` flow.

**New internal methods:**

```typescript
// Plan phase
planResources(definition: StackDefinition, currentResources: StackResource[]): ResourceAction[]

// Apply phase - called in order from apply()
reconcileTls(actions: ResourceAction[], stack: Stack): Promise<ResourceResult[]>
reconcileDns(actions: ResourceAction[], stack: Stack): Promise<ResourceResult[]>
reconcileTunnel(actions: ResourceAction[], stack: Stack): Promise<ResourceResult[]>
cleanupResources(removedResources: ResourceAction[]): Promise<ResourceResult[]>
```

**TLS reconciliation:**
1. Query `TlsCertificate` by FQDN.
2. If not found, call `CertificateLifecycleManager.issueCertificate()` (blocking, uses existing ACME flow).
3. Deploy cert to HAProxy via `HaproxyCertificateDeployer`.
4. Upsert `StackResource` record with `externalId = tlsCertificate.id`.

**DNS reconciliation:**
1. Call `CloudflareDNSService.upsertARecord(fqdn, target, ttl, proxied)`.
2. Upsert `StackResource` record with `externalId = cloudflareRecordId` and `externalState = { target, ttl, proxied }`.

**Tunnel reconciliation:**
1. Look up the tunnel for this stack's environment/host context.
2. Add/update ingress rule via Cloudflare tunnel API.
3. Upsert `StackResource` record with `externalId = ingressRuleId`.

**Destroy changes:**
- `destroyStack()` iterates `StackResource` records and cleans up: unbind TLS from HAProxy, delete DNS records, remove tunnel ingress rules.
- Then proceeds with existing container/network/volume removal.

**Definition hash:**
- Resource definitions are included in the stack's definition hash so drift detection catches resource changes.

### HAProxy Routing Integration

`StackRoutingManager` reads the resolved TLS cert from the `StackResource` record when configuring the frontend/route:

- If a service references a `tlsCertificate`, the `StackResource` for that TLS resource provides the `externalId` (the `TlsCertificate.id`), which is used to configure HTTPS binding on the HAProxy route.
- If no TLS reference, the route is HTTP only.
- This replaces the current `enableSsl` / `tlsCertificateId` fields on `StackServiceRouting`.

### Apply Result Changes

`ApplyResult` and `StackDeployment.serviceResults` extend to include resource results:

```typescript
interface ApplyResult {
  success: boolean
  appliedVersion: number
  serviceResults: ServiceApplyResult[]
  resourceResults: ResourceResult[]
  duration: number
}

interface ResourceResult {
  resourceType: 'tls' | 'dns' | 'tunnel'
  resourceName: string
  action: 'create' | 'update' | 'remove' | 'no-op'
  success: boolean
  error?: string
}
```

The `StackDeployment` audit record gains a new `resourceResults` JSON field alongside the existing `serviceResults` field. Both are stored in the `StackDeployment` table.

## Migration Path

This design changes the `StackServiceRouting` interface, which affects existing stack definitions. A migration is needed:

1. Add the `StackResource` table.
2. Add `tlsCertificates`, `dnsRecords`, `tunnelIngress` arrays to the stack definition type (defaulting to empty arrays).
3. Migrate existing `StackServiceRouting` data: for any service with `enableSsl: true` or `dns` config, create corresponding stack-level resources and update the service routing to reference them by name.
4. Remove deprecated fields (`enableSsl`, `tlsCertificateId`, `dns`) from `StackServiceRouting`.

Existing stacks without TLS/DNS/tunnel resources continue to work unchanged — the new arrays default to empty.

## Out of Scope

- New DNS record types beyond A records (future extension)
- Full tunnel lifecycle management (tunnels are managed at the host/environment level)
- Certificate revocation on stack destroy (certs are retained in the TLS store)
- UI changes (will be addressed in a separate design)
