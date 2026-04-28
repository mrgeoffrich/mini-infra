# Egress Firewall — Future Work

Status: **planned, not implemented**. Captures items the v1 + v2 PR
([#263](https://github.com/mrgeoffrich/mini-infra/pull/263)) deliberately
deferred. Pick any of these up independently — they don't have hard
ordering dependencies on each other.

## Context

v1 + v2 shipped a per-environment DNS firewall: each env has an
egress-gateway sidecar at a pinned IPv4 on the applications network,
managed containers' `HostConfig.Dns` points at it, the gateway forwards or
NXDOMAIN's based on stack-scoped policies, and the audit pipeline streams
every query into `EgressEvent` rows with live UI updates. Detect ↔ Enforce
mode toggle, rule CRUD, and a promote-to-Enforce wizard with wildcard
suggestions are all in place. Stack templates can declare `requiredEgress`
patterns that auto-create allow rules.

What's deferred falls into three buckets: closing the DNS-only-bypass gap
(SNI proxy), stack-template coverage gaps (auto-block, richer shape), and
two minor server-side polish items.

## SNI-aware transparent proxy (phase 3)

**The biggest gap.** DNS-only filtering is bypassable. A managed container
that ignores its `--dns` setting and queries `8.8.8.8` directly, uses DNS-
over-HTTPS, or hardcodes IPs in its config completely circumvents the
gateway. v1 detect mode catches *some* of this (a managed container's
unexpected outbound UDP/53 to a non-gateway target shows up as anomalous
DNS in observed traffic), but for "treat this env as zero-trust", we need
network-level enforcement.

### Approach

1. Run a transparent proxy on the gateway container — listen on `:443` and
   `:80` (and possibly arbitrary ports later). Use `iptables` REDIRECT
   rules in the env's bridge network to send all outbound TCP/443 from
   managed containers to the gateway.
2. For TLS connections: parse the client's TLS ClientHello, extract SNI,
   match against the policy. Allow → splice the connection through to the
   real destination IP via a CONNECT-style relay. Block → close the
   connection (or send a TLS alert).
3. For HTTP/80: parse the `Host` header and apply the same matching.
4. Log every connection as a new `EgressEvent` with `protocol: 'sni'` or
   `protocol: 'http'` (the schema already has the discriminator).

### Implementation notes

- The sidecar already has the trie matcher and rule-push contract — those
  can be reused.
- The iptables rules need to apply **inside the env's bridge network
  namespace**, not the host's. Either the gateway container runs with
  `NET_ADMIN` capability and applies them itself on startup, or we use a
  small init container.
- The `egressBypass` flag still applies — bypass containers shouldn't have
  their TCP redirected. Achievable via iptables source-IP exclusions
  derived from the container map (which we already maintain).
- IPv6: TCP-level firewalling needs `ip6tables` rules. v1 is IPv4-only;
  this would extend to IPv6 if/when we cross that bridge.
- Performance: the gateway becomes an in-path proxy for all HTTPS traffic.
  A small Go or Rust binary is probably more appropriate than the current
  TypeScript implementation if throughput matters. Worth benchmarking
  before committing.

### Why it's not v1

DNS-only is enough for the "audit our SaaS dependencies" use case (the
primary detect-mode value), and a meaningful chunk of "block sketchy
egress" enforce-mode value (most apps respect their resolver). Closing the
last gap is real work, and the v1 audit data tells us whether it's needed
in practice — if observed traffic is consistently routed through the
gateway, the marginal benefit of SNI enforcement is small.

## Auto-block in `requiredEgress`

Today `requiredEgress` only emits allow rules. A template might want to
declare blocks too (e.g., a vendor SDK that we know phones home — block
its telemetry endpoints by default). Two reasonable shapes:

### Option A: prefix syntax

```json
"requiredEgress": [
  "*.googleapis.com",
  "!*.amplitude.com"
]
```

Cheap to implement; `!` prefix means block. Familiar from gitignore-style
conventions. Slight readability hit.

### Option B: structured shape

```json
"requiredEgress": [
  { "pattern": "*.googleapis.com", "action": "allow" },
  { "pattern": "*.amplitude.com",  "action": "block" }
]
```

Cleaner; aligns with the eventual richer shape (below). More verbose for
the common case.

Recommend B if we're going to do the richer shape anyway (next item),
otherwise A.

## Richer `requiredEgress` shape

Today: `requiredEgress: string[]`. Each pattern applies to the declaring
service. For more complex stacks, you might want:

```ts
interface RequiredEgressEntry {
  pattern: string;
  action?: 'allow' | 'block';
  targets?: string[];      // service names; default = the declaring service
  description?: string;    // shown in the UI's locked-rule tooltip
}
```

This subsumes auto-block (above) and adds two genuinely useful features:

- **`targets`**: shared infra services (e.g., a sidecar deployed alongside
  many app containers) can declare egress requirements that apply to *all*
  services in the stack, not just the declaring one. Today you'd have to
  duplicate the pattern in every service's `requiredEgress`.
- **`description`**: when a user sees a locked template-source rule in the
  UI, the tooltip currently just says "Managed by stack template". A
  per-rule description ("Required for Cloudflare Argo Tunnel handshake")
  would make the firewall self-documenting.

Migration: keep `string[]` accepted as a shorthand (interpreted as
`{ pattern, action: 'allow' }`), so existing templates don't break.

## Server-side polish

### Stable `EgressEvent` IDs in the live feed

`EgressLogIngester` uses `prisma.createMany`, which **doesn't return inserted
IDs** in SQLite. The socket emitter currently synthesises a placeholder
`${policyId}-${occurredAt.getTime()}` for the live-feed payload's `id`
field. The frontend doesn't rely on it as a stable key, but if we ever
want "click an event in the live feed to see its detail page", the ID has
to match what's in `egress_events`.

Fix: switch to `createManyAndReturn` (Prisma 5.14+). Already supported.
Single-line change in the ingester plus a payload mapping update. Impact:
the ingester now does an INSERT...RETURNING per batch, which is cheap.

### Single shared health-state holder

`EgressRulePusher` and `EgressContainerMapPusher` both emit
`egress:gateway:health` events, but each only knows its own version. So
the rule pusher emits `{ rulesVersion: N, appliedRulesVersion: N,
containerMapVersion: 0, appliedContainerMapVersion: null }` and the
container-map pusher emits the inverse. The frontend reconciles by taking
the latest event for each field.

This works but is fragile — if either pusher's version drifts, the
frontend shows a transient "drift" indicator until the other pusher fires.
A small per-env `EgressGatewayHealthState` holder shared by both pushers
(read latest from it, merge with the pusher's own update, emit the
merged snapshot) would eliminate the flicker. Also a good place to
periodically reconcile against `GET /admin/health` on the gateway itself.

Low priority — visible flicker is brief and only on heavy churn. Worth
doing if we ever hear a complaint.

## What's not on this list

Things that look like they should be future work but actually aren't —
included here so they're not re-discovered later:

- **Per-environment "default" policy.** The schema is per-stack only.
  Earlier design discussion considered an env-level layer (e.g., a
  blocklist of known-malicious domains applied above stack policies). If
  this is ever needed, the design notes are in the original PR
  conversation; the schema would be a new `EgressEnvironmentPolicy` table.
- **Rule history (audit log of edits).** v1 keeps `EgressEvent` per query
  but hard-deletes rules. If we ever want "who changed rule X and when",
  add a `EgressRuleHistory` append-only table. No real demand for this
  yet.
- **Multi-policy templates** ("strict / standard / open" presets). Could
  be a UI affordance over the existing rule CRUD — no schema work needed,
  just a "load template" button on the rules page.
