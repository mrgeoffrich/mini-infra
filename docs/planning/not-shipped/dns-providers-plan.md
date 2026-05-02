# DNS Providers — pluggable DNS backends with Cloudflare and BIND

**Status:** planned, not implemented. Phased rollout — each phase is a separate Linear issue.
**Builds on:** the storage-provider abstraction shipped in [`StorageBackend`](../../../lib/types/storage.ts), [`StorageServiceFactory`](../../../server/src/services/storage/storage-service-factory.ts), [`StorageService`](../../../server/src/services/storage/storage-service.ts), and the per-provider directory layout under `server/src/services/storage/providers/`. The current Cloudflare-only DNS implementation lives in [`CloudflareDNSService`](../../../server/src/services/cloudflare/cloudflare-dns.ts), [`DnsCacheService`](../../../server/src/services/dns/dns-cache-service.ts), [`DnsCacheScheduler`](../../../server/src/services/dns/dns-cache-scheduler.ts), [`DnsChallenge01Provider`](../../../server/src/services/tls/dns-challenge-provider.ts), and the `DnsCacheZone` / `DnsCacheRecord` Prisma models.
**Excludes:** non-DNS Cloudflare features (tunnels, zone-level settings, account management) — those keep their existing single-tenant Cloudflare service path. Direct DNS *editing* through the UI (today the DNS page is read-only) is **not** in scope; it remains a discovery + ACME-challenge feature.

---

## 1. Background

Mini Infra's DNS layer is currently hard-wired to a single Cloudflare account: one API token, one cached zone list, one ACME DNS-01 challenge provider that calls Cloudflare directly. The storage layer was generalised the same way last quarter and now cleanly supports Azure Blob and Google Drive side by side. DNS needs the same treatment — but with one structural twist that storage didn't have: an operator typically has **multiple DNS providers active at the same time**, each managing different zones (e.g. `example.com` on Cloudflare for public traffic, `internal.lan` on a self-hosted BIND server for the LAN). The abstraction therefore can't follow storage's "one active provider" model. Instead, DNS providers are first-class, multi-instance connections, and individual zones declare which connection they belong to. Once the framework exists, adding new providers (Route 53, PowerDNS, NS1) becomes a matter of dropping a directory under `server/src/services/dns/providers/`.

## 2. Goals

1. **A `DnsBackend` interface** modelled on `StorageBackend` but scoped to zone discovery, record CRUD, and ACME-challenge TXT operations — enough surface for the four current call sites and no more.
2. **Multi-instance, multi-provider connections.** A `DnsProviderConnection` row models one credentialed connection (one Cloudflare account *or* one BIND server). An operator can have any number of connections of any provider type configured simultaneously.
3. **Zones own their provider link.** `DnsZone` (replacing the old `DnsCacheZone`) carries `provider` and `dnsProviderConnectionId` columns; a hostname resolves to its longest-suffix-matching zone, which dictates the backend.
4. **Cloudflare and BIND v1 backends.** Cloudflare wraps the existing SDK calls behind the new interface. BIND uses RFC 2136 dynamic updates with TSIG, plus AXFR for zone enumeration.
5. **ACME DNS-01 routes by zone.** `DnsChallenge01Provider` stops calling Cloudflare directly; it asks a `DnsZoneResolver` for the zone of the challenged hostname and dispatches the TXT-record write to whichever backend owns it.
6. **A Connections admin surface.** A dedicated Connections page lets operators add, edit, test, and delete DNS provider connections; the existing DNS zones page gains a "provider" column and a per-connection refresh control.
7. **Clean schema from day one.** This work targets a fresh-install codebase — no data migration from the previous Cloudflare-only `DnsCacheZone` / `DnsCacheRecord` shape, and no in-place backfill of credentials. The new tables and connection model replace the old ones outright.

## 3. Non-goals

