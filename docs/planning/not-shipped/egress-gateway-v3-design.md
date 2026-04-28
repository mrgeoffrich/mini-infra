# Egress Gateway v3 — Compliance-grade enforcement (design)

Status: **planned, not implemented**. Successor to v1+v2 ([#263](https://github.com/mrgeoffrich/mini-infra/pull/263)) and the design referenced in [egress-firewall-future-work.md](egress-firewall-future-work.md) under "SNI-aware transparent proxy (phase 3)". This doc captures the concrete plan for the next phase: rewriting the gateway in Go, adding TCP-level enforcement via per-managed-container sidecars, and getting full audit visibility for denied traffic.

## Posture

**Compliance-grade.** Nothing leaves a managed container without an explicit rule match. Every blocked attempt produces an `EgressEvent` row.

Concretely:

- Outbound from managed containers: only **UDP/53 + TCP/53 to the env's DNS resolver**, **TCP/80**, and **TCP/443** are permitted by name-based policy. Everything else is blocked.
- TCP/80 and TCP/443 are transparently redirected to a local sidecar process, which parses SNI/Host, matches the stack's policy, and either splices the connection through to the original destination or closes it.
- All other outbound traffic (other TCP ports, non-DNS UDP, ICMP) is also redirected to the sidecar, where it's logged and dropped.
- Bypass containers (`egressBypass: true` in their service config) are exempt from all of the above and egress directly via the host.

QUIC (UDP/443) is captured by the catchall and logged as blocked.

## Why per-managed-container sidecars (and not a central gateway)

The natural-feeling design is a single egress-gateway per env that intercepts all managed-container TCP. We worked through that and it doesn't survive contact with Docker's networking model.

The killer constraint: when nftables in container A's netns DNATs a TCP connection to gateway B, the conntrack entry recording the rewrite lives in A's netns. By the time the connection reaches B, B's own conntrack only sees the rewritten destination. `SO_ORIGINAL_DST` in B returns B's IP — the original target the app was trying to reach is **lost**.

Istio dodges this by running its proxy in the *same* netns as the app (Pod model). Plain Docker has no Pod abstraction, but it does support `--network=container:X` for shared netns — which gives us the same property: DNAT and proxy share a conntrack table, `SO_ORIGINAL_DST` works.

A survey of the official Docker docs confirms there's no L3-via-peer primitive (`--gateway` only points at the host's bridge interface; ipvlan L3 explicitly forbids peer-as-next-hop; macvlan/ipvlan bypass docker0 entirely; `--network=container:X` requires the owner to be running). So the doc-blessed options for "intercept egress through a chosen container" are:

1. **Per-netns sidecar** (this design). Each managed container shares a netns with a small sidecar that handles enforcement.
2. **Host-netns nftables + gateway in `--network=host`**. Works for `SO_ORIGINAL_DST` but breaks per-env isolation, fights Docker's own chains, and is platform-divergent (Linux native vs Colima VM vs WSL2 distro).

Option 1 fits Mini Infra's per-env isolation model. Option 2 doesn't. We're going with 1.

## Component renames and binaries

The current `egress-sidecar/` directory becomes `egress-gateway/` — a single Go module producing **two binaries** packaged in **one image** (`mini-infra-egress-gateway`):

- **`egress-gateway`** (binary): the per-env DNS resolver. One per environment. Same admin contract as today's TS sidecar. Handles DNS policy and audit. Doesn't deal with TCP at all.
- **`egress-sidecar`** (binary): the per-managed-container TCP enforcer. One per managed app container. Owns the netns its app shares. Handles SNI/Host inspection, catchall logging, and per-stack rule enforcement.

Two binaries, one image, same Go module — sharing the rule trie, log emitter, admin server, etc.

## Architecture

### How traffic flows in v3

Each managed app container is paired with an `egress-sidecar` container. They share a network namespace via `--network=container:<sidecar>` — the sidecar starts first, owns the netns, and the app joins it.

```
[ env's applications bridge network ]
  ┌───────────────────────────────────────────┐ ┌──────────────────────┐
  │  shared netns (sidecar + app)             │ │  egress-gateway      │
  │                                           │ │  (per-env DNS)       │
  │  ┌─────────────────┐  ┌────────────────┐  │ │                      │
  │  │ app container   │  │ sidecar        │  │ │  ┌────────────────┐  │
  │  │                 │  │                │  │ │  │ DNS server     │  │
  │  │ connect()  ─────┼─▶│ nft (own netns)│  │ │  │ on UDP/53      │  │
  │  │                 │  │  ↓ REDIRECT    │  │ │  │  + TCP/53      │  │
  │  │  resolv.conf:   │  │ proxy listener │  │ │  └────────────────┘  │
  │  │  gateway-ip ────┼──┼────────────────┼──┼─┼─▶ admin API (rules,  │
  │  │                 │  │  ↓ allow       │  │ │   container-map)     │
  │  │                 │  │ dial(orig_dst) │  │ │                      │
  │  └─────────────────┘  └────────┬───────┘  │ │                      │
  │                                │          │ └──────────┬───────────┘
  └────────────────────────────────┼──────────┘            │
                                   ▼                       ▼
                              [ bridge → host → internet ]
```

Per container kind:

| Kind | netns | DNS resolver | nftables in netns | Sidecar paired | TCP path |
|---|---|---|---|---|---|
| Managed app | shared with sidecar | `[gatewayIp]` (injected) | yes — installed by sidecar at boot | yes | DNAT → sidecar (localhost) → splice or drop |
| Bypass app | own (Docker default) | Docker default | no | no | direct out via bridge → host |
| Egress-sidecar | own (becomes shared) | Docker default | yes — its own | self | direct out via bridge → host |
| Egress-gateway (DNS) | own (Docker default) | Docker default | no | no | direct out via bridge → host |

### Per-container nftables rules (in the sidecar's netns)

Installed by the sidecar binary at startup (`egress-sidecar` self-initialises before opening listening sockets). Rules live in the `inet` family in the **output chain** — affecting egress from the netns, which both the sidecar's own outbound and the app's outbound traverse.

```
table inet egress {
  chain output {
    type nat hook output priority dstnat;

    # Localhost — required so the sidecar's own listeners are reachable
    # and so its outbound proxied connections work.
    ip daddr 127.0.0.0/8 accept

    # Local network traffic (peer containers on the env bridge) — let through.
    ip daddr $LOCAL_CIDRS accept

    # DNS to gateway only — explicit allow on UDP and TCP.
    udp dport 53 ip daddr $GATEWAY_IP accept
    tcp dport 53 ip daddr $GATEWAY_IP accept

    # HTTP/HTTPS to localhost listeners (sidecar binds here).
    # REDIRECT, not DNAT — listener is in the same netns, so we just
    # rewrite the destination to localhost on the sidecar's port.
    tcp dport 80  redirect to :$HTTP_PORT
    tcp dport 443 redirect to :$HTTPS_PORT

    # Catchall TCP — anything not handled above goes to a logging port.
    tcp redirect to :$TCP_CATCHALL_PORT

    # Catchall UDP — same idea.
    udp redirect to :$UDP_CATCHALL_PORT

    # ICMP — drop (no useful redirect target).
    ip protocol icmp drop
  }

  chain output_filter {
    type filter hook output priority filter; policy drop;

    # Stateful return.
    ct state established,related accept

    # Anything that survived the nat hook with an unexpected destination.
    ip daddr 127.0.0.0/8 accept
    ip daddr $LOCAL_CIDRS accept
    ip daddr $GATEWAY_IP accept
  }
}
```

`$LOCAL_CIDRS` covers the env's bridge subnet so peer-to-peer traffic isn't policed. `$GATEWAY_IP` is the per-env DNS gateway's pinned IP. Ports are configured per sidecar.

The sidecar's own outbound traffic (proxied connections that it's forwarding on behalf of the app) also traverses these rules. The flow is:

