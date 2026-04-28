# Egress Gateway v3 — Compliance-grade enforcement (design)

Status: **planned, not implemented**. Successor to v1+v2 ([#263](https://github.com/mrgeoffrich/mini-infra/pull/263)) and the design referenced in [egress-firewall-future-work.md](egress-firewall-future-work.md) under "SNI-aware transparent proxy (phase 3)". This doc captures the concrete plan for the next phase: rewriting the gateway in Go, introducing an explicit HTTP/HTTPS forward proxy for per-stack rule enforcement, and locking down all other egress at the host firewall.

An earlier sketch of v3 took a transparent-interception approach (per-managed-container sidecars sharing netns with the app, intercepting all TCP via nftables `redirect`, peeking SNI to decide). It worked but the cost was high — see [Appendix A: rejected designs](#appendix-a-rejected-designs). We're going with an explicit proxy instead.

## Posture

**Compliance-grade.** Nothing leaves a managed container without an explicit rule match. Every blocked attempt produces an `EgressEvent` row.

Concretely:

- Outbound HTTP and HTTPS from managed containers must traverse the **per-env egress gateway**. The container's `HTTP_PROXY` / `HTTPS_PROXY` env vars are injected at create time pointing at the gateway. The gateway parses the destination host (from the `CONNECT` request line for HTTPS, or the absolute-URI request line / `Host` header for HTTP), matches it against the stack's policy, and either splices through to the upstream or returns `403 Forbidden`.
- DNS from managed containers is permitted to the gateway only (UDP/53 + TCP/53). The gateway's DNS layer remains as defence in depth — see [DNS path](#dns-path-defence-in-depth).
- All other outbound traffic from managed containers is **dropped at the host firewall**: the only permitted egress paths are the proxy ports, the DNS port, the env bridge itself (peer-to-peer), and the loopback interface.
- Bypass containers (`egressBypass: true` in their service config) are exempt — they egress directly via the host with no proxy injection and no firewall restrictions.

QUIC (UDP/443) is dropped by the firewall. Apps fall back to TCP/443 through the proxy.

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
- Terminate connections from managed containers on TCP/3128 (HTTP forward proxy) and TCP/3129 (HTTPS CONNECT proxy).
- Parse the destination host (absolute-form request URI / `Host` header for HTTP; `CONNECT host:port` line for HTTPS).
- Match against the env's stack-policy rule trie. Allow → splice/forward. Block → `403`.
- Run the env's DNS resolver on UDP/53 + TCP/53 (defence in depth, same role as today's TS sidecar).
- Expose admin API for rule + container-map push from `mini-infra-server`.
- Emit NDJSON `EgressEvent`s on stdout (`evt: "dns" | "tcp"`).

Non-responsibilities: doesn't touch host firewall, doesn't manage container lifecycles, doesn't read NFLOG, doesn't know which IPs belong to which containers (that's pushed in via the container-map).

### 2. `egress-fw-agent` — host-singleton privileged firewall agent
*One container per host. `--network=host`, `cap_add: ['NET_ADMIN', 'NET_RAW']`. New component.*

`mini-infra-server` runs in a regular Docker container with no host network access; it can't directly touch host iptables or ipsets. The fw-agent shares the host's network namespace, so when *it* runs `iptables` or `ipset`, the changes hit the host kernel. `mini-infra-server` calls the agent over a Unix socket; the agent translates a tiny well-defined API into iptables/ipset operations and validates inputs before executing.

Responsibilities:
- Maintain the per-env `DOCKER-USER` rule blocks (insert on env create, remove on env destroy, idempotent).
- Maintain ipsets per env (`managed-<env>`); add/remove member IPs on container start/stop.
- Subscribe to NFLOG group 1, decode dropped-packet metadata, emit `evt: "fw_drop"` NDJSON on stdout.
- Reconcile host state on boot from `mini-infra-server`'s declared inventory (in case rules / ipsets were lost across host reboot).

Non-responsibilities: doesn't terminate any traffic, doesn't make policy decisions, doesn't know about FQDN rules. It's a thin executor — "apply this firewall state."

Communication: JSON-over-HTTP on a Unix socket at `/var/run/mini-infra/fw.sock`, mounted into both `mini-infra-server` (read/write client) and the agent (server). API:

```ts
POST /v1/env                          // applyEnvRules
  { env, gatewayIp, bridgeCidr, ipsetName, mode: "observe" | "enforce" }
DELETE /v1/env/:env                   // removeEnvRules
POST /v1/ipset/:set/add               // addIpsetMember { ip }
POST /v1/ipset/:set/del               // delIpsetMember { ip }
POST /v1/ipset/:set/sync              // syncIpset { ips: string[] } — full snapshot
GET  /v1/health
```

Privilege boundary: `mini-infra-server` is a web app handling untrusted HTTP input — granting it `CAP_NET_ADMIN` directly would mean any web-layer RCE rewrites host firewall. The agent's API is narrow and validated, so the web app can't ask it to do anything ad hoc. Same pattern as Docker (privileged daemon, dumb client) and Kubernetes node agents.

### 3. `mini-infra-server` — orchestrator (existing component, new responsibilities)
*Runs as a Docker container on the same host it manages. Regular bridge network, no host netns, no `NET_ADMIN`. Mounts `/var/run/docker.sock` (existing) and now `/var/run/mini-infra/fw.sock` (new, for the fw-agent).*

The Mini Infra application itself — the web UI, REST API, schedulers, executors, and Socket.IO emitters. Same container that ships today; v3 just adds new services inside it. Still runs unprivileged, still talks to Docker via the socket, still doesn't directly touch host networking. Crucially it has no way to write iptables rules or ipsets on the host, which is *why* the fw-agent exists — to give the server a narrow, validated channel for the privileged operations it can't perform itself.

New / extended v3 services inside the server:

- `EgressRulePusher` (existing) — pushes rule snapshots to per-env gateways. Unchanged wire contract.
- `EgressContainerMapPusher` (existing) — pushes `srcIp → (stackId, serviceName)` map to per-env gateways. Unchanged.
- `EnvFirewallManager` (new) — owns the desired state of host firewall rules and ipsets. Calls `egress-fw-agent` over the Unix socket to apply changes. Hooked into env create/destroy and managed-container start/stop.
- `EgressLogIngester` (existing, extended) — tails NDJSON from per-env gateways and from the fw-agent. New event shapes (`evt: "tcp"`, `evt: "fw_drop"`). Writes `EgressEvent` rows.
- `stack-container-manager.ts` (existing, extended) — for managed services, additionally injects `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` env vars at create time, and notifies `EnvFirewallManager` on lifecycle transitions.

### 4. Managed app containers — config changes only
*No new code in app images.*

For non-bypass services:
- Env vars: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (plus lowercase variants).
- DNS: `HostConfig.Dns: [gatewayIp]` (existing).
- Firewall membership: the container's IP is added to `managed-<env>` ipset on start, removed on stop.

For bypass services: none of the above. Container egresses normally via Docker forwarding; not in any ipset, no env vars injected.

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
                                                                │▼    │  proxy + DNS       │
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

Each managed app container is configured with `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and a DNS resolver pointing at the per-env gateway. The host firewall (in `DOCKER-USER`) ensures the only permitted destinations from a managed container are the gateway's listening ports plus the env bridge subnet.

```
[ env's applications bridge network ]
  ┌─────────────────────────────────────────────────────────────────┐
  │                                                                 │
  │  ┌──────────────────┐                  ┌───────────────────────┐│
  │  │ app container    │                  │  egress-gateway       ││
  │  │                  │   :3128 ────────▶│   HTTP forward proxy  ││
  │  │ HTTP_PROXY=──────┼─                 │                       ││
  │  │ HTTPS_PROXY=─────┼──  :3129 ───────▶│   HTTPS CONNECT proxy ││
  │  │ NO_PROXY=peers   │                  │                       ││
  │  │ /etc/resolv.conf─┼──  :53   ───────▶│   DNS server          ││
  │  │  → gateway-ip    │                  │                       ││
  │  └──────────────────┘                  │   admin API           ││
  │           │                            └───────────┬───────────┘│
  │           │                                        │            │
  └───────────┼────────────────────────────────────────┼────────────┘
              │                                        ▼
              │                           [ bridge → host → internet ]
              ▼
   Host firewall (DOCKER-USER):
     src ∈ ipset:managed-<env>, ct established/related   → ACCEPT
     src ∈ ipset:managed-<env>, dst ∈ env-bridge CIDR    → ACCEPT (peers)
     src ∈ ipset:managed-<env>, dst = gateway:{3128,3129} → ACCEPT
     src ∈ ipset:managed-<env>, dst = gateway:53          → ACCEPT
     src ∈ ipset:managed-<env>                            → NFLOG + DROP
```

### Per container kind

| Kind | netns | DNS resolver | In `managed-<env>` ipset | `HTTP_PROXY` injected | TCP path |
|---|---|---|---|---|---|
| Managed app | own (Docker default) | `[gatewayIp]` (injected) | yes | yes | via proxy → gateway → upstream |
| Bypass app | own (Docker default) | Docker default | no | no | direct out via bridge → host |
| Egress-gateway | own (Docker default) | Docker default | no | no | direct out via bridge → host |

### Two ports — why HTTP and HTTPS are split

`HTTP_PROXY=http://gw:3128` and `HTTPS_PROXY=http://gw:3129` rather than a single port for both. Each listener handles exactly one method shape:

- **3128**: accepts `GET`, `POST`, `PUT`, `DELETE`, etc. with **absolute-form request URI** (`GET http://example.com/path HTTP/1.1`). Rejects anything else with `400`.
- **3129**: accepts **`CONNECT host:port HTTP/1.1`** only. Rejects anything else with `400`.

Trade is one extra port for clarity and isolation: the HTTPS port can never be coerced into serving an HTTP request, and accidental cross-protocol probes get crisp errors instead of confused responses. The two listeners share the same rule trie, container map, event emitter, and admin API — separation is at the parsing layer only.

### Host firewall — `DOCKER-USER` with per-env ipsets

`mini-infra-server` declares the desired firewall state via `EnvFirewallManager`; `egress-fw-agent` applies it. The rule shape below describes what ends up on the host kernel; the next subsection covers who installs each piece.

Per env, one ipset (`managed-<env>`) holds the IPs of all managed containers in that env. Bypass containers are not in the set, so the drop rule does not apply to them.

```
# Per-env block — installed once per env, refreshed on container churn.
# $ENV_BRIDGE_CIDR is the env applications bridge's CIDR.
# $GATEWAY_IP is the egress-gateway container's pinned IP on that bridge.

iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -d $ENV_BRIDGE_CIDR -j ACCEPT

iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -d $GATEWAY_IP -p tcp -m multiport --dports 3128,3129 -j ACCEPT

iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -d $GATEWAY_IP -p tcp --dport 53 -j ACCEPT

iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -d $GATEWAY_IP -p udp --dport 53 -j ACCEPT

iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -j NFLOG --nflog-group 1 --nflog-prefix "mini-infra-egress-drop "

iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -j DROP
```

Why `DOCKER-USER`: it's the documented Docker hook for layered host policy. Rules placed there are evaluated before Docker's NAT/forwarding chains, survive Docker daemon restarts, and don't fight Docker's own management. ipsets work uniformly under `iptables-legacy` and `iptables-nft`, which covers Linux native, Colima (VM), and WSL2.

#### Who installs what

| Action | Trigger | Server-side caller | Agent operation |
|---|---|---|---|
| Insert per-env rule block | env created | `EnvFirewallManager.applyEnv()` | `POST /v1/env` → `iptables -A DOCKER-USER ...` |
| Remove per-env rule block | env destroyed | `EnvFirewallManager.removeEnv()` | `DELETE /v1/env/:env` → `iptables -D DOCKER-USER ...` |
| Add IP to ipset | managed container started | `stack-container-manager.ts` post-start hook | `POST /v1/ipset/:set/add` → `ipset add` |
| Remove IP from ipset | managed container stopped | `stack-container-manager.ts` post-stop hook | `POST /v1/ipset/:set/del` → `ipset del` |
| Full ipset reconcile | server boot, host reboot | `EnvFirewallManager.reconcile()` | `POST /v1/ipset/:set/sync` → `ipset restore` |
| Mode flip (observe ↔ enforce) | feature flag toggled | `EnvFirewallManager.setMode()` | `POST /v1/env` with new mode (atomically replaces the env's rule block) |

The server holds the *desired state* (in DB / in-memory). The agent is stateless apart from the host kernel state it manages — on boot it accepts a full reconcile from the server. Removing a container from the ipset is sufficient to revoke its egress without modifying any iptables rule.

### The gateway

One container per env. Hosts:

- **HTTP forward proxy** (TCP/3128) — accepts absolute-URI HTTP requests. Parses the request URI's host. Applies stack policy. Allowed → forwards via `httputil.ReverseProxy`. Blocked → `403`.
- **HTTPS CONNECT proxy** (TCP/3129) — accepts `CONNECT host:port`. Applies stack policy on the host. Allowed → dials upstream and bidirectionally splices the sockets (TLS happens end-to-end between app and upstream; gateway never sees plaintext). Blocked → `403` before the tunnel opens.
- **DNS server** (UDP/53 + TCP/53) — same role as today's TS sidecar. Defence in depth, see below.
- **Admin API** (private port) — `POST /admin/rules`, `POST /admin/container-map`, `GET /admin/health`. Same wire contract as today, plus listener-up booleans on health.

No `cap_add`, no sysctls, no privileged operations. The gateway is a plain user-space TCP/UDP server.

### DNS path (defence in depth)

With `HTTP_PROXY` set, app DNS resolution for HTTP/HTTPS destinations doesn't happen on the app side — the gateway resolves the upstream host on the app's behalf. So why keep the DNS layer?

1. **Apps that need DNS for non-HTTP reasons.** Posture says they shouldn't, but in practice some libraries do `getaddrinfo()` even for proxy-routed requests (curl with `--resolve`, ALPN probing, etc.). Logged.
2. **FQDN policy at DNS time.** If an app bypasses the proxy by hardcoding IPs, it usually still resolved DNS first (or it would have nothing to hardcode). The DNS layer logs the attempt against FQDN policy — gives us "the app tried to look up evil.com" even when the firewall drop only shows "the app tried to reach 1.2.3.4".
3. **Existing implementation.** v1+v2's DNS gateway is already shipped and tested. Keeping it in the new gateway is cheap (same Go module).

DNS to non-gateway resolvers is dropped at the host firewall (`udp dport 53 ip daddr != $GATEWAY_IP` falls through the allow list, hits the drop rule). Logged as `fw_drop`.

DoH leak (`dns.google`, `cloudflare-dns.com` over CONNECT to :443) is captured by the proxy as a `connect` event — the FQDN is on the CONNECT request line, so a built-in DoH-domains denylist applied before stack policy catches these regardless of stack rules. Same mechanism for `8.8.8.8:443` literal-IP CONNECT (the IP-literal block in the CONNECT handler covers it).

### Bypass services

Today, `egressBypass: true` on a service skips DNS injection. Under v3:

- Skip `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` env injection.
- Skip ipset membership — bypass IPs aren't in `managed-<env>`, so the firewall drop rule doesn't match them.
- Skip DNS injection (existing behaviour).

Bypass containers egress directly via Docker's normal forwarding. They live on the same env bridge as managed containers; the difference is purely in firewall membership and env-var injection.

## Hot path

The proxy is built on **[Stripe's Smokescreen](https://github.com/stripe/smokescreen) imported as a Go library**, with a thin wrapper for our admin API, container-map identification, and NDJSON event shape. Smokescreen handles CONNECT parsing, hop-by-hop scrubbing, splice loop, IP-range validation, DNS-rebind defence (resolve-and-dial-the-IP), policy modes, and SSRF hardening — all production-tested in Stripe's egress path. We get the security primitives for free and own only the parts that are specific to Mini Infra.

Smokescreen-as-binary is configured by YAML and reloads on SIGHUP. Smokescreen-as-library exposes everything as configurable interfaces on `smokescreen.Config`, so we never touch a YAML file or a signal handler.

### Wrapper responsibilities

The Go wrapper provides Smokescreen with five things:

1. **`RoleFromRequest`** — function pointer that maps the source IP of an inbound request to `(stackId, serviceName)` via our container map. Smokescreen's role-based ACL keys off this.
2. **`EgressACL`** — interface implementation backed by an `atomic.Pointer[acl.Decider]` for lock-free runtime swap. Admin-API rule push compiles a new ACL and atomically replaces the pointer; in-flight requests keep using the old ACL until they complete.
3. **`Log`** — `logrus.Logger` with a custom hook that translates each log entry to our NDJSON `EgressEvent` shape on stdout. Same shape the DNS server and fw-agent use.
4. **`ConnTracker`** — interface implementation that captures `bytesUp`/`bytesDown` per connection and emits the splice-completion event.
5. **`DenyRanges` / `AllowRanges`** — pre-populated with RFC1918, loopback, link-local (incl. `169.254.169.254` cloud metadata), IPv6 ULA, multicast. Operator-configured custom CIDRs append to `DenyRanges`.

We additionally run a **pre-ACL DoH denylist gate** because Smokescreen doesn't ship one and the DoH leak vector is in scope for our compliance posture.

### `cmd/gateway/main.go` (sketch)

```go
func main() {
    srv := newServer(loadConfig())

    sk := smokescreen.NewConfig()
    sk.Listener = newTCPListener(":3128")            // HTTP forward proxy
    sk.ConnectListener = newTCPListener(":3129")     // HTTPS CONNECT
    sk.RoleFromRequest = srv.roleFromRequest         // srcIP → stackId via container map
    sk.EgressACL = srv.aclSwapper                    // atomic.Pointer indirection
    sk.DenyRanges = builtinPrivateRanges()           // RFC1918, link-local, ULA, …
    sk.ConnectTimeout = 10 * time.Second
    sk.ConnTracker = srv.tracker                     // → NDJSON on conn close
    sk.Log = newLogrusToNDJSON(srv.events)           // logrus hook → our shape
    sk.AdditionalErrorMessageOnDeny = "egress denied by mini-infra policy; see UI"

    // Pre-ACL DoH gate sits in front of smokescreen via an HTTP middleware on
    // each listener; we wrap sk.Listener / sk.ConnectListener accordingly.
    sk.Listener = srv.dohGateMiddleware(sk.Listener)
    sk.ConnectListener = srv.dohGateMiddleware(sk.ConnectListener)

    go srv.runAdminAPI(srv.aclSwapper)               // /admin/rules → swapper.Swap(newACL)
    go srv.runDNSServer()                            // miekg/dns, separate from smokescreen
    go srv.runHealthEndpoint()

    if err := smokescreen.StartWithConfig(sk, signalCh); err != nil {
        log.Fatal(err)
    }
}
```

### Atomic ACL swap

Smokescreen reads `Config.EgressACL` per request. Our wrapper implements that interface with an atomic-pointer indirection:

```go
type ACLSwapper struct {
    p atomic.Pointer[compiledACL]
}

// Decide implements smokescreen's ACL interface.
func (s *ACLSwapper) Decide(role, host string, port int) (acl.Decision, error) {
    return s.p.Load().Decide(role, host, port)
}

// Swap is called by the admin API on /admin/rules push.
func (s *ACLSwapper) Swap(newACL *compiledACL) {
    s.p.Store(newACL)
}
```

`compiledACL` is built from our `StackPolicy` snapshot via a small compiler in `internal/proxy/compile.go` (FQDN trie → Smokescreen `acl.Decider`). Lock-free, allocation-free per-request reads; admin pushes are O(1) atomic stores.

### Role identification

```go
func (srv *Server) roleFromRequest(r *http.Request) (string, error) {
    src := remoteIP(r)
    attr := srv.containers.Lookup(src)
    if attr == nil {
        return "", errors.New("unknown source")    // surfaces as 403 with our error message
    }
    return attr.StackID, nil                       // role keyed by stackId; ACL has per-stack allowlists
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
- DNS server (miekg/dns) on UDP/53 + TCP/53.
- NDJSON event shape consistent with the rest of Mini Infra.
- Container-map identity model (srcIP-keyed instead of TLS-cert/proxy-auth).

### Container map

The gateway needs `srcIp → (stackId, serviceName)` to attribute events per stack. This is identical to today's TS DNS gateway — server pushes `POST /admin/container-map` (full snapshot) on env change. Same wire format, reused for both DNS and proxy listeners.

## Logging — full visibility

NDJSON on stdout, ingested by the existing `EgressLogIngester`. Four event shapes, three from the gateway and one from the host-side NFLOG reader:

```jsonc
// DNS query (gateway, existing — unchanged)
{ "evt": "dns", "protocol": "dns", "ts": "...", "srcIp": "...",
  "qname": "api.example.com", "qtype": "A",
  "action": "allowed|blocked|observed",
  "matchedPattern": "*.example.com",
  "stackId": "...", "serviceName": "...", "mergedHits": 1 }

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

// Firewall drop (egress-fw-agent, new)
{ "evt": "fw_drop", "protocol": "tcp|udp|icmp", "ts": "...",
  "srcIp": "...", "destIp": "...", "destPort": 5432,
  "stackId": "...", "serviceName": "...",
  "reason": "non-allowed-egress", "mergedHits": 1 }
```

Same dedup window (60s, key `destIp + destPort + protocol`) keeps volume sane.

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
    dnsUdp: boolean;
    dnsTcp: boolean;
    httpProxy: boolean;     // 3128
    httpsProxy: boolean;    // 3129
    admin: boolean;
  };
  upstreamDns: { healthy: number; total: number };
}
```

Discovery is unchanged from today — server finds the per-env gateway by container label `mini-infra.egress.gateway=true` + `mini-infra.environment=<env>`.

## Container env injection

For every managed (non-bypass) service, `stack-container-manager.ts` injects:

```
HTTP_PROXY=http://<gatewayIp>:3128
HTTPS_PROXY=http://<gatewayIp>:3129
http_proxy=http://<gatewayIp>:3128
https_proxy=http://<gatewayIp>:3129
NO_PROXY=localhost,127.0.0.0/8,<envBridgeCidr>
no_proxy=localhost,127.0.0.0/8,<envBridgeCidr>
HostConfig.Dns=[<gatewayIp>]               # existing behaviour
```

Both upper- and lowercase variants because Node honours uppercase, Python `requests` honours lowercase, Go honours both. `NO_PROXY` lists the env bridge CIDR so peer-to-peer traffic doesn't loop through the proxy.

For libraries that don't honour CIDR in `NO_PROXY` (some only do suffix matching), we additionally inject a comma-separated list of peer container *names* on the env bridge. The list is regenerated on env churn alongside the container map push.

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
    proxy/         aclswap.go         # smokescreen ACL impl with atomic.Pointer
                   role.go            # RoleFromRequest impl (srcIP → stackId)
                   logadapter.go      # logrus hook → NDJSON EgressEvent
                   tracker.go         # ConnTracker impl → byte counts + close events
                   doh_gate.go        # pre-ACL DoH denylist middleware
                   compile.go         # StackPolicy → smokescreen acl.Decider
                   ipranges.go        # built-in private/loopback/link-local CIDRs
    dns/           server.go          # miekg/dns combined UDP/TCP listener
                   forward.go         # upstream pool with health
                   handler.go         # query → match → respond/NXDOMAIN
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
- Joins the env's applications network with a pinned IP
- Labels: `mini-infra.egress.gateway=true`, `mini-infra.environment=<env>`
- Env vars: `UPSTREAM_DNS=1.1.1.1,8.8.8.8`, `HTTP_PORT=3128`, `HTTPS_PORT=3129`, `LOG_LEVEL`
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
*For managed (non-bypass) services only.*

- Inject `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` env vars (above)
- Inject DNS (`HostConfig.Dns: [gatewayIp]`) — unchanged from today
- After Docker assigns the container's IP and it transitions to `Running`, `stack-container-manager.ts` calls `EnvFirewallManager.addContainer()`, which calls the agent to add the IP to `managed-<env>`

Bypass services and the gateway itself: unaffected. No proxy injection, not in any ipset, no agent calls.

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
- New `EnvFirewallManager` service in `mini-infra-server`: declares desired firewall state, calls fw-agent over the Unix socket, owns reconcile loop on server boot.
- ipset membership wired into container start/stop hooks in `stack-container-manager.ts` for managed services.
- NFLOG reader inside the agent emits `fw_drop` NDJSON; ingester (PR 1) picks it up.
- Ships behind a per-env feature flag — agent is deployed and managing rules but the `DROP` line is gated. Initial mode is **observe** (NFLOG without DROP) for opted-in envs.
- Tests: integration tests with a temporary iptables ruleset and a real fw-agent in a Linux container, ensure rules and ipset entries are inserted/removed correctly across env churn, Docker daemon restarts, and agent restarts.

### PR 3 — `egress-gateway` deployment + env injection
- Add `github.com/stripe/smokescreen` to the gateway module's `go.mod`.
- Implement the wrapper (`internal/proxy/`): `ACLSwapper`, `roleFromRequest`, `logadapter`, `tracker`, `dohGateMiddleware`, `compile`. `cmd/gateway/main.go` wires Smokescreen's `Config` against these and the existing DNS server / admin API.
- `EnvironmentManager` swaps the TS `egress-sidecar` for the Go `egress-gateway` image (same per-env container, just different binary in the existing slot).
- `stack-container-manager.ts` injects `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` for managed services; bypass + host-level + non-environment stacks skip this entirely (mirrors the existing `egressBypass` skip for DNS injection).
- `EgressRulePusher` continues to push to one endpoint per env. The gateway compiles the snapshot to a Smokescreen `acl.Decider` and atomically swaps via `ACLSwapper.Swap()`.
- Gateway initially runs in Smokescreen's `report` mode (allows everything, logs decisions) when the per-env flag is flipped ON.
- Tests: integration tests against a real Smokescreen-backed gateway with stub container map, validate rule swap atomicity, validate SSRF defences against a test resolver.
- Land behind the same per-env feature flag introduced in PR 2.

## Phasing / rollout

1. **PR 1** (schema + ingester) — lands independently, no behaviour change.
2. **PR 2** (Go module + fw-agent + firewall manager) — fw-agent deployed, rules and ipsets managed for opted-in envs. Default OFF per env; opted-in envs in **observe mode** (NFLOG, no DROP). Validates ipset membership tracking, agent reconcile, NFLOG event flow.
3. **PR 3** (gateway + env injection) — when the per-env flag is flipped ON: gateway image deployed in place of the TS sidecar, `HTTP_PROXY`/`HTTPS_PROXY` injected on next container recreate, gateway in **detect mode forced** (allows everything, logs decisions).
4. **Per-env enforce promotion.** Flip enforce mode on the gateway → 403s on rule-deny. Flip the firewall agent to enforce mode → drops direct egress. Both flips are independent so we can stage. The promote-to-Enforce wizard from v2 handles per-stack progression.
5. **Phase out the TS sidecar.** Once all envs run v3, delete `egress-sidecar/`.

## Open decisions / spike items

- **Authenticated proxy?** Default to no auth — the network reachability boundary (only the env bridge can reach the gateway) is the auth. If we ever support multi-tenant envs, revisit.
- **WebSocket through CONNECT.** WSS is HTTPS upgrade and goes through CONNECT fine. Plain WS over HTTP traverses the HTTP forward proxy, which honours `Connection: Upgrade` correctly with `httputil.ReverseProxy` — verify with a fixture.
- **`NO_PROXY` exhaustiveness.** Some libraries do suffix-only matching, not CIDR. We inject the env bridge CIDR plus a peer-name list; spike to confirm coverage with the languages we actually see (Node, Python, Go, Java, Ruby).
- **Apps that don't honour `HTTP_PROXY`.** Document the failure mode in the operator UI: a service that egresses directly will produce `fw_drop` events; surface these prominently with a "mark as bypass or fix the client" call to action.
- **fw-agent ↔ server outage handling.** If the agent is down, in-flight ipset updates queue in `EnvFirewallManager` and a degraded-component banner surfaces in the UI. Existing rules are untouched (kernel state outlives the agent). On agent recovery, drain the queue and run a full reconcile. Decide the queue cap and what to do on overflow (probably: drop oldest, log loudly).
- **Rule reload performance.** ipset membership churn during container start/stop must be sub-100ms to avoid stack-apply slowdown. ipset is in-kernel and fast; benchmark with 50 containers/env.
- **Resource budget.** Per env: ~30 MB RSS for gateway. Per host: ~10 MB for fw-agent. So ~30 MB per env + ~10 MB host-wide — vs ~325-625 MB in the rejected sidecar design. ~10× win.
- **IPv6.** v1+v2 are IPv4-only; v3 mirrors that. ipsets and `DOCKER-USER` work in IPv6 too; need dual-stack listeners and an ipv6 ipset when we cross that bridge.

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

[stripe/smokescreen](https://github.com/stripe/smokescreen) is imported as a Go module. The gateway's main loop *is* `smokescreen.StartWithConfig(...)`; our code provides the configurable interfaces.

### Why library, not fork or service

Smokescreen's surface is well-shaped for embedding:

- **Behaviour is configurable through interfaces on `smokescreen.Config`.** The binary's "static YAML + SIGHUP" model is a property of `cmd/smokescreen/main.go`, not of the library. Our `cmd/gateway/main.go` constructs `Config` programmatically and never touches YAML.
- **`EgressACL`** is an interface — we plug in an atomic-pointer-backed implementation for lock-free runtime swap.
- **`RoleFromRequest`** is a function pointer — we plug in source-IP → stackId lookup against the container map.
- **`Log *logrus.Logger`** is settable — we attach a hook that emits our NDJSON `EgressEvent` shape.
- **`ConnTracker`** is an interface — we plug in our event emitter for connection-close events with `bytesUp`/`bytesDown`.
- **`DenyRanges []net.IPNet`** is settable — we pre-populate with RFC1918, loopback, link-local, ULA, multicast.

Total wrapper code: ~250-350 lines + the existing DNS server. We pick up Stripe's production hardening, the SSRF/DNS-rebinding defences, the splice loop, and the policy mode plumbing without re-implementing any of it.

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

- **`ACLSwapper` (in `internal/proxy/aclswap.go`)** — implements `smokescreen.ACL` interface, backed by `atomic.Pointer[compiledACL]`. `Decide()` does a lock-free read; `Swap()` is a single atomic store called from the admin API.
- **`compile()` (in `internal/proxy/compile.go`)** — converts `StackPolicy` snapshot from `mini-infra-server` into Smokescreen's `acl.Decider` shape. Run on each `POST /admin/rules`.
- **`roleFromRequest` (in `internal/proxy/role.go`)** — looks up `(stackId, serviceName)` from `r.RemoteAddr` via the container map; returns `stackId` as the role.
- **`logadapter` (in `internal/proxy/logadapter.go`)** — `logrus.Hook` that translates Smokescreen log entries to our NDJSON `EgressEvent` shape and writes them on stdout. Same shape DNS server and fw-agent use.
- **`ConnTracker` (in `internal/proxy/tracker.go`)** — implements Smokescreen's `ConnTracker` interface; emits the per-connection close event with byte counts.
- **`dohGateMiddleware` (in `internal/proxy/doh_gate.go`)** — wraps the listeners with a pre-ACL gate that 403s known DoH endpoints regardless of stack rules. Smokescreen doesn't ship this; we add it for our compliance posture.
- **Admin API** (`internal/admin/`) — receives `POST /admin/rules` and `POST /admin/container-map`, calls `aclSwapper.Swap(...)` and `containerMap.Replace(...)`.
- **DNS server** (`internal/dns/`) — separate from Smokescreen, runs on UDP/53 + TCP/53 with the same FQDN policy.

### What we leave behind from Smokescreen

These features exist in Smokescreen but we don't use them:

- **MITM / SSL-bump.** Out of scope per posture.
- **Statsd / Datadog metrics integration.** Reuse `mini-infra-server`'s existing metrics.
- **Per-tenant TLS CRL / cert pinning.** Single-tenant envs.
- **HTTP/2 frontend.** Apps speak HTTP/1.1 to the proxy.
- **Static YAML config + SIGHUP reload.** Replaced by admin API + atomic pointer swap.
- **TLS client cert / Proxy-Authorization auth.** Replaced by source-IP container-map lookup.

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