- **Multi-tenancy of the same provider type per zone.** A given zone is owned by exactly one connection. We do not model "this zone is on both Cloudflare and BIND with one as a hidden master" — that's a sync product, not a DNS abstraction.
- **DNS record editing through the UI.** The DNS page stays read-only for browsing + refresh. ACME writes TXT records programmatically; everything else is operator-managed in the provider's own UI.
- **Cloudflare tunnel management via the new abstraction.** Tunnels remain a Cloudflare-specific feature on the existing `CloudflareService`. The DNS abstraction covers zones and records only.
- **A third v1 provider.** Route 53 / PowerDNS / NS1 wait for a real user ask; the framework just has to make them cheap to add.
- **Auto-discovery of BIND zones across the whole server.** BIND has no listzones API; the operator declares which zones a BIND connection serves. Auto-discovery via `rndc` or shared-config introspection is deferred.
- **Reshaping `DeploymentDNSRecord`'s `dnsProvider: 'cloudflare' | 'external'` enum.** That type already encodes a provider-agnostic concept ("we manage it" vs "operator handles it") and is orthogonal to which backend manages it. Untouched in this work.
- **Changing the read-only "DNS validation" hostname-lookup behaviour.** The cached lookup keeps working; it just spans multiple connections.
- **Any data migration story.** This is a fresh-install codebase. Old `DnsCacheZone` / `DnsCacheRecord` rows and the legacy single-tenant Cloudflare credentials in `SystemSettings(category="cloudflare")` are not preserved or backfilled — the new shape replaces them outright.
- **Cloudflare tunnels with non-Cloudflare DNS.** If a stack uses a Cloudflare tunnel for a hostname, the parent zone for that hostname **must** be served by a Cloudflare DNS connection. We do not support tunnel-routing to a hostname whose DNS lives on BIND. This rules out one valid-but-niche topology (BIND-served zone with Cloudflare-tunnel ingress for a single subdomain) in exchange for keeping the data model sound: every zone has exactly one owning connection, and the `@@unique([name])` constraint on `DnsZone` holds by construction. Tunnel-create flows validate this and refuse the operation with a clear error if the parent zone isn't on Cloudflare.

## 4. The DNS provider framework

### 4.1 Concepts

- **DNS provider.** A backend type identified by a stable string (`cloudflare`, `bind`). Implements the `DnsBackend` interface and ships as a directory under `server/src/services/dns/providers/<provider>/`.
- **DNS provider connection.** A specific credentialed instance of a provider — one Cloudflare account, or one BIND server. Stored as a `DnsProviderConnection` row with provider type + opaque JSON config blob (encrypted) + a user-given label.
- **DNS zone.** A cached record of a zone known to a connection, with the connection ID stamped on the row. A zone name is unique *across all connections* — overlapping ownership is rejected at refresh time.
- **DNS record.** A cached record under a zone, carrying provider-native record IDs.
- **Zone resolver.** A small service that, given a hostname, finds the longest-suffix-matching `DnsZone` and returns `(zone, connection, backend)` for the caller. Powers ACME challenge routing and the hostname-validation endpoint.

### 4.2 Backend contract

The interface that provider modules implement and the runtime consumes:

```ts
export const DNS_PROVIDER_IDS = ["cloudflare", "bind"] as const;
export type DnsProviderId = typeof DNS_PROVIDER_IDS[number];

export interface DnsBackend {
  readonly providerId: DnsProviderId;
  readonly connectionId: string;

  validate(): Promise<ValidationResult>;
  getHealthStatus(): Promise<ServiceHealthStatus>;

  /** Enumerate zones this connection manages. For BIND this returns the
   *  operator-declared zone list; for Cloudflare it queries the API. */
  listZones(): Promise<ProviderZone[]>;

  /** Enumerate records in one zone — AXFR for BIND, GET /zones/:id/dns_records
   *  for Cloudflare. */
  listRecords(zone: ProviderZoneRef): Promise<ProviderRecord[]>;

  /** ACME DNS-01 surface — narrow on purpose. */
  createTxtRecord(zone: ProviderZoneRef, name: string, value: string, ttl?: number): Promise<{ recordId: string }>;
  deleteRecord(zone: ProviderZoneRef, recordId: string): Promise<void>;
}

export interface ProviderZoneRef {
  /** Provider-native zone identifier. Cloudflare zone ID, or BIND zone name. */
  providerZoneId: string;
  name: string;
}

export interface ProviderZone extends ProviderZoneRef {
  status?: string;
  type?: string;
  nameServers?: string[];
  createdOn?: string | null;
  modifiedOn?: string | null;
}

export interface ProviderRecord {
  providerRecordId: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  /** Cloudflare-specific. BIND backend always returns false. */
  proxied?: boolean;
  proxiable?: boolean;
  locked?: boolean;
}
```