1. App calls `connect("evil.com:443")`. Kernel resolves `evil.com` (via DNS at the gateway) to some IP X.
2. App sends SYN to `X:443`. Hits `tcp dport 443 redirect to :$HTTPS_PORT` → rewritten to `127.0.0.1:$HTTPS_PORT`. Conntrack entry created in this netns.
3. Sidecar accepts the connection. Calls `getsockopt(SO_ORIGINAL_DST)` → returns `X:443` from this netns's conntrack. ✓
4. Sidecar parses TLS ClientHello, extracts SNI, matches policy.
5. Allowed → sidecar dials `X:443`. SYN goes through the same chain, hits `ct state established,related accept` (no, that's for return — actually new outbound from sidecar: `tcp dport 443 redirect to :$HTTPS_PORT` would catch its own outbound and loop it back to itself).

The loop is real. Two options to break it:

- **Mark sidecar's own sockets** with `SO_MARK` and exempt marked traffic in nftables: `meta mark 0x1234 accept` early in the chain.
- **Run sidecar's outbound dialler in a different netns** (no — defeats the whole point).

Going with `SO_MARK`. The sidecar sets `SO_MARK = 0x1` on every dialled socket; the chain's first rule is `meta mark 0x1 accept`. This is the standard pattern for Linux transparent proxies.

### Sidecar self-init and startup ordering

`egress-sidecar` PID 1 runs:

1. **Parse env** (gateway IP, local CIDRs, ports, stack ID, service name, log level).
2. **Install nftables table** via `github.com/google/nftables`. This happens *before* any network-using code runs.
3. **Open listening sockets** on `$HTTP_PORT`, `$HTTPS_PORT`, `$TCP_CATCHALL_PORT`, `$UDP_CATCHALL_PORT`, `$ADMIN_PORT`. All bound to `0.0.0.0`.
4. **Set `SO_MARK` on the global net.Dialer** (or use a per-call `Control` callback) so sidecar's outbound traffic is exempt from the redirect rules.
5. **Become ready.** A health endpoint flips green; the app container can now start.

Stack-container-manager waits for the sidecar's health endpoint to report ready before starting the paired app container.

Shutdown: SIGTERM stops accept loops, drains in-flight connections (5s deadline), flushes the dedup buffer, exits. The nftables table is destroyed when the netns is destroyed (when both sidecar and app stop).

### Sidecar lifecycle coupling

Without K8s Pods, we manage the sidecar+app pair in `stack-container-manager.ts`:

- **Create order:** sidecar created → sidecar started → wait for sidecar health → app created (with `--network=container:<sidecar>`) → app started.
- **Stop order:** app stopped → app removed → sidecar stopped → sidecar removed.
- **Sidecar crash:** if the sidecar process dies, its container exits. Docker's restart policy on the sidecar can restart it, but the netns is destroyed when the sidecar container exits, which means **the app's network is gone too** — its `--network=container:` reference is dangling. Docker handles this differently across versions; in practice the app needs to be recreated (not just restarted) after sidecar replacement.
- **App crash:** doesn't affect the sidecar. Docker restarts the app per its own restart policy; the existing sidecar netns is reused.
- **Compliance fail-mode:** sidecar dying = app loses network = no traffic escapes. This is the *correct* fail-mode for a compliance posture.

This is the lifecycle headache K8s solves with Pods. We're paying for it explicitly in `stack-container-manager.ts` instead.

### The per-env DNS gateway

The DNS gateway is conceptually unchanged from today's TS sidecar: per-env service, listens on UDP/53 + TCP/53 on a pinned IP, holds the rule trie + container map, applies stack policy to DNS queries, forwards allowed queries upstream, logs everything as `EgressEvent`s.

It's a Go rewrite — same admin contract, same trie matcher, same NDJSON event shape on stdout — but no longer has any TCP-handling responsibilities. Container map is still needed here because DNS queries come from many source containers and the gateway needs `srcIp → (stackId, serviceName)` for attribution.

### DNS path (end-to-end)

1. **Container DNS config.** At create time, `stack-container-manager.ts` injects `HostConfig.Dns: [egressGatewayIp]` on the **app container** (existing behaviour).
2. **App calls `getaddrinfo("api.example.com")`.** glibc reads `/etc/resolv.conf`, sends UDP/53 to `gateway_ip:53`.
3. **Sidecar's netns rules.** Hits `udp dport 53 ip daddr $GATEWAY_IP accept` — terminal accept, no redirect. Packet leaves the netns.
4. **Bridge → gateway netns.** Packet arrives at gateway's UDP/53 listener.
5. **Gateway evaluates.** Looks up `srcIp` in container map → `(stackId, serviceName)`. Runs trie matcher. Allowed → forward upstream; blocked → respond NXDOMAIN; observed (detect mode) → forward and log.
6. **Reply.** Upstream → gateway → managed container. Event line emitted on stdout.

DNS to non-gateway resolvers is blocked: `udp dport 53 ip daddr $GATEWAY_IP accept` doesn't match (different daddr), packet falls through to the UDP catchall, sidecar logs `protocol: "udp"`, `destPort: 53`, `action: "blocked"`, `reason: "non-gateway-dns"`.

DoH leak (`dns.google`, `cloudflare-dns.com` over :443) is unchanged from earlier discussion: known limitation, mitigate via a built-in DoH-domains denylist applied on top of stack rules.

## Hot path

### HTTPS connection in the sidecar

```go
// Same netns as the app — SO_ORIGINAL_DST works locally.
func handleTLSConn(c *net.TCPConn) {
    defer c.Close()
    origDst, _ := getOrigDst(c)                              // SO_ORIGINAL_DST → real (IP, port)

    br := bufio.NewReader(c)
    hello, err := peekClientHello(br)
    if err != nil { events.Block(c, "no-clienthello", origDst); return }
    if hello.SNI == "" { events.Block(c, "no-sni", origDst); return }

    decision := state.Match(hello.SNI)                       // sidecar holds only its stack's rules
    if decision.Mode == "enforce" && decision.Action == "block" {
        events.Block(c, "rule-deny", origDst, decision.MatchedPattern); return
    }

    upstream, err := markedDial(origDst)                     // SO_MARK = 0x1 → exempt from redirect
    if err != nil { events.Block(c, "dial-failed", origDst); return }
    defer upstream.Close()

    upstream.Write(br.Buffered())                            // replay peeked bytes
    splice(c, upstream, hello.SNI, decision)                 // bidirectional io.Copy + final event
}
```

### Catchall

```go
func handleCatchallTCP(c *net.TCPConn) {
    defer c.Close()
    origDst, _ := getOrigDst(c)
    events.Block(c, "non-allowed-port", origDst)
    // No splice — RST/close.
}
```

## Logging — full visibility

NDJSON on stdout per binary. Server-side `EgressLogIngester` already tails per-container stdout — it just adds N more containers to tail (the sidecars), and recognises new event shapes.

```jsonc
// DNS query (gateway, existing — unchanged)
{ "evt": "dns", "protocol": "dns", "ts": "...", "srcIp": "...",
  "qname": "...", "qtype": "A", "action": "allowed|blocked|observed",
  "matchedPattern": "...", "stackId": "...", "serviceName": "...",
  "mergedHits": 1 }

// TCP HTTP/HTTPS — sidecar decision
{ "evt": "tcp", "protocol": "sni" | "http", "ts": "...",
  "destIp": "...", "destPort": 443,
  "sni": "api.example.com", "host": "api.example.com",
  "action": "allowed|blocked|observed",
  "matchedPattern": "*.example.com",
  "stackId": "...", "serviceName": "...",
  "bytesUp": 0, "bytesDown": 0, "mergedHits": 1 }

// TCP catchall — sidecar logs + drops
{ "evt": "tcp", "protocol": "raw", "ts": "...",
  "destIp": "...", "destPort": 5432,
  "action": "blocked", "reason": "non-allowed-port",
  "stackId": "...", "serviceName": "...", "mergedHits": 1 }

// UDP catchall — sidecar logs + drops
{ "evt": "udp", "protocol": "raw", "ts": "...",
  "destIp": "...", "destPort": 443,
  "action": "blocked", "reason": "non-allowed-protocol",
  "stackId": "...", "serviceName": "...", "mergedHits": 1 }
```

Sidecar events don't need `srcIp` — there's only one source per sidecar (the paired app), and `stackId`/`serviceName` are baked into the sidecar's config at create time.

Same dedup window (60s, key `destIp + destPort + protocol`) keeps volume sane.

## Wire contract

### Server pushes

The server now pushes to **two kinds of admin endpoints** per env:

- **One DNS gateway** per env (existing). Receives `POST /admin/rules` (full snapshot) and `POST /admin/container-map` (full snapshot).
- **N sidecars** per env (new). Each receives `POST /admin/rules` with **only the rules for its stack** (subset of the full snapshot). No container-map needed at sidecars.

Both admin endpoints share the same Go code via the shared module. Same validation, same versioning, same response shape.

Discovery: server finds sidecars via container labels `mini-infra.egress.sidecar=true` + `mini-infra.environment=<env>` + `mini-infra.stack=<stackId>`. The server's existing `EgressRulePusher` is extended to iterate (gateway + sidecars) when pushing.

### Admin contract additions

```ts
// GET /admin/health on a sidecar
interface SidecarHealthResponse {
  ok: true;
  rulesVersion: number;
  stackId: string;
  serviceName: string;
  uptimeSeconds: number;
  netfilter: { tableInstalled: boolean };
  proxy: {
    httpListenerUp: boolean;
    httpsListenerUp: boolean;
    tcpCatchallListenerUp: boolean;
    udpCatchallListenerUp: boolean;
  };
}
```

Gateway health response is unchanged from today.

## Go module design

```
egress-gateway/
  cmd/
    gateway/main.go                   # gateway binary entry
    sidecar/main.go                   # sidecar binary entry

  internal/
    config/        gateway_config.go  # gateway env-var binding
                   sidecar_config.go  # sidecar env-var binding
    state/         rules.go           # rule trie + version state
                   container_map.go   # gateway-only — srcIp → (stackId, serviceName)
    match/         trie.go            # wildcard suffix trie
                   compile.go         # StackPolicy → compiled lookup tables
                   lookup.go          # host → action

    dns/           server.go          # miekg/dns combined UDP/TCP listener (gateway only)
                   forward.go         # upstream pool with health
                   handler.go         # query → match → respond/NXDOMAIN

    proxy/         http_listener.go   # sidecar — peek Host, match, splice
                   https_listener.go  # sidecar — peek SNI, match, splice
                   tcp_catchall.go    # sidecar — log + RST
                   udp_catchall.go    # sidecar — log + drop
                   sniff.go           # ClientHello + HTTP request peek-and-parse
                   splice.go          # bidirectional io.Copy
                   origdst.go         # SO_ORIGINAL_DST
                   marked_dial.go     # SO_MARK on outbound

    nft/           rules.go           # generate sidecar's nftables ruleset
                   apply.go           # apply via go-nftables (used by cmd/sidecar)

    admin/         server.go          # /admin/rules, /admin/container-map (gateway), /admin/health
                   validate.go        # request validation

    events/        emitter.go         # NDJSON stdout writer
                   dedup.go           # 60s dedup window

    log/           log.go             # slog wrapper, JSON handler

  Dockerfile                          # multi-stage; builds both binaries into one image
  go.mod
  go.sum
```

## Container deployment

### Sidecar image

Single image `mini-infra-egress-gateway` with two binaries (`/usr/local/bin/egress-gateway`, `/usr/local/bin/egress-sidecar`). Multi-stage build: `golang:1.22-alpine` for build, `alpine:3.19` for runtime (need `iproute2` and `nftables` packages for diagnostics). Final image ~15 MB.

### Sidecar container spec

Created by `stack-container-manager.ts` for each managed (non-bypass) service:

- `image: mini-infra/egress-gateway:<version>`
- `entrypoint: ["/usr/local/bin/egress-sidecar"]`
- `cap_add: ['NET_ADMIN']`
- Sysctls: `net.ipv4.conf.all.route_localnet=1` (needed for REDIRECT to localhost)
- Joins the env's applications network with its own IP
- Labels: `mini-infra.egress.sidecar=true`, `mini-infra.environment=<env>`, `mini-infra.stack=<stackId>`, `mini-infra.service=<serviceName>`
- Env vars: `GATEWAY_IP`, `LOCAL_CIDRS`, `STACK_ID`, `SERVICE_NAME`, ports

### App container spec changes

For managed (non-bypass) services, two changes:

- `--network=container:<sidecar-container-id>` instead of joining the bridge directly.
- DNS injection (`HostConfig.Dns: [gatewayIp]`) — unchanged from today.

Bypass services and the gateway itself are unaffected.

## Server-side changes

Three landable PRs:

### PR 1 — Schema + ingester
- Update `EgressLogIngester` to parse the new event shapes (`evt: "tcp"`, `evt: "udp"` with `protocol: "sni|http|raw"`).
- Add `destIp`, `destPort`, `bytesUp`, `bytesDown`, `l4proto` columns to `EgressEvent` (Prisma migration).
- Tail container stdout from sidecars (label-based discovery: `mini-infra.egress.sidecar=true`) in addition to the gateway.
- Tests: extend `egress-log-ingester.test.ts` with fixtures for each new event shape and sidecar discovery.
- Ships independently; new columns null on DNS-only events.

### PR 2 — Sidecar pairing in stack-container-manager
- New `EgressSidecarManager` service: creates the sidecar container, waits for its health endpoint, returns its container ID.
- `stack-container-manager.ts` calls it before creating the app container for managed services. App's network config switches to `--network=container:<sidecarId>`.
- Bypass + host-level + non-environment stacks skip this entirely (mirrors the existing `egressBypass` skip for DNS injection).
- Stop/remove ordering: app first, sidecar second.
- Failure → fail the stack apply with a clear error.
- Tests: integration tests in `stack-container-manager-egress.test.ts` covering the sidecar+app pairing, bypass path, and crash/restart edges.

### PR 3 — Build pipeline + binary swap
- New `egress-gateway/` Go module with both binaries.
- Replace `egress-sidecar/` Dockerfile and pnpm script.
- Extend `EgressRulePusher` to push to N sidecars per env in addition to the gateway. Container map pusher remains gateway-only.
- The pushers, socket emitter, lifecycle service, and frontend rules UI are otherwise untouched.
- Land behind a per-environment feature flag for dark launch.

## Phasing / rollout

1. **PR 1** (server-side prep) — lands independently, no behaviour change.
2. **Spike** the sidecar lifecycle on Mini Infra's supported Docker version range. Confirm:
   - `--network=container:<sidecar>` works reliably when sidecar is up
   - Sidecar restart-after-crash story (does the app container still work, or need recreation?)
   - Cold-start ordering (sidecar health-ready before app starts)
3. **PR 2** lands sidecar pairing **behind a per-env feature flag**. Default off — no behaviour change for existing envs.
4. **PR 3** ships the Go gateway + sidecar binaries in **detect mode forced**. Userland always splices through (catchall accepts and drops with `wouldHaveBeen` set). Validates every code path without breaking traffic.
5. **Per-env enforce promotion.** Flip the env feature flag; catchall starts dropping; per-stack rules become authoritative. The promote-to-Enforce wizard from v2 handles per-stack progression.
6. **Phase out the TS sidecar.** Once all envs run v3, delete `egress-sidecar/`.

## Open decisions / spike items

- **Sidecar restart-after-crash UX.** What does Docker do to an app container whose `--network=container:` target has died and been replaced? If the answer is "app needs recreation", `EgressSidecarManager` needs to coordinate that. Spike.
- **Health-ready signalling.** Sidecar exposes a health endpoint; stack-container-manager waits on it. Decide between Docker healthcheck (slower, polls) or a direct HTTP poll from server during create. Probably the latter for tighter ordering.
- **Catchall UDP rate-limiting.** UDP is connectionless; a misbehaving app can flood the listener. 60s dedup window covers logging volume; need to also cap socket reads to avoid CPU starvation. Bound at e.g. 10k pkt/s per sidecar.
- **`SO_MARK` value.** Pick a fixed value (e.g. `0x1`) and document. Make sure no host-side process uses the same mark for something incompatible — should be safe per-netns but worth noting.
- **DoH denylist.** Built into the gateway as a hardcoded list of known DoH endpoints, applied as implicit blocks before stack-policy evaluation. Or operators add explicit blocks. Probably both — built-in default with override capability.
- **IPv6.** v1+v2 are IPv4-only; v3 mirrors that. nftables `inet` family is ready; need IPv6 config for `$LOCAL_CIDRS` and gateway IPv6 if/when we cross that bridge.
- **Resource budget.** Per sidecar: ~15 MB RSS idle, ~30 MB under load. 20 services per env ≈ 300-600 MB across sidecars. Per-env DNS gateway ≈ 15-25 MB. Total per env: ~325-625 MB. Up from current TS sidecar's ~50-80 MB per env, but the sidecar count is the trade for `SO_ORIGINAL_DST` working.

## Out of scope for v3 (explicitly deferred)

- **Arbitrary TCP allowlists** (e.g. "allow this stack to reach `pg.example.com:5432`"). Compliance posture says no — only :80/:443 with name-based rules. Could be a v4 feature with explicit `tcp-allow` rule type.
- **Per-environment default policies.** Still per-stack only; see [egress-firewall-future-work.md](egress-firewall-future-work.md) "What's not on this list".
- **Egress proxy for the host itself** (mini-infra-server's own outbound calls to Cloudflare, Azure, ACME). Out of scope; host is trusted.
- **HTTP/3 with full handshake completion.** Captured at catchall as a blocked attempt; no inspection of QUIC payload.
- **K8s-style Pod abstraction in Mini Infra.** We're managing the sidecar+app pair manually in `stack-container-manager.ts` rather than building a generalised pod primitive. If we ever add other "must travel together" service types (e.g. Vault Agent, log shippers), revisit.
