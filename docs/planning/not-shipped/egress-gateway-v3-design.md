# Egress Gateway v3 — Compliance-grade enforcement (design)

Status: **planned, not implemented**. Successor to v1+v2 ([#263](https://github.com/mrgeoffrich/mini-infra/pull/263)) and the design referenced in [egress-firewall-future-work.md](egress-firewall-future-work.md) under "SNI-aware transparent proxy (phase 3)". This doc captures the concrete plan for the next phase: rewriting the gateway in Go, introducing an explicit HTTP/HTTPS forward proxy for per-stack rule enforcement, and locking down all other egress at the host firewall.

An earlier sketch of v3 took a transparent-interception approach (per-managed-container sidecars sharing netns with the app, intercepting all TCP via nftables `redirect`, peeking SNI to decide). It worked but the cost was high — see [Appendix A: rejected designs](#appendix-a-rejected-designs). We're going with an explicit proxy instead.

## Posture

**Compliance-grade.** Nothing leaves a managed container without an explicit rule match. Every blocked attempt produces an `EgressEvent` row.

Concretely:

- Outbound HTTP and HTTPS from managed containers must traverse the **per-env egress gateway**. The container's `HTTP_PROXY` and `HTTPS_PROXY` env vars are injected at create time, both pointing at the same gateway port (`http://egress-gateway:3128`) — Smokescreen serves both methods on a single listener (this is the standard forward-proxy model; see [Hot path](#hot-path)). The gateway parses the destination host (from the `CONNECT` request line for HTTPS, or the absolute-URI request line / `Host` header for HTTP), matches it against the stack's policy, and either splices through to the upstream or returns `403 Forbidden`.
- DNS resolution for managed containers uses **Docker's default embedded DNS** at `127.0.0.11`. The gateway alias is resolved via Docker; external FQDNs are resolved by the proxy on the app's behalf. We do not inject a custom resolver.
- All other outbound traffic from managed containers is **dropped at the host firewall**: the only permitted egress paths from the env bridge are the gateway's proxy port, the env bridge itself (peer-to-peer between managed containers), and the loopback interface inside the container. Managed→bypass traffic on the same bridge is also dropped (closes the bypass-as-pivot path).
- Bypass containers (`egressBypass: true` in their service config) are exempt from proxy injection and from the managed-container firewall rules — they egress directly via the host. They are tracked in a `bypass-<env>` ipset so the managed-container deny rule can target them.

QUIC (UDP/443) is dropped by the firewall. Apps fall back to TCP/443 through the proxy.

### Accepted gap: container-start race window

Between the moment Docker assigns a container its IP and the moment `mini-infra-server` adds that IP to the `managed-<env>` ipset, the container is unfiltered — the `DOCKER-USER` drop rule is keyed on ipset membership and doesn't match. An app that races to egress in its first ~ms of life can reach the internet directly during that window.

We accept this gap. Closing it would mean either pre-allocating IPs and adding to the ipset before `docker start` (significant orchestration churn against Docker's IPAM) or inverting the ruleset to default-deny the env bridge subnet and explicitly allow the gateway (which complicates bypass containers and adds rule-ordering coupling). Realistic apps don't egress in their first ~ms, and a compromised image deliberately racing is a deeper threat we don't claim to defeat at the network layer.

The window is logged via the firewall agent once the container is in the ipset; further egress is filtered normally.

## Why explicit proxy, not transparent interception

Mini Infra's egress posture limits managed-container traffic to HTTP and HTTPS. Modern HTTP clients (Node, Go, Python, Java, curl, wget, browsers, most gRPC stacks) honour `HTTP_PROXY`/`HTTPS_PROXY` env vars by default. Apps that don't honour them will simply fail to egress and be loudly visible in the firewall logs — which is the right compliance fail-mode.

Given that constraint, an explicit proxy buys three big wins over transparent interception:

1. **Destination intent in plaintext.** The HTTPS `CONNECT host:port` request line carries the FQDN before any TLS happens. We don't need to peek TLS ClientHello for SNI — the app tells us where it wants to go. This is *strictly more reliable* than SNI peeking (some clients omit SNI; ESNI/ECH would defeat it; literal-IP CONNECTs are trivially caught and blocked).
2. **No per-container netns work.** No sidecars, no `--network=container:`, no shared netns lifecycle, no `nftables redirect`, no `SO_ORIGINAL_DST`, no `SO_MARK` loop avoidance, no `route_localnet` sysctl. The kernel-feature surface collapses to a small `DOCKER-USER` ipset-driven rule set on the host.
3. **Resource budget.** One ~30 MB Go process per env, vs ~300-600 MB across N sidecars in the transparent design. Roughly 10× cheaper.

The single concession: an app that deliberately ignores `HTTP_PROXY` and connects directly to a hardcoded IP gets a firewall drop event with the destination IP but no FQDN attribution. For deny-by-default the attempt is logged and blocked, which is what compliance asks for. We just don't get "the app *thought* it was reaching evil.com" in that case. Acceptable.

## Components and responsibilities

v3 introduces two new runtime components, extends `mini-infra-server` with new services, and changes how managed app containers are configured. Listed up front so the rest of the doc has a shared vocabulary.

The current `egress-sidecar/` directory becomes `egress-gateway/` — a single Go module producing **two binaries** packaged in **one image** (`mini-infra-egress-gateway`): the per-env `egress-gateway` and the host-singleton `egress-fw-agent`.

### 1. `egress-gateway` — per-env userspace proxy
*One container per environment. Unprivileged. Replaces today's TS `egress-sidecar`.*

Responsibilities:
- Terminate connections from managed containers on TCP/3128. The single listener serves both HTTP forward proxy requests (absolute-form request URI / `Host` header) and HTTPS CONNECT requests — Smokescreen handles both on one port via `goproxy`.
- Parse the destination host (absolute-form request URI / `Host` header for HTTP; `CONNECT host:port` line for HTTPS).
- Match against the env's stack-policy rule trie. Allow → splice/forward. Block → `403`.
- Resolve external FQDNs on the app's behalf when forwarding (via the gateway container's own resolver — Docker's default).
- Expose admin API for rule + container-map push from `mini-infra-server`.
- Emit NDJSON `EgressEvent`s on stdout (`evt: "tcp"`).

Non-responsibilities: doesn't touch host firewall, doesn't manage container lifecycles, doesn't read NFLOG, doesn't run a DNS server (apps use Docker's embedded DNS for the gateway alias and the proxy resolves external names), doesn't know which IPs belong to which containers (that's pushed in via the container-map).

### 2. `egress-fw-agent` — host-singleton privileged firewall agent
*One container per host. `--network=host`, `cap_add: ['NET_ADMIN', 'NET_RAW']`. New component.*

`mini-infra-server` runs in a regular Docker container with no host network access; it can't directly touch host iptables or ipsets. The fw-agent shares the host's network namespace, so when *it* runs `iptables` or `ipset`, the changes hit the host kernel. `mini-infra-server` calls the agent over a Unix socket; the agent translates a tiny well-defined API into iptables/ipset operations and validates inputs before executing.

Responsibilities:
- Maintain the per-env `DOCKER-USER` rule blocks (insert on env create, remove on env destroy, idempotent).
- Maintain ipsets per env (`managed-<env>` for managed containers, `bypass-<env>` for bypass containers); add/remove member IPs on container start/stop.
- Subscribe to NFLOG group 1, decode dropped-packet metadata, emit `evt: "fw_drop"` NDJSON on stdout.
- Reconcile host state on boot from `mini-infra-server`'s declared inventory (in case rules / ipsets were lost across host reboot).

Non-responsibilities: doesn't terminate any traffic, doesn't make policy decisions, doesn't know about FQDN rules. It's a thin executor — "apply this firewall state."

Communication: JSON-over-HTTP on a Unix socket at `/var/run/mini-infra/fw.sock`, mounted into both `mini-infra-server` (read/write client) and the agent (server). API:

```ts
POST /v1/env                          // applyEnvRules
  { env, bridgeCidr, mode: "observe" | "enforce" }
DELETE /v1/env/:env                   // removeEnvRules
POST /v1/ipset/:env/managed/add       // addManagedMember { ip }
POST /v1/ipset/:env/managed/del       // delManagedMember { ip }
POST /v1/ipset/:env/managed/sync      // syncManaged { ips: string[] } — full snapshot
POST /v1/ipset/:env/bypass/add        // addBypassMember { ip }
POST /v1/ipset/:env/bypass/del        // delBypassMember { ip }
POST /v1/ipset/:env/bypass/sync       // syncBypass { ips: string[] } — full snapshot
GET  /v1/health
```

Privilege boundary: `mini-infra-server` is a web app handling untrusted HTTP input — granting it `CAP_NET_ADMIN` directly would mean any web-layer RCE rewrites host firewall. The agent's API is narrow and validated, so the web app can't ask it to do anything ad hoc. Same pattern as Docker (privileged daemon, dumb client) and Kubernetes node agents.

**Input validation is a hard requirement.** The agent must:
- Restrict `env` to `^[a-z0-9][a-z0-9-]{0,30}$` (matches Mini Infra env name shape; no path/shell metacharacters).
- Validate `ip` against `net.ParseIP` and reject anything outside `bridgeCidr` for the named env.
- Validate `bridgeCidr` against `net.ParseCIDR` and reject anything that overlaps host or loopback.
- Invoke `iptables` / `ipset` via `exec.Command` with explicit argv arrays — **never** through a shell. No `sh -c`, no string interpolation into command lines.

The validation rules are cheap, but they are the entire trust boundary. They get unit-tested with adversarial inputs (path traversal, shell metacharacters, CIDR-of-the-host, IPv6 in IPv4 context, etc.). See [Open decisions](#open-decisions--spike-items).

### 3. `mini-infra-server` — orchestrator (existing component, new responsibilities)
*Runs as a Docker container on the same host it manages. Regular bridge network, no host netns, no `NET_ADMIN`. Mounts `/var/run/docker.sock` (existing) and now `/var/run/mini-infra/fw.sock` (new, for the fw-agent).*

The Mini Infra application itself — the web UI, REST API, schedulers, executors, and Socket.IO emitters. Same container that ships today; v3 just adds new services inside it. Still runs unprivileged, still talks to Docker via the socket, still doesn't directly touch host networking. Crucially it has no way to write iptables rules or ipsets on the host, which is *why* the fw-agent exists — to give the server a narrow, validated channel for the privileged operations it can't perform itself.

New / extended v3 services inside the server:

- `EgressRulePusher` (existing) — pushes rule snapshots to per-env gateways. Unchanged wire contract.
- `EgressContainerMapPusher` (existing) — pushes `srcIp → (stackId, serviceName)` map to per-env gateways. Unchanged.
- `EnvFirewallManager` (new) — owns the desired state of host firewall rules and ipsets. Calls `egress-fw-agent` over the Unix socket to apply changes. Hooked into env create/destroy and managed-container start/stop. Also subscribes to the Docker events stream and triggers a per-env reconcile on container `start` / `die` / `destroy` and on socket-reconnect after a Docker daemon restart, so the ipset state never diverges from running-container reality.
- `EgressLogIngester` (existing, extended) — tails NDJSON from per-env gateways and from the fw-agent. New event shapes (`evt: "tcp"`, `evt: "fw_drop"`). Writes `EgressEvent` rows.
- `stack-container-manager.ts` (existing, extended) — for managed services, additionally injects `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` env vars at create time, and notifies `EnvFirewallManager` on lifecycle transitions. For bypass services it notifies `EnvFirewallManager` to add/remove from the `bypass-<env>` ipset (so the managed→bypass deny rule covers them).

### 4. Managed app containers — config changes only
*No new code in app images.*

For non-bypass services:
- Env vars: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (plus lowercase variants). Both proxy URLs are `http://egress-gateway:3128` (single Smokescreen listener serves both methods) — Docker's embedded DNS resolves the alias.
- DNS: Docker's default (`127.0.0.11`). No injection.
- Firewall membership: the container's IP is added to `managed-<env>` ipset on start, removed on stop.

For bypass services:
- No proxy env vars injected.
- DNS: Docker's default (`127.0.0.11`). No injection (unchanged from today).
- Firewall membership: the container's IP is added to `bypass-<env>` ipset on start, removed on stop. This isn't to filter the bypass container's outbound traffic (it has none of the managed-container restrictions) — it's to let the managed-container rules deny `managed → bypass` lateral traffic on the same bridge.

### Component interaction at a glance

```
                              ┌────────────────────────────────┐
                              │ mini-infra-server              │
                              │ (regular bridge container)     │
                              │                                │
                              │  EgressRulePusher ─────────────┼──┐
                              │  EgressContainerMapPusher ─────┼──┤  HTTP/JSON to
                              │  EnvFirewallManager ───────────┼┐ │  per-env gateway
                              │  EgressLogIngester ◀───────────┼┼┐│  admin API
                              │  stack-container-manager.ts    ││││
                              └────────────────────────────────┘│││
                                                                │││
                              tails stdout from gateway + agent ││├──▶┌────────────────────┐
                                                                ││▼   │ egress-gateway     │
                              JSON-over-HTTP on /var/run/...sock││    │ (per env)          │
                                                                │▼    │  HTTP/HTTPS proxy  │
                                                       ┌────────┴────────┐ + admin API     │
                                                       │ egress-fw-agent │ NDJSON stdout   │
                                                       │ (host singleton)│                 │
                                                       │ NET_ADMIN       │ ◀── stack apply │
                                                       │                 │     manages app │
                                                       │ iptables, ipset │     containers' │
                                                       │ NFLOG reader    │     env+dns+    │
                                                       │ NDJSON stdout   │     ipset       │
                                                       └─────────────────┘     membership  │
                                                                              └────────────┘
```

## Architecture

### How traffic flows in v3

Each managed app container is configured with `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` pointing at the gateway by network alias. DNS uses Docker's default embedded resolver (`127.0.0.11`), which knows how to answer the `egress-gateway` alias and forwards external queries via the daemon (apps don't make external DNS queries themselves once the proxy is doing the resolving). The host firewall (in `DOCKER-USER`) ensures the only permitted destinations from a managed container are the env bridge subnet, minus a carve-out for bypass containers on the same bridge.

```
[ env's applications bridge network ]
  ┌─────────────────────────────────────────────────────────────────┐
  │                                                                 │
  │  ┌──────────────────┐                  ┌───────────────────────┐│
  │  │ app container    │                  │  egress-gateway       ││
  │  │                  │                  │   single listener     ││
  │  │ HTTP_PROXY=──────┼──  :3128 ───────▶│   • HTTP forward      ││
  │  │ HTTPS_PROXY=─────┼─  (same port)    │   • HTTPS CONNECT     ││
  │  │ NO_PROXY=peers   │                  │   admin API           ││
  │  │ DNS=127.0.0.11   │                  │                       ││
  │  │  (Docker default)│                  │                       ││
  │  └──────────────────┘                  └───────────┬───────────┘│
  │           │                                        │            │
  └───────────┼────────────────────────────────────────┼────────────┘
              │                                        ▼
              │                           [ bridge → host → internet ]
              ▼
   Host firewall (DOCKER-USER), evaluated in order:
     src ∈ managed-<env>, ct established/related        → ACCEPT
     src ∈ managed-<env>, dst ∈ bypass-<env>            → NFLOG + DROP  (no pivot)
     src ∈ managed-<env>, dst ∈ env-bridge CIDR         → ACCEPT        (gateway + peers)
     src ∈ managed-<env>                                → NFLOG + DROP
```

### Per container kind

| Kind | netns | DNS resolver | In `managed-<env>` ipset | In `bypass-<env>` ipset | `HTTP_PROXY` injected | TCP path |
|---|---|---|---|---|---|---|
| Managed app | own (Docker default) | Docker default (`127.0.0.11`) | yes | no | yes | via proxy → gateway → upstream |
| Bypass app | own (Docker default) | Docker default | no | yes | no | direct out via bridge → host |
| Egress-gateway | own (Docker default) | Docker default | no | no | no | direct out via bridge → host |

### Single proxy port — both methods on 3128

`HTTP_PROXY=http://egress-gateway:3128` and `HTTPS_PROXY=http://egress-gateway:3128` resolve to the same port. Smokescreen, via the embedded `goproxy` server, dispatches per-request:

- Absolute-form HTTP request (`GET http://example.com/path HTTP/1.1`) → handled by the HTTP forward path (`OnRequest().DoFunc`).
- `CONNECT host:port HTTP/1.1` → handled by the CONNECT path (`OnRequest().HandleConnectFunc`).

This is the standard forward-proxy model. Splitting into two ports would mean running two listeners that point at the same handler, which buys nothing — Smokescreen already disambiguates by method, and a malformed cross-protocol request gets the same clean error from one port as it would from two. The earlier draft of this design proposed two ports for "clarity"; verifying against the Smokescreen library showed `Config` only exposes a single `Listener`, so we're aligning with the upstream model.

### Host firewall — `DOCKER-USER` with per-env ipsets

`mini-infra-server` declares the desired firewall state via `EnvFirewallManager`; `egress-fw-agent` applies it. The rule shape below describes what ends up on the host kernel; the next subsection covers who installs each piece.

Per env, two ipsets:
- `managed-<env>` — IPs of all managed containers. Source-side match for the rule block.
- `bypass-<env>` — IPs of all bypass containers. Destination-side match for the lateral deny rule.

The gateway itself is in neither ipset; it's reachable via the bridge-CIDR ACCEPT rule like any other peer.

```
# Per-env block — installed once per env, refreshed on container churn.
# $ENV_BRIDGE_CIDR is the env applications bridge's CIDR.

# 1. Established / related (return traffic for outbound flows the gateway opened upstream
#    isn't covered by this rule because the upstream connection's source is the gateway,
#    not a managed container; this rule covers in-bridge return traffic only).
iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# 2. Block managed → bypass (closes the bypass-as-pivot path).
iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -m set --match-set bypass-<env> dst \
         -j NFLOG --nflog-group 1 --nflog-prefix "mini-infra-egress-bypass-deny "
iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -m set --match-set bypass-<env> dst -j DROP

# 3. Allow within the env bridge (managed → managed peers AND managed → gateway).
iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -d $ENV_BRIDGE_CIDR -j ACCEPT

# 4. Catch-all NFLOG + DROP for everything else from managed containers.
iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -j NFLOG --nflog-group 1 --nflog-prefix "mini-infra-egress-drop "
iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -j DROP
```

Why `DOCKER-USER`: it's the documented Docker hook for layered host policy. Rules placed there are evaluated before Docker's NAT/forwarding chains, survive Docker daemon restarts, and don't fight Docker's own management. ipsets work uniformly under `iptables-legacy` and `iptables-nft`, which covers Linux native, Colima (VM), and WSL2.

#### Platform availability — Colima ✅ verified, WSL2 to verify

**Colima 0.10.1 (default Ubuntu 24.04 VM, kernel 6.8.0-100-generic, on macOS).** Verified on 2026-04-29:

| Requirement | State |
|---|---|
| `xt_set` kernel module | Pre-loaded |
| `ip_set` kernel module | Pre-loaded |
| `nfnetlink_log` kernel module | Available; loads cleanly via `modprobe nfnetlink_log` |
| `iptables` | v1.8.10, `nf_tables` backend |
| `DOCKER-USER` chain | Present, hooked into `FORWARD` chain |
| NFLOG target with `--nflog-group N --nflog-prefix "…"` | Accepted |
| `iptables -m set --match-set <name> src/dst` | Works |
| `ipset` userspace binary | **Not installed by default**; available via `apt install -y ipset` (Ubuntu universe `7.19-1ubuntu2`) |
| `libnetfilter-log1` (for the agent's NFLOG subscriber) | **Not installed by default**; available via `apt install -y libnetfilter-log1` (Ubuntu universe `1.0.2-4build1`) |

The two missing userspace pieces are bundled in `mini-infra/egress-gateway:<version>`'s base image (per [Container deployment](#host-singleton-egress-fw-agent)) — the agent runs `--network=host` with `NET_ADMIN`/`NET_RAW`, so its bundled `ipset` / `iptables` / `libnetfilter_log` binaries operate against the VM kernel directly. No host-side `apt install` step is required of the operator.

**WSL2 — still to verify.** WSL2 distros vary by user choice (Ubuntu, Debian, Alpine, etc.) and kernel module availability has historically been thinner than on Colima. The same `apt install` (or equivalent) approach should work where the WSL2 kernel ships `xt_set`/`nfnetlink_log`, but this needs a one-off check on the canonical WSL2 base we ship — see [Open decisions](#open-decisions--spike-items).

#### Who installs what

| Action | Trigger | Server-side caller | Agent operation |
|---|---|---|---|
| Insert per-env rule block + create ipsets | env created | `EnvFirewallManager.applyEnv()` | `POST /v1/env` → `ipset create managed-<env>`, `ipset create bypass-<env>`, `iptables -A DOCKER-USER ...` |
| Remove per-env rule block + destroy ipsets | env destroyed | `EnvFirewallManager.removeEnv()` | `DELETE /v1/env/:env` → `iptables -D DOCKER-USER ...`, `ipset destroy managed-<env>`, `ipset destroy bypass-<env>` |
| Add IP to managed ipset | managed container started | `stack-container-manager.ts` post-start hook | `POST /v1/ipset/:env/managed/add` → `ipset add managed-<env> <ip>` |
| Add IP to bypass ipset | bypass container started | `stack-container-manager.ts` post-start hook | `POST /v1/ipset/:env/bypass/add` → `ipset add bypass-<env> <ip>` |
| Remove IP from ipset | container stopped | `stack-container-manager.ts` post-stop hook | `POST /v1/ipset/:env/{managed\|bypass}/del` → `ipset del` |
| Full ipset reconcile | server boot, Docker daemon reconnect, host reboot | `EnvFirewallManager.reconcile()` | `POST /v1/ipset/:env/{managed\|bypass}/sync` → `ipset restore` |
| Mode flip (observe ↔ enforce) | feature flag toggled | `EnvFirewallManager.setMode()` | `POST /v1/env` with new mode (atomically replaces the env's rule block) |
| Event-driven reconcile | Docker container `start` / `die` / `destroy` events | `EnvFirewallManager` Docker-events listener | per-event ipset add/del calls, idempotent against current kernel state |

The server holds the *desired state* (in DB / in-memory). The agent is stateless apart from the host kernel state it manages — on boot it accepts a full reconcile from the server. Removing a container from the ipset is sufficient to revoke its egress without modifying any iptables rule.

**Docker daemon restart handling.** `EnvFirewallManager` subscribes to the Docker events stream via `dockerode`. On any `start` / `die` / `destroy` event for a container in a managed env, it computes the desired ipset delta and pushes it to the agent. On socket disconnect (daemon restart) it triggers a full reconcile across all envs once the connection is re-established — IP assignments may have changed, so a delta isn't enough. The reconcile path is the same as boot: snapshot all env containers from Docker, push full ipset state to the agent.

### The gateway

One container per env. Hosts:

- **Proxy listener** (TCP/3128) — single port serving both forward-proxy methods via Smokescreen + `goproxy`:
  - Absolute-URI HTTP requests → parses `Host`, applies stack policy, forwards. Blocked → `403`.
  - `CONNECT host:port` → applies stack policy, dials upstream, bidirectionally splices the sockets (TLS happens end-to-end; gateway never sees plaintext). Blocked → `403` before the tunnel opens.
- **Admin API** (private port) — `POST /admin/rules`, `POST /admin/container-map`, `GET /admin/health`. Same wire contract as today, plus listener-up booleans on health.

No `cap_add`, no sysctls, no privileged operations. The gateway is a plain user-space TCP server.

The gateway is reachable from managed apps by network alias (`egress-gateway`) — Docker's embedded DNS resolves the alias against whichever IP the gateway currently holds on the env bridge. This means the gateway's IP doesn't need to be pinned: a recreate that changes the IP is invisible to apps as long as the alias is stable.

**Operational contract — gateway upgrade is a per-env outage.** Replacing the gateway image (e.g. on Mini Infra self-update) tears down and recreates the per-env gateway container. During the swap (~1-5s) all proxied egress fails. We accept this as the operational contract: gateway upgrades are infrequent, the failure mode is loud and obvious to apps, and the alternative (blue/green per-env gateways with traffic handover) costs significantly more complexity for a rare event. Operators are notified in the UI when an upgrade is going to bounce per-env gateways.

### DNS path

Apps use Docker's default embedded resolver at `127.0.0.11`. That resolver:
- Knows the `egress-gateway` alias from the bridge's network metadata, so `HTTP_PROXY=http://egress-gateway:3128` resolves correctly without any custom DNS injection.
- Knows other container names on the same bridge, so peer-to-peer DNS works for free.
- Forwards external queries to the daemon's configured upstream resolver. Apps don't need to make their own external DNS queries because the proxy resolves external FQDNs on their behalf when forwarding requests.

The firewall does not allow port 53 outbound from managed containers — Docker's embedded DNS lives on container loopback and doesn't traverse the bridge, so it isn't subject to the rule block. Any app that ignores the embedded resolver and tries to reach an external resolver directly (`dig @8.8.8.8 …`) hits the catch-all DROP rule and is logged as `fw_drop`.

There is no FQDN-time DNS log on the gateway any more (we removed the dedicated DNS server). FQDN attribution comes solely from the proxy's `tcp` events. **Limitation:** apps that hardcode an IP and skip DNS entirely produce `fw_drop` events with `destIp` only — no FQDN. This was already an accepted limitation in the proxy-only posture; removing the DNS layer doesn't make it worse, but it does mean the previous DNS-time "the app tried to look up evil.com" log isn't available either.

DoH leak (`dns.google`, `cloudflare-dns.com` over CONNECT to :443) is still captured by the proxy as a `connect` event — the FQDN is on the CONNECT request line, so a built-in DoH-domains denylist applied before stack policy catches these regardless of stack rules. Same mechanism for `8.8.8.8:443` literal-IP CONNECT (the IP-literal block in the CONNECT handler covers it).

### Bypass services

Under v3, `egressBypass: true` on a service:

- Skips `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` env injection.
- Adds the container IP to **`bypass-<env>` ipset** (new in v3) — used as the destination match for the lateral deny rule against managed containers.
- Skips `managed-<env>` ipset membership — so the catch-all drop rule doesn't apply to its outbound traffic.
- Skips DNS injection (unchanged from today; uses Docker's default).

Bypass containers egress directly via Docker's normal forwarding. They live on the same env bridge as managed containers, but managed→bypass lateral traffic is denied by the firewall (closes the bypass-as-pivot path described in the posture). Bypass→managed and bypass→external traffic is unrestricted, on the basis that bypass is an explicit operator opt-in and the operator is trusted to vet what they put there.

## Hot path

The proxy is built on **[Stripe's Smokescreen](https://github.com/stripe/smokescreen) imported as a Go library**, with a thin wrapper for our admin API, container-map identification, and NDJSON event shape. Smokescreen handles CONNECT parsing, hop-by-hop scrubbing, splice loop, IP-range validation, DNS-rebind defence (resolve-and-dial-the-IP), policy modes, and SSRF hardening — all production-tested in Stripe's egress path. We get the security primitives for free and own only the parts that are specific to Mini Infra.

Smokescreen-as-binary is configured by YAML and reloads on SIGHUP. Smokescreen-as-library exposes everything as configurable fields/interfaces on `smokescreen.Config`, so we never touch a YAML file.

> ✅ **Verified against `github.com/stripe/smokescreen` at commit `7d45971` (post-PR #286).** The capabilities this design depends on were checked in source on 2026-04-29. Pinning expectations:
> - `smokescreen.Config` is constructed programmatically via `NewConfig()`, with all fields exported and settable. No YAML required.
> - `EgressACL` is `acl.Decider` — a one-method interface (`Decide(args acl.DecideArgs) (acl.Decision, error)`) called per-request, ideal for an `atomic.Pointer`-backed swap.
> - `RoleFromRequest` is `func(*http.Request) (string, error)` — exact shape we want.
> - `Log *logrus.Logger` is settable; we attach a hook to translate to NDJSON.
> - `Listener net.Listener` is settable; one listener serves both HTTP forward and HTTPS CONNECT (via the embedded `goproxy.ProxyHttpServer`).
> - `DenyRanges` is `[]smokescreen.RuleRange{Net net.IPNet, Port int}` — slightly different from the `[]net.IPNet` shape this doc previously claimed, same semantic.
> - **We do _not_ call `smokescreen.StartWithConfig(...)`.** It installs `signal.Notify(SIGUSR2, SIGTERM, SIGHUP)` on our process. We instead call `proxy := smokescreen.BuildProxy(cfg)` and run our own `http.Server{Handler: proxy}` so we own the lifecycle and signals.
> - **We do _not_ replace `ConnTracker`.** The `TrackerInterface` has 7 methods coupled to Smokescreen's internal `*InstrumentedConn`; re-implementing it would mean re-implementing connection tracking. Byte counts come instead from Smokescreen's existing `CANONICAL-PROXY-CN-CLOSE` / `CANONICAL-PROXY-DECISION` log entries (which include `bytes_in`/`bytes_out`), captured by our `logrus.Hook`.

### Wrapper responsibilities

The Go wrapper provides Smokescreen with four things, plus runs the listener loop itself:

1. **`RoleFromRequest`** — function pointer (`func(*http.Request) (string, error)`) that maps the source IP of an inbound request to `(stackId, serviceName)` via our container map. Smokescreen's role-based ACL keys off this.
2. **`EgressACL`** — `acl.Decider` interface implementation backed by an `atomic.Pointer[*acl.ACL]` for lock-free runtime swap. Admin-API rule push compiles a new ACL and atomically replaces the pointer; in-flight requests keep using the old ACL until they complete.
3. **`Log`** — `logrus.Logger` with a custom hook that translates each log entry to our NDJSON `EgressEvent` shape on stdout. The hook also extracts `bytes_in`/`bytes_out` from Smokescreen's `CANONICAL-PROXY-CN-CLOSE` entries, so we don't need to replace `ConnTracker`.
4. **`DenyRanges`** — `[]smokescreen.RuleRange` pre-populated with RFC1918, loopback, link-local (incl. `169.254.169.254` cloud metadata), IPv6 ULA, multicast. Note `UnsafeAllowPrivateRanges` is left at its default `false`, so private/loopback are denied automatically by Smokescreen's `classifyAddr`; explicit `DenyRanges` entries cover what `classifyAddr` doesn't.

We additionally:
- Run a **pre-ACL DoH denylist gate** because Smokescreen doesn't ship one and the DoH leak vector is in scope for our compliance posture.
- Construct our own `http.Server{Handler: smokescreen.BuildProxy(cfg)}` instead of calling `StartWithConfig` (which would install signal handlers we don't want).

### `cmd/gateway/main.go` (sketch)

```go
func main() {
    srv := newServer(loadConfig())

    sk := smokescreen.NewConfig()
    sk.RoleFromRequest = srv.roleFromRequest         // srcIP → stackId via container map
    sk.EgressACL = srv.aclSwapper                    // acl.Decider with atomic.Pointer indirection
    sk.DenyRanges = builtinPrivateRanges()           // []smokescreen.RuleRange — RFC1918, link-local, ULA, …
    sk.ConnectTimeout = 10 * time.Second
    sk.Log = newLogrusToNDJSON(srv.events)           // logrus hook → NDJSON on stdout
                                                     // (also extracts bytes_in/out from
                                                     //  CANONICAL-PROXY-CN-CLOSE entries)
    sk.AdditionalErrorMessageOnDeny = "egress denied by mini-infra policy; see UI"

    // Build the goproxy-based handler. Smokescreen serves both HTTP forward
    // and HTTPS CONNECT on this single handler; we own the http.Server.
    proxy := smokescreen.BuildProxy(sk)

    // Pre-ACL DoH gate wraps the proxy so DoH endpoints are 403'd
    // before they reach Smokescreen's ACL.
    handler := srv.dohGateMiddleware(proxy)

    server := &http.Server{
        Addr:              ":3128",
        Handler:           handler,
        ReadHeaderTimeout: 30 * time.Second,
    }

    go srv.runAdminAPI(srv.aclSwapper)               // /admin/rules → swapper.Swap(newACL)
    go srv.runHealthEndpoint()

    // Our own signal handling — not Smokescreen's.
    go srv.gracefulShutdownOn(syscall.SIGTERM, server)

    if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
        log.Fatal(err)
    }
}
```

### Atomic ACL swap

Smokescreen calls `config.EgressACL.Decide(args)` per request ([smokescreen.go:1384](https://github.com/stripe/smokescreen/blob/7d45971/pkg/smokescreen/smokescreen.go#L1384)). Our wrapper implements `acl.Decider` with an atomic-pointer indirection:

```go
type ACLSwapper struct {
    p atomic.Pointer[acl.ACL]
}

// Decide implements acl.Decider.
func (s *ACLSwapper) Decide(args acl.DecideArgs) (acl.Decision, error) {
    return s.p.Load().Decide(args)
}

// Swap is called by the admin API on /admin/rules push.
func (s *ACLSwapper) Swap(newACL *acl.ACL) {
    s.p.Store(newACL)
}
```

The wrapped `*acl.ACL` is built from our `StackPolicy` snapshot via a small compiler in `internal/proxy/compile.go` (FQDN globs + per-stack rules → `*acl.ACL`). Lock-free per-request reads; admin pushes are O(1) atomic stores.

Note that `DecideArgs` carries `{Req *http.Request, Service, Host, ConnectProxyHost string}` — no port. Per-port enforcement (where we want it) lives in `Config.DenyRanges`/`AllowRanges`, which Smokescreen evaluates at dial time after the ACL allows the destination.

### Role identification

```go
func (srv *Server) roleFromRequest(r *http.Request) (string, error) {
    src := remoteIP(r)
    attr := srv.containers.Lookup(src)
    if attr == nil {
        return "", smokescreen.MissingRoleError("unknown source")
        // returning a MissingRoleError lets Smokescreen produce a clean 403 with
        // our AdditionalErrorMessageOnDeny appended.
    }
    return attr.StackID, nil    // role keyed by stackId; ACL has per-stack allowlists
}
```

For CONNECT, Smokescreen makes the same call against the synthetic `http.Request` it constructs from the CONNECT line.

### What we leave to Smokescreen (do not reimplement)

- CONNECT request line parse, header drain, hop-by-hop header scrub.
- Splice loop with proper half-close handling.
- `SafeResolve` (resolve-once, reject internal IPs, dial the resolved IP) — the SSRF and DNS-rebinding defences.
- Three-mode policy enforcement (`open` / `report` / `enforce`) per role.
- Hostname globbing (`*.example.com`) semantics.
- Literal-IP CONNECT block (default deny).
- TLS-ish error responses with body explaining the deny reason.

### What we add on top (because Smokescreen doesn't have it)

- DoH denylist gate (pre-ACL, blocks known DoH endpoints regardless of stack rules).
- Admin API for rule + container-map push.
- NDJSON event shape consistent with the rest of Mini Infra.
- Container-map identity model (srcIP-keyed instead of TLS-cert/proxy-auth).

### Container map

The gateway needs `srcIp → (stackId, serviceName)` to attribute events per stack. This is identical to today's TS DNS gateway — server pushes `POST /admin/container-map` (full snapshot) on env change. Same wire format, reused for both DNS and proxy listeners.

## Logging — full visibility

NDJSON on stdout, ingested by the existing `EgressLogIngester`. Three event shapes, two from the gateway and one from the host-side NFLOG reader. The DNS event shape from v1+v2 is removed in v3 (we no longer run a DNS server in the gateway).

```jsonc
// HTTPS CONNECT (gateway, new)
{ "evt": "tcp", "protocol": "connect", "ts": "...", "srcIp": "...",
  "target": "api.example.com:443",
  "action": "allowed|blocked",
  "reason": "rule-deny|ip-literal|doh-denied|dial-failed|...",
  "matchedPattern": "*.example.com",
  "stackId": "...", "serviceName": "...",
  "bytesUp": 0, "bytesDown": 0, "mergedHits": 1 }

// HTTP forward proxy (gateway, new)
{ "evt": "tcp", "protocol": "http", "ts": "...", "srcIp": "...",
  "method": "GET", "target": "example.com", "path": "/some/path",
  "action": "allowed|blocked",
  "reason": "rule-deny|ip-literal|...",
  "matchedPattern": "*.example.com",
  "stackId": "...", "serviceName": "...",
  "status": 200, "bytesDown": 1234, "mergedHits": 1 }

// Firewall drop (egress-fw-agent, new). Distinguishes between
// `non-allowed-egress` (the catch-all DROP) and `lateral-bypass-deny`
// (managed → bypass denial) so events surface with the right context.
{ "evt": "fw_drop", "protocol": "tcp|udp|icmp", "ts": "...",
  "srcIp": "...", "destIp": "...", "destPort": 5432,
  "stackId": "...", "serviceName": "...",
  "reason": "non-allowed-egress|lateral-bypass-deny", "mergedHits": 1 }
```

Dedup window: 60s, key `srcIp + destIp + destPort + protocol`. `srcIp` is included so two different containers hitting the same destination produce two events with correct attribution rather than collapsing into one.

`fw_drop` events come from `egress-fw-agent`'s NFLOG subscriber (libnetfilter_log on group 1). It sees the source IP and looks up `(stackId, serviceName)` via a container-map snapshot pushed from `mini-infra-server` (same shape as the per-env gateway gets, but a flat union across all envs since the agent is per-host).

## Wire contract

Server pushes to **one admin endpoint per env** (the gateway). No fanout, no per-stack subsetting — the gateway holds the full env policy and applies it per-source-IP via the container map.

```ts
POST /admin/rules           // full env policy snapshot
POST /admin/container-map   // srcIp → (stackId, serviceName) snapshot
GET  /admin/health
```

Health response gains listener-up booleans:

```ts
interface GatewayHealthResponse {
  ok: true;
  rulesVersion: number;
  uptimeSeconds: number;
  listeners: {
    proxy: boolean;     // 3128 — serves both HTTP forward and HTTPS CONNECT
    admin: boolean;
  };
}
```

Discovery is unchanged from today — server finds the per-env gateway by container label `mini-infra.egress.gateway=true` + `mini-infra.environment=<env>`.

## Container env injection

For every managed (non-bypass) service, `stack-container-manager.ts` injects:

```
HTTP_PROXY=http://egress-gateway:3128
HTTPS_PROXY=http://egress-gateway:3128
http_proxy=http://egress-gateway:3128
https_proxy=http://egress-gateway:3128
NO_PROXY=localhost,127.0.0.0/8,<envBridgeCidr>
no_proxy=localhost,127.0.0.0/8,<envBridgeCidr>
```

Both env vars point at the same port — Smokescreen serves both HTTP forward and HTTPS CONNECT on a single listener. Both upper- and lowercase variants because Node honours uppercase, Python `requests` honours lowercase, Go honours both. The `egress-gateway` hostname resolves via Docker's embedded DNS (the gateway container runs with `--network-alias=egress-gateway`), so the gateway's IP can change across recreates without rebaking app env vars. `NO_PROXY` lists the env bridge CIDR so peer-to-peer traffic doesn't loop through the proxy. No `HostConfig.Dns` is set — apps use Docker's default `127.0.0.11` resolver.

**Limitation: `NO_PROXY` env-var staleness.** Docker env vars are immutable on a running container. If we additionally inject peer container *names* into `NO_PROXY` (for libraries that do suffix-only matching, not CIDR), that list is baked at the container's create time. New peers added after create won't appear in existing containers' `NO_PROXY`, and their requests will be sent through the proxy. The proxy will still allow these (intra-bridge destinations match the bypass-bridge-CIDR fast-path inside the ACL), but it adds a hop and may matter for high-throughput peer comms.

Mitigations we accept:
- Document this as a known limitation.
- For most languages we work with (Node, Go, Python `httpx`, Java 11+), CIDR matching is supported in `NO_PROXY`, so the env bridge CIDR alone is sufficient — peer-name lists are only needed for laggard libraries (older Python `requests`, some Ruby HTTP clients).
- For envs where peer churn matters and a laggard library is in use, recommend a stack-level recreate after adding new peers, or recommend using a CIDR-aware HTTP client.

We do **not** plan to dynamically update `NO_PROXY` on running containers — Docker doesn't support it, and the workaround (recreate the container) is more expensive than the limitation.

## Go module design

Two binaries, one image, one Go module. The gateway imports `github.com/stripe/smokescreen` as a library and stays small; the agent is fully ours.

```
egress-gateway/
  cmd/
    gateway/main.go                   # smokescreen wiring + our wrapper (~150 lines)
    fw-agent/main.go                  # host-singleton fw-agent entry

  internal/
    # shared
    config/        gateway_config.go  # gateway env-var binding
                   agent_config.go    # agent env-var binding
    events/        emitter.go         # NDJSON stdout writer
                   dedup.go           # 60s dedup window
    log/           log.go             # slog wrapper, JSON handler

    # gateway only — our wrapper around smokescreen
    state/         rules.go           # rule trie + version state
                   container_map.go   # srcIp → (stackId, serviceName)
    proxy/         aclswap.go         # acl.Decider impl with atomic.Pointer[*acl.ACL]
                   role.go            # RoleFromRequest impl (srcIP → stackId)
                   logadapter.go      # logrus hook → NDJSON EgressEvent
                                      #  (incl. bytes_in/out extraction from
                                      #   CANONICAL-PROXY-CN-CLOSE entries)
                   doh_gate.go        # pre-ACL DoH denylist http.Handler middleware
                   compile.go         # StackPolicy → *acl.ACL
                   ipranges.go        # built-in private/loopback/link-local CIDRs
    admin/         server.go          # /admin/rules, /admin/container-map, /admin/health
                   validate.go

    # agent only
    fw/            iptables.go        # `DOCKER-USER` rule block install/remove
                   ipset.go           # ipset create/destroy/add/del/sync
                   nflog.go           # libnetfilter_log subscriber → fw_drop events
                   api.go             # unix-socket HTTP server (POST /v1/env, /v1/ipset/...)
                   reconcile.go       # boot-time reconcile against server-declared inventory

  Dockerfile                          # multi-stage; both binaries in one image
  go.mod                              # imports github.com/stripe/smokescreen
  go.sum
```

Notable: there is no `proxy/http.go`, `proxy/connect.go`, `proxy/splice.go`, `proxy/safe_resolve.go`, or `proxy/safe_dial.go` — all of that lives in `smokescreen`. The wrapper exists to plug Mini-Infra-specific concerns (identity, rule-push, log shape, DoH gate) into Smokescreen's `Config`.

Multi-stage build: `golang:1.22-alpine` builder, `alpine:3.19` runtime with `iptables`, `ipset`, and `libnetfilter_log` packages. Single image, both binaries available at `/usr/local/bin/egress-gateway` and `/usr/local/bin/egress-fw-agent`. Final image ~25 MB (Smokescreen adds a few MB to the gateway binary).

## Container deployment

Three container types involved, two of them new for v3.

### Per-env `egress-gateway`
*Lifecycle: created/destroyed by `EnvironmentManager` alongside the env. One per env.*

- `image: mini-infra/egress-gateway:<version>`
- `entrypoint: ["/usr/local/bin/egress-gateway"]`
- Joins the env's applications network with `--network-alias=egress-gateway` (no pinned IP — Docker's embedded DNS resolves the alias)
- Labels: `mini-infra.egress.gateway=true`, `mini-infra.environment=<env>`
- Env vars: `PROXY_PORT=3128`, `LOG_LEVEL`
- No `cap_add`, no sysctls, no host network access

### Host-singleton `egress-fw-agent`
*Lifecycle: brought up alongside `mini-infra-server` itself, in the same compose definition. One per host. Restart policy `unless-stopped`.*

- `image: mini-infra/egress-gateway:<version>` (same image, different binary)
- `entrypoint: ["/usr/local/bin/egress-fw-agent"]`
- `network: host`
- `cap_add: ['NET_ADMIN', 'NET_RAW']`
- Volume mounts:
  - `/var/run/mini-infra/` (host) ↔ `/var/run/mini-infra/` (container) — shared with `mini-infra-server`, agent binds the Unix socket here
  - `/lib/modules/` (host, read-only) — for kernel module access if `nf_log_ipv4`/`xt_set` need loading
- Labels: `mini-infra.egress.fw-agent=true`
- Env vars: `LOG_LEVEL`

### `mini-infra-server` deployment changes
*Existing component, new mount only.*

- New volume mount: `/var/run/mini-infra/` so it can connect to the agent's Unix socket
- No new capabilities, no new network changes — still a regular bridge container

### App container spec changes

For **managed** (non-bypass) services:
- Inject `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` env vars (above) using the `egress-gateway` alias.
- No DNS injection — Docker's default `127.0.0.11` resolver is used.
- After Docker assigns the container's IP and it transitions to `Running`, `stack-container-manager.ts` calls `EnvFirewallManager.addManagedContainer()`, which calls the agent to add the IP to `managed-<env>`.

For **bypass** services:
- No proxy env injection, no DNS injection.
- After Docker assigns the IP and the container transitions to `Running`, `stack-container-manager.ts` calls `EnvFirewallManager.addBypassContainer()`, which calls the agent to add the IP to `bypass-<env>` so the lateral-deny rule matches.

The gateway itself: in neither ipset, no env-var injection, no `addContainer` call. It's reachable from managed containers via the bridge-CIDR ACCEPT rule.

## Server-side changes

Three landable PRs.

### PR 1 — Schema + ingester
- Update `EgressLogIngester` to parse the new event shapes (`evt: "tcp"` with `protocol: "connect|http"`, `evt: "fw_drop"`).
- Add `target`, `method`, `path`, `status`, `bytesUp`, `bytesDown`, `destIp`, `destPort` columns to `EgressEvent` (Prisma migration). Null on DNS-only events.
- Tail `mini-infra.egress.fw-agent=true` containers in addition to `mini-infra.egress.gateway=true`.
- Tests: extend `egress-log-ingester.test.ts` with fixtures for each new event shape.
- Ships independently; new columns null on DNS-only events.

### PR 2 — Go module + `egress-fw-agent` deployment
- New `egress-gateway/` Go module with both binaries (gateway + fw-agent). Initially only the fw-agent code path is exercised; gateway code lands but isn't deployed yet.
- New deployment of `egress-fw-agent` as a host-singleton container in the Mini Infra compose definition. Volume mount for `/var/run/mini-infra/` shared with `mini-infra-server`.
- New `EnvFirewallManager` service in `mini-infra-server`:
  - Declares desired firewall state, calls fw-agent over the Unix socket.
  - Owns reconcile loop on server boot **and** on Docker daemon reconnect.
  - Subscribes to Docker events stream for per-container `start` / `die` / `destroy` and pushes ipset deltas to the agent.
- ipset membership wired into container start/stop hooks in `stack-container-manager.ts` for both managed and bypass services (`managed-<env>` and `bypass-<env>` respectively).
- NFLOG reader inside the agent emits `fw_drop` NDJSON (with separate `reason` values for catch-all DROP vs lateral-bypass-deny); ingester (PR 1) picks it up.
- Hard input validation in the agent: env names (`^[a-z0-9][a-z0-9-]{0,30}$`), IPs (within declared bridge CIDR), CIDRs (no host/loopback overlap), `iptables`/`ipset` invoked with explicit argv (no shell). Adversarial-input unit tests are required.
- Ships behind a per-env feature flag — agent is deployed and managing rules but the `DROP` line is gated. Initial mode is **observe** (NFLOG without DROP) for opted-in envs.
- Tests: integration tests with a temporary iptables ruleset and a real fw-agent in a Linux container, ensure rules and ipset entries are inserted/removed correctly across env churn, Docker daemon restarts, and agent restarts.

### PR 3 — `egress-gateway` deployment + env injection
- Add `github.com/stripe/smokescreen` (pinned to a commit ≥ `7d45971`) to the gateway module's `go.mod`.
- Implement the wrapper (`internal/proxy/`): `ACLSwapper` (atomic.Pointer[*acl.ACL]), `roleFromRequest`, `logadapter` (translates Smokescreen logrus entries to NDJSON, including `bytes_in`/`bytes_out` from `CANONICAL-PROXY-CN-CLOSE`), `dohGateMiddleware`, `compile`. `cmd/gateway/main.go` constructs `smokescreen.Config`, calls `BuildProxy(cfg)`, and runs the result under our own `http.Server` on `:3128` — **not** `StartWithConfig` (which would install signal handlers we don't want).
- `EnvironmentManager` swaps the TS `egress-sidecar` for the Go `egress-gateway` image (same per-env container, just different binary in the existing slot). The gateway runs with `--network-alias=egress-gateway` on the env bridge.
- `stack-container-manager.ts` injects `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (both proxy URLs `http://egress-gateway:3128` — single port) for managed services; bypass + host-level + non-environment stacks skip this entirely (mirrors the existing `egressBypass` skip pattern). DNS injection is removed for both managed and bypass — Docker's default applies.
- `EgressRulePusher` continues to push to one endpoint per env. The gateway compiles the snapshot to an `*acl.ACL` and atomically swaps via `ACLSwapper.Swap()`.
- Gateway initially runs in Smokescreen's `report` mode (allows everything, logs decisions) when the per-env flag is flipped ON.
- Tests: integration tests against a real Smokescreen-backed gateway with stub container map, validate rule swap atomicity under concurrent in-flight requests, validate SSRF defences via Smokescreen's existing `classifyAddr` path, validate `egress-gateway` alias resolution from a peer container.
- Land behind the same per-env feature flag introduced in PR 2.

## Phasing / rollout

1. **PR 1** (schema + ingester) — lands independently, no behaviour change.
2. **PR 2** (Go module + fw-agent + firewall manager) — fw-agent deployed, rules and ipsets managed for opted-in envs. Default OFF per env; opted-in envs in **observe mode** (NFLOG, no DROP). Validates ipset membership tracking, agent reconcile, NFLOG event flow.
3. **PR 3** (gateway + env injection) — when the per-env flag is flipped ON: gateway image deployed in place of the TS sidecar, `HTTP_PROXY`/`HTTPS_PROXY` injected on next container recreate, gateway in **detect mode forced** (allows everything, logs decisions).
4. **Per-env enforce promotion.** Flip enforce mode on the gateway → 403s on rule-deny. Flip the firewall agent to enforce mode → drops direct egress. Both flips are independent so we can stage. The promote-to-Enforce wizard from v2 handles per-stack progression.
5. **Phase out the TS sidecar.** Once all envs run v3, delete `egress-sidecar/`.

## Open decisions / spike items

- **Smokescreen library API surface — verified.** ✅ Checked against `github.com/stripe/smokescreen` at commit `7d45971` (post-PR #286) on 2026-04-29. `Config` is constructed programmatically; `EgressACL` (`acl.Decider`) is a one-method interface called per-request, ideal for atomic-pointer swap; `RoleFromRequest`, `Log`, `DenyRanges` (as `[]RuleRange`), `Listener` are all settable; `BuildProxy(cfg)` returns the `goproxy.ProxyHttpServer` handler that serves both HTTP-forward and HTTPS CONNECT on a single listener. Findings rolled into [Hot path](#hot-path), [Wrapper responsibilities](#wrapper-responsibilities), and the [main.go sketch](#cmdgatewaymaingo-sketch).
- **`ipset` / `xt_set` / `nfnetlink_log` availability — Colima ✅ verified (2026-04-29), WSL2 still to verify.**
  - Colima 0.10.1 / Ubuntu 24.04 / kernel 6.8.0-100-generic: `xt_set`+`ip_set` pre-loaded, `nfnetlink_log` loadable via `modprobe`, NFLOG iptables target works, `match-set` works, `DOCKER-USER` chain present. `ipset` and `libnetfilter-log1` are not installed by default but install cleanly from the standard Ubuntu universe repo. We bundle these binaries into the fw-agent's image so no operator-side install step is needed. Findings in [Platform availability](#platform-availability--colima--verified-wsl2-to-verify).
  - **WSL2 — still to verify.** Need to confirm the same modules + binaries are available on the WSL2 base distro we use, since WSL2 kernel surfaces have historically been thinner. One-off check during PR 2.
- **Authenticated proxy?** Default to no auth — the network reachability boundary (only the env bridge can reach the gateway) is the auth. If we ever support multi-tenant envs, revisit.
- **WebSocket through CONNECT.** WSS is HTTPS upgrade and goes through CONNECT fine. Plain WS over HTTP traverses the HTTP forward proxy, which honours `Connection: Upgrade` correctly with `httputil.ReverseProxy` — verify with a fixture during the PR 3 spike (it's a property of whichever HTTP-forward implementation we use, including Smokescreen's if it has one).
- **`NO_PROXY` exhaustiveness — accepted as a documented limitation.** CIDR matching covers Node, Go, Python `httpx`, Java 11+. Older Python `requests`, some Ruby clients, and a few JVM legacy stacks do suffix-only matching and won't match the env bridge CIDR. Documented in [Container env injection](#container-env-injection); operators get the limitation in the UI when an app surfaces unexpected proxy hops.
- **Apps that don't honour `HTTP_PROXY`.** Document the failure mode in the operator UI: a service that egresses directly will produce `fw_drop` events; surface these prominently with a "mark as bypass or fix the client" call to action.
- **`fw-agent` input validation rules — accepted as a documented requirement.** Listed in §[`egress-fw-agent`](#2-egress-fw-agent--host-singleton-privileged-firewall-agent). The whole privilege boundary depends on these checks holding; adversarial-input unit tests are part of PR 2's acceptance criteria.
- **fw-agent ↔ server outage handling.** If the agent is down, in-flight ipset updates queue in `EnvFirewallManager` and a degraded-component banner surfaces in the UI. Existing rules are untouched (kernel state outlives the agent). On agent recovery, drain the queue and run a full reconcile. Decide the queue cap and what to do on overflow (probably: drop oldest, log loudly).
- **Rule reload performance.** ipset membership churn during container start/stop must be sub-100ms to avoid stack-apply slowdown. ipset is in-kernel and fast; benchmark with 50 containers/env.
- **Resource budget.** Per env: ~30 MB RSS for gateway. Per host: ~10 MB for fw-agent. So ~30 MB per env + ~10 MB host-wide — vs ~325-625 MB in the rejected sidecar design. ~10× win.
- **IPv6.** v1+v2 are IPv4-only; v3 mirrors that. ipsets and `DOCKER-USER` work in IPv6 too; need dual-stack listeners and an ipv6 ipset when we cross that bridge.

## Accepted limitations (documented, not mitigated)

These are known-and-accepted in v3. They're called out so the trade-off is visible to operators and isn't mistaken for a design oversight.

- **Container-start race window.** Between `docker start` (container has IP, app code may begin running) and the post-start ipset add, the container is unfiltered. Apps that race to egress in their first ~ms get out. Closing the gap requires intrusive changes to Docker's IPAM flow or an inverted ruleset; we don't pay that cost. See [Posture → Accepted gap](#accepted-gap-container-start-race-window).
- **Literal-IP egress lacks FQDN attribution.** `fw_drop` events include `destIp` but not the FQDN the app *thought* it was reaching, because we no longer run a DNS server in the gateway and apps that hardcode IPs never asked the resolver. Acceptable for deny-by-default.
- **`NO_PROXY` is baked at container create time.** Adding new peers later doesn't update existing containers' `NO_PROXY`; their requests go through the proxy instead of peer-direct. The proxy still allows them. See [Container env injection](#container-env-injection).
- **Gateway upgrade is a per-env outage.** ~1-5s of failed proxied egress while the gateway container is recreated. See [The gateway](#the-gateway).
- **Migration of existing envs is not handled by this design.** When v3 first ships, existing envs without proxy injection / ipset membership stay in their current behaviour until each app is recreated under v3. Operators redeploy at their own pace; we don't auto-recreate.

## Out of scope for v3 (explicitly deferred)

- **Arbitrary TCP allowlists** (e.g. "allow this stack to reach `pg.example.com:5432` directly, not via HTTP). Posture says no — only HTTP/HTTPS via proxy. Bypass is the escape hatch for the rare cases this is genuinely needed.
- **TLS interception (SSL bump).** We see destinations via CONNECT; we do not see inside the tunnel. No plans to change this.
- **Per-environment default policies.** Still per-stack only; see [egress-firewall-future-work.md](egress-firewall-future-work.md) "What's not on this list".
- **Egress proxy for the host itself** (mini-infra-server's own outbound calls to Cloudflare, Azure, ACME). Out of scope; host is trusted.
- **HTTP/3 / QUIC.** Blocked at firewall (UDP/443 dropped). No QUIC support.
- **Deep request body inspection.** Headers and request line only. Bodies stream through unchanged.

## Trade-offs summary

| Property | Transparent sidecar (rejected — Appendix A) | Explicit proxy (this design) |
|---|---|---|
| Apps that ignore `HTTP_PROXY` | transparently captured | blocked at firewall (loud, correct fail-mode) |
| TLS destination signal | SNI peek (some clients omit SNI) | CONNECT request line (always present, plaintext) |
| Literal-IP egress | observable via `SO_ORIGINAL_DST` | blocked outright by IP-literal check; raw IP visible in `fw_drop` |
| Resource per env | ~325-625 MB | ~30 MB |
| Per-app lifecycle coupling | sidecar+app pair | none — app is unmodified |
| Kernel feature surface | nftables, conntrack, `SO_MARK`, `SO_ORIGINAL_DST`, `route_localnet` | iptables `DOCKER-USER` + ipset only |
| Implementation surface | ~3000 lines Go + lifecycle plumbing | ~300 lines Go wrapper around Smokescreen + firewall manager |
| Failure mode (gateway down) | per-app sidecar still blocks | firewall still drops; envs lose all egress until gateway recovers |

The single posture concession is "literal-IP egress lacks FQDN attribution in the log" — for deny-by-default this is acceptable.

---

## Appendix A: rejected designs

We considered several alternatives before settling on the explicit proxy.

### A.1 Per-managed-container sidecars sharing netns

The earlier sketch of v3. Each managed container is paired with a small sidecar that shares its netns via `--network=container:<sidecar>`. The sidecar installs nftables rules in the shared netns to redirect TCP/80 and TCP/443 to local listeners that peek SNI/Host and apply policy. Other ports redirect to a logging catchall.

Why we walked back from it:

- **Lifecycle coupling without K8s Pods.** The sidecar+app pair has to be created in order, the app's network depends on the sidecar's netns, and a sidecar crash invalidates the app's network reference (Docker behaviour varies by version — sometimes the app needs full recreation, not just restart). This is the lifecycle problem K8s Pods solve; without Pods we'd be paying for it explicitly in `stack-container-manager.ts`.
- **Kernel-feature surface.** nftables in each container's netns + `SO_ORIGINAL_DST` + `SO_MARK` to break the redirect loop on the sidecar's own outbound + `route_localnet=1` sysctl. Each is well-understood in isolation but the combination has many edges.
- **Resource cost.** ~15-30 MB per sidecar × N services per env = hundreds of MB before the env carries any actual workload.
- **The destination-intent problem it solves doesn't exist for HTTP_PROXY-respecting apps.** SNI peek extracts the same information the app would write into a CONNECT request line. Once we accept that posture-permitted egress is HTTP/HTTPS only, transparent capture buys us nothing the app wouldn't tell us via an explicit proxy.

### A.2 Central gateway with DNAT from every container's nftables

Naturally appealing: one gateway, all containers DNAT-redirect TCP to it, gateway peeks SNI/Host. Doesn't survive contact with Docker's networking model: the conntrack entry recording the DNAT lives in the source container's netns. By the time the connection reaches the gateway, the gateway's own conntrack only sees the rewritten destination — `SO_ORIGINAL_DST` returns the gateway's own IP, and the original target the app was trying to reach is **lost**.

Istio dodges this by running its proxy in the *same* netns as the app (Pod model). Plain Docker has no Pod abstraction.

### A.3 Host-netns nftables + gateway in `--network=host`

Works for `SO_ORIGINAL_DST` (DNAT and proxy share a conntrack table), but breaks per-env isolation, fights Docker's own iptables/nftables chains, and is platform-divergent (Linux native vs Colima VM vs WSL2 distro). Rejected.

### A.4 eBPF cgroup/connect

Compelling: hook `cgroup/connect4` per-container, decide allow/deny at the `connect()` syscall before any networking happens. No netns games, no sidecars. This is what Cilium does. The catch: at `connect()` time there's no TLS yet, so no SNI — you'd be enforcing on resolved IP only, which is weaker than this design's CONNECT-line FQDN match. We'd need a userspace L7 proxy on top to reach the same posture, at which point we're back to "explicit proxy plus a kernel feature" rather than just "explicit proxy". Not worth the kernel-version dependency.

### A.5 TPROXY transparent interception

Cleaner than DNAT + REDIRECT for transparent interception (no packet rewriting, original destination preserved naturally). Would have been the right choice if we'd stuck with transparent interception. Doesn't change the calculus — once we adopted explicit proxy, transparent-interception primitives are moot.

### A.6 Squid

Mature, battle-tested forward proxy with SSL-bump and peek-and-splice. Considered, rejected for this scope: its ACL configuration language is its own domain, hot-reload of rules is awkward (SIGHUP + reload), log format is custom, identity model is auth/cert based not source-IP, and we don't need 90% of its features (caching, content filtering, SSL bump, ICAP). A Go forward proxy built on Smokescreen-as-library (see [Appendix B](#appendix-b-implementation-detail--using-smokescreen-as-a-library)) is a few hundred lines of wrapper, integrates directly with the rule trie, container map, and admin API, and ships with Stripe's production-tested SSRF defences out of the box.

### A.7 Smokescreen as a deployed service (vs as a library)

We considered running Smokescreen as a separate process configured via YAML and an adapter sidecar that translated our admin pushes into file writes + SIGHUP. Rejected because the file-write-then-signal-then-wait control loop has too many edges (write atomicity, reload latency, verify post-reload state) for a path that's hot during operator UI changes. Smokescreen-as-library (this doc's chosen implementation) sidesteps this entirely — we build `smokescreen.Config` programmatically at startup and swap the ACL via an atomic pointer. See [Appendix B](#appendix-b-implementation-detail--using-smokescreen-as-a-library).

---

## Appendix B: Implementation detail — using Smokescreen as a library

[stripe/smokescreen](https://github.com/stripe/smokescreen) is imported as a Go module. We construct `smokescreen.Config` programmatically, call `smokescreen.BuildProxy(cfg)` to get the `goproxy.ProxyHttpServer` handler, and run that handler under our own `http.Server` so we own the lifecycle (lifecycle, shutdown, signals). We deliberately do not use `smokescreen.StartWithConfig(...)` because it installs SIGHUP/SIGTERM/SIGUSR2 handlers that we don't want owning our process.

### Why library, not fork or service

Smokescreen's surface is well-shaped for embedding:

- **Behaviour is configurable through interfaces on `smokescreen.Config`.** The binary's "static YAML + SIGHUP" model is a property of `cmd/smokescreen/main.go`, not of the library. Our `cmd/gateway/main.go` constructs `Config` programmatically and never touches YAML.
- **`EgressACL`** is `acl.Decider`, a one-method interface (`Decide(args acl.DecideArgs) (acl.Decision, error)`) called per-request — we plug in an atomic-pointer-backed implementation for lock-free runtime swap.
- **`RoleFromRequest`** is a `func(*http.Request) (string, error)` — we plug in source-IP → stackId lookup against the container map.
- **`Log *logrus.Logger`** is settable — we attach a hook that emits our NDJSON `EgressEvent` shape and pulls byte counts from `CANONICAL-PROXY-CN-CLOSE` entries.
- **`DenyRanges []smokescreen.RuleRange`** is settable — we pre-populate with RFC1918, loopback, link-local, ULA, multicast. (Smokescreen's `classifyAddr` already denies private/loopback/IPv6-embedded/CGNAT by default; `DenyRanges` is for additional operator-configured CIDRs.)
- We do **not** replace `ConnTracker`. The default `Tracker` writes byte counts on connection close; we read them via the log hook above. The `TrackerInterface` has 7 methods coupled to Smokescreen's `*InstrumentedConn`, so substituting it would mean re-implementing connection tracking — far more code than the log-extraction approach.

Total wrapper code: ~250-350 lines. We pick up Stripe's production hardening, the SSRF/DNS-rebinding defences, the splice loop, and the policy mode plumbing without re-implementing any of it. v3 has no DNS server in the gateway — apps use Docker's default `127.0.0.11` resolver and the proxy resolves external FQDNs on their behalf.

License: MIT. No problem.

### What Smokescreen provides

These behaviours come from Smokescreen and we do not re-implement them:

- **CONNECT request line parsing**, header drain, hop-by-hop header scrub.
- **Splice loop** with proper half-close handling and bidirectional io.Copy.
- **`SafeResolve`** — resolves the FQDN, rejects internal/private/loopback IPs, returns a single resolved IP.
- **Dial-the-resolved-IP** — defeats DNS rebinding by ensuring the connection goes to a specific validated IP, not a hostname that could re-resolve.
- **Three policy modes per role**: `open` / `report` (= our "observe") / `enforce`.
- **Hostname globbing**: `*.example.com` matches `api.example.com` and `foo.bar.example.com`; bare `example.com` matches only the apex.
- **Literal-IP CONNECT block by default.** `CONNECT 1.2.3.4:443` denied unless explicitly permitted.
- **Per-role allowlist with global allow/deny override.** Our per-stack rules map cleanly to per-role.
- **Deny-ranges enforcement at dial time** — the same IP-range checks apply for HTTP forward proxy via `Transport.DialContext`.
- **Error responses with explanatory bodies** so users see why their request was denied.

### What our wrapper provides

These pieces we own:

- **`ACLSwapper` (in `internal/proxy/aclswap.go`)** — implements `acl.Decider`, backed by `atomic.Pointer[*acl.ACL]`. `Decide(DecideArgs)` does a lock-free read; `Swap()` is a single atomic store called from the admin API.
- **`compile()` (in `internal/proxy/compile.go`)** — converts `StackPolicy` snapshot from `mini-infra-server` into a Smokescreen `*acl.ACL` (a tree of `acl.Rule` keyed by service/role). Run on each `POST /admin/rules`.
- **`roleFromRequest` (in `internal/proxy/role.go`)** — looks up `(stackId, serviceName)` from `r.RemoteAddr` via the container map; returns `stackId` as the role.
- **`logadapter` (in `internal/proxy/logadapter.go`)** — `logrus.Hook` that translates Smokescreen log entries to our NDJSON `EgressEvent` shape and writes them on stdout. Pulls `bytes_in` / `bytes_out` from `CANONICAL-PROXY-CN-CLOSE` entries (so we don't need a custom `ConnTracker`). Same NDJSON shape the fw-agent uses.
- **`dohGateMiddleware` (in `internal/proxy/doh_gate.go`)** — `http.Handler` middleware that wraps the proxy with a pre-ACL gate, 403'ing known DoH endpoints regardless of stack rules. Smokescreen doesn't ship this; we add it for our compliance posture.
- **Admin API** (`internal/admin/`) — receives `POST /admin/rules` and `POST /admin/container-map`, calls `aclSwapper.Swap(...)` and `containerMap.Replace(...)`.

### What we leave behind from Smokescreen

These features exist in Smokescreen but we don't use them:

- **MITM / SSL-bump.** Out of scope per posture.
- **Statsd / Datadog metrics integration.** Reuse `mini-infra-server`'s existing metrics.
- **Per-tenant TLS CRL / cert pinning.** Single-tenant envs.
- **HTTP/2 frontend.** Apps speak HTTP/1.1 to the proxy.
- **Static YAML config + SIGHUP reload.** Replaced by admin API + atomic pointer swap.
- **TLS client cert / Proxy-Authorization auth.** Replaced by source-IP container-map lookup.
- **`smokescreen.StartWithConfig(...)` lifecycle.** It installs `signal.Notify(SIGUSR2, SIGTERM, SIGHUP)` for graceful shutdown — we don't want our process to react to SIGHUP. Instead we call `BuildProxy(cfg)` ourselves and run the resulting handler under our own `http.Server`, so we own the lifecycle and signals.

### Atomic ACL swap — why it matters

Smokescreen reads `Config.EgressACL` per-request. If `mini-infra-server` calls `POST /admin/rules` while traffic is in flight, naïvely setting `Config.EgressACL = newACL` could be observed mid-decision by an in-flight goroutine. The `atomic.Pointer` indirection ensures every `Decide()` call observes a single coherent ACL. The cost is one extra pointer dereference per request — negligible.

We do not need to fork Smokescreen for this; the indirection is entirely within our `ACLSwapper` type, which implements the existing `smokescreen.ACL` interface. Smokescreen never sees the pointer.

### Reading list (for the implementer)

Worth reading from the Smokescreen source while writing the wrapper:

- `pkg/smokescreen/smokescreen.go` — top-level proxy plumbing; gives you the call sites for `RoleFromRequest`, `EgressACL`, `ConnTracker`.
- `pkg/smokescreen/acl/v1/acl.go` — role/policy ACL data model and `Decider` interface (this is what `ACLSwapper` implements).
- `pkg/smokescreen/safe_resolver.go` — the `SafeResolve` implementation; understand the deny-ranges semantics so the operator-extend story is consistent.
- `pkg/smokescreen/conntrack/` — connection tracking patterns; what `ConnTracker` is expected to do.
- `cmd/smokescreen/main.go` — the canonical YAML-driven entry; useful only as a reference for which `Config` fields exist (we set them programmatically, not via YAML).