Per-provider config schemas (validated at connection-create time):

```ts
// cloudflare
{ apiToken: string; accountId: string }

// bind
{
  server: string;          // host:port for the BIND server
  tsigKeyName: string;
  tsigSecret: string;      // base64
  tsigAlgorithm?: "hmac-sha256" | "hmac-sha512";
  zones: string[];         // operator-declared zones this connection serves
  axfrEnabled?: boolean;   // some BIND deployments lock down AXFR; default true
}
```

### 4.3 Registry and resolution

Mirroring `StorageServiceFactory` but with one extra dimension (connection):

```ts
export type DnsBackendFactory = (prisma: PrismaClient, connection: DnsProviderConnection) => DnsBackend;

class DnsProviderRegistry {
  static register(providerId: DnsProviderId, factory: DnsBackendFactory): void;
  static getFactory(providerId: DnsProviderId): DnsBackendFactory | undefined;
}

class DnsBackendCache {
  forConnection(connectionId: string): Promise<DnsBackend>;  // resolves connection row → backend, cached
  forZone(zoneId: string): Promise<DnsBackend>;              // looks up zone → connection → backend
  invalidateConnection(connectionId: string): void;
}

class DnsZoneResolver {
  findZoneFor(hostname: string): Promise<{ zone: DnsZone; connection: DnsProviderConnection } | null>;
  findZoneByName(name: string): Promise<{ zone: DnsZone; connection: DnsProviderConnection } | null>;
}
```

Resolution rule for `findZoneFor`: longest-suffix match against the cached `DnsZone.name` set, ignoring the connection. If two connections claim the same suffix the second registration is rejected at refresh time, so resolution is unambiguous by construction.

### 4.4 Cache shape

Three new tables replace the old `DnsCacheZone` / `DnsCacheRecord` pair. Zones and records carry a `provider` + `dnsProviderConnectionId` discriminator and use opaque `providerZoneId` / `providerRecordId` IDs instead of provider-specific column names:

```prisma
model DnsZone {
  id                       String   @id @default(cuid())
  provider                 String                                    // "cloudflare" | "bind"
  dnsProviderConnectionId  String
  connection               DnsProviderConnection @relation(fields: [dnsProviderConnectionId], references: [id], onDelete: Cascade)
  providerZoneId           String                                    // cloudflareZoneId | bind zone name
  name                     String                                    // e.g. "example.com"
  status                   String
  type                     String
  nameServers              String                                    // JSON-encoded string[]
  createdOn                String?
  modifiedOn               String?
  cachedAt                 DateTime @default(now())

  records DnsRecord[]

  @@unique([dnsProviderConnectionId, providerZoneId])
  @@unique([name])                                                   // one connection per zone — globally unique
  @@index([dnsProviderConnectionId])
  @@index([provider])
  @@map("dns_zones")
}

model DnsRecord {
  id                 String   @id @default(cuid())
  zoneId             String
  zone               DnsZone  @relation(fields: [zoneId], references: [id], onDelete: Cascade)
  providerRecordId   String
  type               String
  name               String
  content            String
  ttl                Int
  proxied            Boolean  @default(false)
  proxiable          Boolean  @default(true)
  locked             Boolean  @default(false)
  zoneName           String
  createdOn          String?
  modifiedOn         String?
  cachedAt           DateTime @default(now())

  @@unique([zoneId, providerRecordId])
  @@index([zoneId])
  @@index([name])
  @@index([type])
  @@map("dns_records")
}

model DnsProviderConnection {
  id          String     @id @default(cuid())
  provider    String                                                 // "cloudflare" | "bind"
  name        String                                                 // user-given label
  configJson  String                                                 // encrypted JSON; schema per provider
  isActive    Boolean    @default(true)
  lastValidatedAt   DateTime?
  validationStatus  String?
  validationMessage String?
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt
  createdBy   String
  updatedBy   String

  zones DnsZone[]

  @@unique([name])
  @@index([provider])
  @@map("dns_provider_connections")
}
```

The cache scheduler iterates `DnsProviderConnection` rows and dispatches per-backend; one flaky connection no longer blocks refresh of the others.

### 4.5 Cloudflare credential ownership

Cloudflare credentials live on `DnsProviderConnection.configJson` going forward. The existing `CloudflareService` (which owns tunnels and zone-level account features) reads its API token from the first `provider="cloudflare"` connection at runtime, rather than maintaining a parallel copy in `SystemSettings`. There is exactly one source of truth for the Cloudflare API token.

Per the §3 non-goal that ties tunnels to Cloudflare DNS, an operator who uses Cloudflare tunnels by definition has at least one Cloudflare connection with at least one managed zone — there is no "Cloudflare connection with zero zones" topology to design around. An operator who uses BIND for everything and has no Cloudflare tunnels simply has no Cloudflare connection at all; tunnel-related routes fail closed in that case.

### 4.6 Permissions and events

A new permission domain `dns-providers` for managing connections (`dns-providers:read`, `dns-providers:write`). The existing `dns:read` permission still gates the read-only zones view. Two new Socket.IO events on a `dns` channel surface connection-level refresh progress and failures: `DNS_CONNECTION_REFRESH_STARTED`, `DNS_CONNECTION_REFRESH_COMPLETED`. Per-connection validation status drives the existing connectivity-status surfacing under a service id of `dns-provider:<connectionId>`.

## 5. Phased rollout

Phases land in order — each phase blocks all subsequent phases. Phase 1 establishes the abstraction and ships the Cloudflare backend; Phase 2 adds BIND; Phase 3 wires multi-connection cache refresh + ACME zone routing end-to-end; Phase 4 ships the Connections admin UI; Phase 5 polishes per-provider UX and adds the per-connection health surfacing.

### Phase 1 — DNS provider framework + Cloudflare backend

**Goal:** the abstraction exists end-to-end, Cloudflare is its first implementation, and the existing DNS surfaces (zones page, hostname validation, ACME DNS-01) are powered by it.

Deliverables:
- New `lib/types/dns-providers.ts` module defining `DnsProviderId`, `DnsBackend`, `ProviderZone`, `ProviderRecord`, per-provider config schemas, and connection DTOs. Re-exported from `lib/types/index.ts`.
- New `server/src/services/dns/providers/` directory with the `DnsProviderRegistry`, `DnsBackendCache`, and `DnsZoneResolver`.
- A `cloudflare/` provider directory containing `cloudflare-dns-backend.ts` that implements `DnsBackend` by reusing the existing `CloudflareApiRunner` + SDK call paths. Eager registration at module load mirrors `StorageServiceFactory.register("azure", …)`.
- New Prisma schema with `DnsProviderConnection`, `DnsZone`, `DnsRecord` tables — fresh shape, no legacy `DnsCacheZone` / `DnsCacheRecord` carryover.
- `CloudflareService` reads its API token from the first `provider="cloudflare"` `DnsProviderConnection` instead of `SystemSettings(category="cloudflare")` — single source of truth from day one.
- `DnsCacheService` rewritten to consume the resolver/backend and operate over the new tables.
- `DnsChallenge01Provider` rewritten to dispatch through `DnsZoneResolver` + `DnsBackend.createTxtRecord` / `deleteRecord` instead of calling Cloudflare directly.
- New permission domain `dns-providers` and routes scaffolding mounted at `/api/dns-providers` (CRUD reserved for Phase 4 — Phase 1 ships only `GET /` and `GET /:id`).
- Test coverage: backend contract tests for `CloudflareDnsBackend`, resolver longest-suffix tests, and an end-to-end test that seeds a connection row, refreshes the cache, and resolves a hostname through the new pipeline.

Done when: on a fresh install, an operator who has seeded a Cloudflare connection (via direct DB insert or seed script for now — admin UI lands in Phase 4) can refresh the DNS cache, browse zones in the existing zones page, validate hostnames, and complete an ACME DNS-01 issuance — all routed through the new abstraction.

### Phase 2 — BIND backend

**Goal:** a self-hosted BIND server with TSIG-authenticated dynamic updates is a fully functional DNS provider.

Deliverables:
- A `bind/` provider directory under `server/src/services/dns/providers/` containing the BIND backend, a TSIG-signing client (using `dns2` or `dns-packet` — pick during implementation), an AXFR enumerator for zone records, and an `nsupdate`-equivalent for record CRUD.
- BIND-specific config schema: server host:port, TSIG key name + secret + algorithm, declared zone list, optional `axfrEnabled` flag.
- Backend `validate()` does a SOA query against each declared zone and a no-op TSIG-signed `nsupdate` to confirm write access.
- Backend `listZones()` returns the operator-declared zone set (no AXFR-of-everything; BIND has no enumerate API).
- Backend `listRecords(zone)` performs AXFR when enabled, falling back to a typed-query sweep (`SOA`, `NS`, `A`, `AAAA`, `MX`, `TXT`, `CNAME`) when not.
- Backend `createTxtRecord` + `deleteRecord` use TSIG-signed RFC 2136 update messages.
- Connection-create-time validation rejects zone-name overlaps with already-registered connections.
- Test coverage: a docker-compose-driven integration test that boots a real `bind9` container, configures TSIG, and exercises the full backend contract end-to-end. Smaller unit tests for the TSIG client and AXFR parser.

Done when: an operator can add a BIND connection through the API (Phase 4 ships the UI), the cache scheduler refreshes the BIND zones, an ACME DNS-01 issuance succeeds for a hostname under a BIND-managed zone, and the resulting TXT record is visible in `dig` against the BIND server.

### Phase 3 — Multi-connection cache scheduler + ACME zone routing

**Goal:** every active connection refreshes independently, ACME challenges route by zone, and one provider's outage doesn't degrade the others.

Deliverables:
- `DnsCacheScheduler` rewritten to iterate `DnsProviderConnection` rows and dispatch per backend. Each connection's refresh runs as its own promise with isolated error handling; failure of one connection emits `DNS_CONNECTION_REFRESH_FAILED` on the `dns` Socket.IO channel without blocking the others.
- Per-connection `lastRefreshedAt` and `lastRefreshError` surfaced on `DnsProviderConnection`.
- The hostname-validation endpoint (`/api/dns/validate/:hostname`) crosses all connections via the resolver and reports which zone (and which connection) matched.
- ACME challenge cleanup (the `NodeCache` keyed by challenge) is rewritten to remember `(connectionId, zoneId, recordId)` so cleanup goes back to the right backend even if multiple connections own different zones for the same parent domain in different environments.
- Per-zone refresh endpoint (`POST /api/dns/zones/:zoneId/refresh`) dispatches to the backend that owns the zone.
- Test coverage: a multi-connection refresh scenario where one backend is mocked to fail, asserting the other completes and `DNS_CONNECTION_REFRESH_FAILED` fires for the failed one.

Done when: with one Cloudflare connection serving `example.com` and one BIND connection serving `internal.lan`, ACME issuance for `foo.example.com` and `bar.internal.lan` both succeed in the same boot, a refresh tick logs both connection attempts independently, and forcibly breaking the BIND server's TSIG key does not interrupt the Cloudflare refresh cadence.

### Phase 4 — DNS Connections admin UI

**Goal:** operators add, test, edit, and remove DNS provider connections without touching the API directly.

Deliverables:
- A new `/dns-providers` page listing every `DnsProviderConnection` with provider type, label, zone count, last-refresh status, and a per-row "Test connection" + "Refresh now" + "Edit" + "Delete" set of actions.
- A "New connection" dialog that branches by provider type: a Cloudflare form (api token + account id, with the existing token-validation flow) and a BIND form (server, TSIG key + secret + algorithm dropdown, zones textarea, AXFR toggle).
- "Edit connection" reuses the same form pre-filled (with secrets masked behind a "Reveal/Replace" affordance).
- Delete flow checks for in-flight ACME challenges referencing the connection's zones and refuses the deletion until they complete; surface that in the UI.
- The existing `/dns` zones page gains a "Provider" column with provider-id badges and a connection-name link, plus a per-connection refresh dropdown that replaces the global "Refresh from Cloudflare" button.
- New TanStack Query hooks `useDnsProviderConnections`, `useDnsProviderConnection`, `useCreateDnsProviderConnection`, `useUpdateDnsProviderConnection`, `useDeleteDnsProviderConnection`, `useTestDnsProviderConnection`.
- Permission gating: `dns-providers:read` shows the page; `dns-providers:write` enables create/edit/delete/test affordances. Add the permission to the Admin preset.
- User-docs page covering both Cloudflare setup (mostly identical to today's flow, repointed at the new page) and BIND setup with a worked TSIG example.

Done when: a fresh-install operator can land on `/dns-providers`, add a Cloudflare connection, add a BIND connection, see both refreshing in the zones page with their respective zones, and delete one without affecting the other.

### Phase 5 — Per-provider polish + connectivity rollup

**Goal:** the operator surface treats DNS providers consistently with other connected services, and per-connection health is observable at a glance.

Deliverables:
- A connectivity-status entry per connection (`service="dns-provider:<connectionId>"`) feeding into the existing `/api/connectivity` rollup, plus a "DNS providers" summary card on the home dashboard with green/yellow/red status badges per connection.
- The `/api/settings/cloudflare` non-token routes (account-id metadata, connectivity probe — anything tunnels still need) stay; the token-management endpoints are removed entirely. Tunnel code reads its token via the `cloudflare` connection.
- Filter chip on the cached zones page — "show zones from connection X" — and on the records sub-view.
- A "Re-validate" affordance per connection that runs the backend's `validate()` synchronously and surfaces the `ValidationResult.message` inline, mirroring the storage-providers page UX.
- Admin docs gain a "DNS provider playbook" page covering: when to pick which provider, how zone-overlap rejection works, how ACME challenge routing chooses, and the manual recovery story for a BIND server with stale TSIG.

Done when: an operator can audit the health of every DNS provider from one page, immediately tell which connection owns a given zone, and follow a single docs page from "I have a new BIND server" to "an ACME-issued cert is live for a record under it."

## 6. Risks & open questions

- **BIND library choice.** Three plausible options for TSIG + RFC 2136 in TypeScript: (a) `dns2` (TSIG support is partial), (b) `dns-packet` + a hand-rolled TSIG signer (most control, most code), (c) shelling out to `nsupdate` from a sidecar (simplest, leakiest). Phase 2 should spike each for ~half a day before committing.
- **AXFR access in real-world BIND setups.** AXFR is often locked down to specific source IPs. The container that runs Mini Infra may not be on the allowlist; the typed-query fallback exists but is materially slower for large zones (hundreds of records). Documentation needs to be honest about the perf tradeoff and recommend AXFR allowlisting for the Mini Infra container's IP.
- **Zone-name uniqueness vs environments.** The plan asserts zone names are globally unique across connections. An edge case: an operator running "split-horizon" DNS where the same zone is served differently to internal vs external resolvers will not be served by this model. We're calling that out of scope (see Non-goals), but Phase 4's "add connection" form should give a clear error message when a zone-overlap rejection bites.
- **Wire-format break for the DNS DTOs.** The existing client consumes `DnsCachedZone.cloudflareZoneId` and `DnsCachedRecord.cloudflareRecordId`. The new shape uses `providerZoneId` / `providerRecordId` plus a `provider` field. Since this is a fresh install, just break the contract and update the client in lockstep — no compat layer.
- **ACME rate-limit asymmetry.** Cloudflare has generous DNS API limits; BIND has whatever the operator's `update-policy` allows. ACME issuance burst patterns may surprise BIND admins. Worth a one-paragraph "if your BIND chokes, here's why" note in the Phase 5 playbook.
- **Per-connection cron timing.** With multiple connections, refreshing every connection on the same cron tick means N concurrent fan-outs. For two connections this is fine; if a future deployment grows to ten, jittering is needed. Note for Phase 3 — accept the simple "all-at-once" design for now and put a TODO in the scheduler.
- **Bootstrapping a Cloudflare connection before Phase 4.** Between Phase 1 and Phase 4 there is no admin UI for creating connections. Either ship a one-shot seed script with Phase 1, or front-load a minimal "create-connection" form in Phase 1 instead of waiting for Phase 4. Default plan is the seed script; revisit if Phases 2–3 turn into long-lived branches.

## 7. Linear tracking

- ALT-_TBD_ — Phase 1: DNS provider framework + Cloudflare backend
- ALT-_TBD_ — Phase 2: BIND backend
- ALT-_TBD_ — Phase 3: Multi-connection cache scheduler + ACME zone routing
- ALT-_TBD_ — Phase 4: DNS Connections admin UI
- ALT-_TBD_ — Phase 5: Per-provider polish + connectivity rollup
