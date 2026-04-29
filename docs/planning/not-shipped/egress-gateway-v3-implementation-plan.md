# Egress Gateway v3 — Implementation Plan

Status: **planned, not implemented**. Companion to [egress-gateway-v3-design.md](egress-gateway-v3-design.md) — that doc captures the *why*; this doc is a build-ready breakdown.

The work is split into **four phases**. Phases 1-3 each map to a landable PR; Phase 4 is a per-env rollout (no code, just configuration toggles). Each phase below is self-contained enough to hand to a single executor.

---

## Target architecture (reference)

### Posture

- Outbound HTTP/HTTPS from managed containers must traverse the **per-env egress gateway** at `http://egress-gateway:3128`. The gateway parses the destination (CONNECT request line for HTTPS, absolute-URI / `Host` header for HTTP), matches against the stack policy, and either splices upstream or returns `403`.
- DNS resolution uses Docker's default embedded resolver at `127.0.0.11`. No custom resolver injected. The gateway resolves external FQDNs on the app's behalf.
- All other outbound traffic from managed containers is **dropped at the host firewall** (`DOCKER-USER` chain). Only permitted destinations from a managed container are: the gateway proxy port, the env bridge subnet (peer-to-peer), and loopback.
- Bypass containers (`egressBypass: true`) skip proxy injection and the managed-container drop rules — they egress directly via the host. **Lateral isolation between managed and bypass on the same env bridge is not enforced by the firewall** (see [Out of scope](#out-of-scope-for-v3-explicitly-deferred)) — operators use Docker network topology (put bypass on a separate network) when isolation matters.
- QUIC (UDP/443) is dropped. Apps fall back to TCP/443 through the proxy.

### Components

| Component | Role | New for v3? |
|---|---|---|
| `egress-gateway` (per env) | Smokescreen-based forward proxy on TCP/3128. Single listener serves both HTTP and HTTPS CONNECT. | Replaces TS `egress-sidecar` |
| `egress-fw-agent` (host singleton) | Privileged container with `NET_ADMIN`/`NET_RAW` and `--network=host`. Owns iptables rules and ipsets. Reads NFLOG. | New |
| `mini-infra-server` services | `EnvFirewallManager`, extended `EgressLogIngester`, extended `stack-container-manager.ts`. Existing `EgressRulePusher` and `EgressContainerMapPusher` are unchanged. | New service + extensions |
| Managed app containers | `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` injected at create time. IP added to `managed-<env>` ipset on start. | Config change only |
| Bypass app containers | No proxy injection. Not tracked in any ipset. | Config change only |

### Component interaction

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
                                                       │ NET_ADMIN       │                 │
                                                       │ iptables, ipset │                 │
                                                       │ NFLOG reader    │                 │
                                                       │ NDJSON stdout   │                 │
                                                       └─────────────────┘                 │
                                                                                           │
                                                    stack-container-manager.ts manages app │
                                                       containers' env + ipset membership ◀┘
```

### Traffic flow

```
[ env's applications bridge network ]
  ┌─────────────────────────────────────────────────────────────────┐
  │  ┌──────────────────┐                  ┌───────────────────────┐│
  │  │ app container    │                  │  egress-gateway       ││
  │  │ HTTP_PROXY=──────┼──  :3128 ───────▶│   single listener:    ││
  │  │ HTTPS_PROXY=─────┼─  (same port)    │   • HTTP forward      ││
  │  │ NO_PROXY=peers   │                  │   • HTTPS CONNECT     ││
  │  │ DNS=127.0.0.11   │                  │   admin API           ││
  │  └──────────────────┘                  └───────────┬───────────┘│
  │           │                                        │            │
  └───────────┼────────────────────────────────────────┼────────────┘
              │                                        ▼
              │                           [ bridge → host → internet ]
              ▼
   Host firewall (DOCKER-USER), evaluated in order:
     src ∈ managed-<env>, ct established/related        → ACCEPT
     src ∈ managed-<env>, dst ∈ env-bridge CIDR         → ACCEPT        (gateway, peers, bypass)
     src ∈ managed-<env>                                → NFLOG + DROP
```

### Per container kind

| Kind | netns | DNS | In `managed-<env>` ipset | `HTTP_PROXY` injected | TCP path |
|---|---|---|---|---|---|
| Managed app | own | Docker default | yes | yes | via proxy → gateway → upstream |
| Bypass app | own | Docker default | no | no | direct out via bridge → host |
| Egress-gateway | own | Docker default | no | no | direct out via bridge → host |

### Iptables rule block (per env)

```
# Per-env block — installed once per env, refreshed on container churn.
# $ENV_BRIDGE_CIDR is the env applications bridge's CIDR.

# 1. Established / related — return traffic for in-bridge flows.
iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# 2. Allow within the env bridge (managed → managed peers, managed → gateway,
#    and managed → bypass — lateral isolation is via Docker network topology,
#    not the firewall).
iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -d $ENV_BRIDGE_CIDR -j ACCEPT

# 3. Catch-all NFLOG + DROP for everything else from managed containers.
iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -j NFLOG --nflog-group 1 --nflog-prefix "mini-infra-egress-drop "
iptables -A DOCKER-USER -m set --match-set managed-<env> src \
         -j DROP
```

### Wire contracts

**fw-agent (Unix socket at `/var/run/mini-infra/fw.sock`):**

```
POST /v1/env                          // applyEnvRules
  { env, bridgeCidr, mode: "observe" | "enforce" }
DELETE /v1/env/:env                   // removeEnvRules
POST /v1/ipset/:env/managed/add       // addManagedMember { ip }
POST /v1/ipset/:env/managed/del       // delManagedMember { ip }
POST /v1/ipset/:env/managed/sync      // syncManaged { ips: string[] } — full snapshot
GET  /v1/health
```

**Gateway admin API (per-env, HTTP):**

```
POST /admin/rules           // full env policy snapshot
POST /admin/container-map   // srcIp → (stackId, serviceName) snapshot
GET  /admin/health
```

Health response includes `listeners.proxy` and `listeners.admin` booleans.

### NDJSON event shapes

```jsonc
// HTTPS CONNECT (gateway)
{ "evt": "tcp", "protocol": "connect", "ts": "...", "srcIp": "...",
  "target": "api.example.com:443",
  "action": "allowed|blocked",
  "reason": "rule-deny|ip-literal|doh-denied|dial-failed|...",
  "matchedPattern": "*.example.com",
  "stackId": "...", "serviceName": "...",
  "bytesUp": 0, "bytesDown": 0, "mergedHits": 1 }

// HTTP forward proxy (gateway)
{ "evt": "tcp", "protocol": "http", "ts": "...", "srcIp": "...",
  "method": "GET", "target": "example.com", "path": "/some/path",
  "action": "allowed|blocked",
  "reason": "rule-deny|ip-literal|...",
  "matchedPattern": "*.example.com",
  "stackId": "...", "serviceName": "...",
  "status": 200, "bytesDown": 1234, "mergedHits": 1 }

// Firewall drop (egress-fw-agent)
{ "evt": "fw_drop", "protocol": "tcp|udp|icmp", "ts": "...",
  "srcIp": "...", "destIp": "...", "destPort": 5432,
  "stackId": "...", "serviceName": "...",
  "reason": "non-allowed-egress", "mergedHits": 1 }
```

Dedup window: 60s, key `srcIp + destIp + destPort + protocol`.

### Proxy env-var injection (managed services only)

```
HTTP_PROXY=http://egress-gateway:3128
HTTPS_PROXY=http://egress-gateway:3128
http_proxy=http://egress-gateway:3128
https_proxy=http://egress-gateway:3128
NO_PROXY=localhost,127.0.0.0/8,<envBridgeCidr>
no_proxy=localhost,127.0.0.0/8,<envBridgeCidr>
```

The `egress-gateway` hostname resolves via Docker's embedded DNS — the gateway runs with `--network-alias=egress-gateway` so its IP can change across recreates without rebaking app env vars.

---

## Phase 1 — Schema + Ingester

**Goal:** Make `EgressLogIngester` understand the new event shapes (`evt: "tcp"` with `protocol: "connect|http"`, `evt: "fw_drop"`) and persist their fields. No behaviour change at runtime — new columns are null on existing DNS-only events.

Ships independently of Phase 2 / 3.

### Changes

1. **Prisma migration** — add to `EgressEvent`:
   - `target` (string, nullable)
   - `method` (string, nullable)
   - `path` (string, nullable)
   - `status` (int, nullable)
   - `bytesUp` (bigint, nullable)
   - `bytesDown` (bigint, nullable)
   - `destIp` (string, nullable)
   - `destPort` (int, nullable)
   - extend `reason` enum/values to cover new strings (`rule-deny`, `ip-literal`, `doh-denied`, `dial-failed`, `non-allowed-egress`).

2. **`EgressLogIngester`** — extend the parser to recognise:
   - `evt: "tcp"` with `protocol: "connect"` → write `target`, `bytesUp`, `bytesDown`, `matchedPattern`.
   - `evt: "tcp"` with `protocol: "http"` → write `method`, `path`, `status`, `bytesDown`, `target`, `matchedPattern`.
   - `evt: "fw_drop"` → write `destIp`, `destPort`, `protocol`, `reason`.

3. **Container discovery** — extend the ingester's tail loop to also tail containers labelled `mini-infra.egress.fw-agent=true`, in addition to the existing `mini-infra.egress.gateway=true`.

### Tests

- Extend `egress-log-ingester.test.ts` with fixtures for each new event shape (CONNECT allowed, CONNECT blocked, HTTP allowed, HTTP blocked, fw_drop catch-all).
- Verify dedup behaviour with the new key (`srcIp + destIp + destPort + protocol`).

### Acceptance criteria

- Migration applies cleanly forward and back.
- All existing DNS-event tests still pass with null new columns.
- New fixtures parse and persist with all expected fields populated.

---

## Phase 2 — Go module scaffold + `egress-fw-agent` + `EnvFirewallManager`

**Goal:** Stand up the privileged firewall executor (`egress-fw-agent`) and the server-side service (`EnvFirewallManager`) that drives it. Ships behind a per-env feature flag in **observe mode** (NFLOG without DROP) so we can validate event flow before enforcing.

Phase 2 lands the gateway code path's *skeleton* (the binary builds and lives in the same image) but does not deploy or use it — that's Phase 3.

### 2.1 Create `egress-gateway/` Go module

Rename / create `egress-gateway/` (replacing `egress-sidecar/`'s slot in long term — keep the TS sidecar untouched until Phase 4).

Module layout:

```
egress-gateway/
  cmd/
    gateway/main.go                   # stub for now — Phase 3 fills it
    fw-agent/main.go                  # Phase 2 entry point

  internal/
    # shared
    config/        gateway_config.go
                   agent_config.go
    events/        emitter.go         # NDJSON stdout writer
                   dedup.go           # 60s dedup window
    log/           log.go             # slog wrapper, JSON handler

    # gateway only — stub in Phase 2, filled in Phase 3
    state/         rules.go
                   container_map.go
    proxy/         (empty in Phase 2)
    admin/         (empty in Phase 2)

    # agent only
    fw/            iptables.go        # `DOCKER-USER` rule block install/remove
                   ipset.go           # ipset create/destroy/add/del/sync
                   nflog.go           # libnetfilter_log subscriber → fw_drop events
                   api.go             # unix-socket HTTP server
                   reconcile.go       # boot-time reconcile against server inventory

  Dockerfile                          # multi-stage; both binaries in one image
  go.mod
  go.sum
```

Multi-stage Dockerfile: `golang:1.22-alpine` builder, `alpine:3.19` runtime with `iptables`, `ipset`, and `libnetfilter_log` packages installed. Both binaries available at `/usr/local/bin/egress-gateway` and `/usr/local/bin/egress-fw-agent`.

### 2.2 Implement `egress-fw-agent` — iptables + ipset

`internal/fw/iptables.go` and `internal/fw/ipset.go`:

- `applyEnvRules(env, bridgeCidr, mode)` — idempotent install of the per-env block (see [Iptables rule block](#iptables-rule-block-per-env)). In `observe` mode the `DROP` rule is skipped; only the `NFLOG` line is inserted. In `enforce` mode both NFLOG and DROP are inserted.
- `removeEnvRules(env)` — removes the per-env block and destroys the `managed-<env>` ipset.
- `addManagedMember`, `delManagedMember` — single-IP ipset edits.
- `syncManaged(env, ips)` — full snapshot using `ipset restore` (idempotent against current kernel state).

Constraints:
- All `iptables` / `ipset` calls go through `exec.Command` with explicit argv arrays. **Never** through a shell. No `sh -c`, no string interpolation into command lines.
- All operations idempotent — agent restart against existing kernel state must succeed.

### 2.3 Implement NFLOG reader

`internal/fw/nflog.go`:

- Subscribe to NFLOG group 1 via `libnetfilter_log` (cgo binding).
- Decode each packet's metadata: source IP, dest IP, dest port, protocol, NFLOG prefix.
- Map prefix → `reason`:
  - `mini-infra-egress-drop ` → `non-allowed-egress`
- Look up `(stackId, serviceName)` from a flat (host-wide) container map snapshot pushed by `mini-infra-server`.
- Emit NDJSON `evt: "fw_drop"` events on stdout, with 60s dedup keyed on `srcIp + destIp + destPort + protocol`.

### 2.4 Implement Unix-socket admin API + input validation

`internal/fw/api.go`:

Bind a Unix socket at `/var/run/mini-infra/fw.sock`. Implement the wire contract listed in [Wire contracts](#wire-contracts).

**Input validation (the entire trust boundary — has to be airtight):**

- `env` must match `^[a-z0-9][a-z0-9-]{0,30}$`. No path or shell metacharacters.
- `ip` must parse via `net.ParseIP` and fall within the named env's `bridgeCidr`.
- `bridgeCidr` must parse via `net.ParseCIDR` and not overlap host or loopback.
- All `iptables` / `ipset` invocation via explicit argv arrays.

**Adversarial-input unit tests are required.** Cover at least: path traversal in `env`, shell metacharacters in `env`, IPs outside `bridgeCidr`, `bridgeCidr` overlapping host/loopback, IPv6 in IPv4 context, oversized inputs, malformed JSON.

### 2.5 Compose deployment — host-singleton container

Add `egress-fw-agent` to the Mini Infra root compose definition (alongside `mini-infra-server`). Spec:

- `image: mini-infra/egress-gateway:<version>`
- `entrypoint: ["/usr/local/bin/egress-fw-agent"]`
- `network: host`
- `cap_add: ['NET_ADMIN', 'NET_RAW']`
- Volume mounts:
  - `/var/run/mini-infra/` (host) ↔ `/var/run/mini-infra/` (container)
  - `/lib/modules/` (host, read-only) — for kernel module access if `nf_log_ipv4` / `xt_set` need loading
- Labels: `mini-infra.egress.fw-agent=true`
- Env vars: `LOG_LEVEL`
- Restart policy: `unless-stopped`

Add a new volume mount on `mini-infra-server`: `/var/run/mini-infra/` (so it can connect to the agent's socket). No new capabilities, no new network changes on the server.

### 2.6 `EnvFirewallManager` service in `mini-infra-server`

New service. Responsibilities:

- Holds desired firewall state (in DB / in-memory).
- Calls `egress-fw-agent` over the Unix socket.
- Hooked into env create/destroy via `EnvironmentManager`.
- Owns reconcile loop on server boot **and** on Docker daemon socket reconnect.
- Subscribes to the Docker events stream via `dockerode` for per-container `start` / `die` / `destroy` events on managed envs and pushes ipset deltas to the agent.
- Mode flip API: `setMode(env, "observe" | "enforce")` calls `POST /v1/env` with the new mode.
- Outage handling: if the agent is down, queue ipset updates (with a bounded cap, drop oldest on overflow with loud logging) and surface a degraded-component banner. On recovery, drain the queue and run a full reconcile.

### 2.7 Wire ipset membership into `stack-container-manager.ts`

Extend `stack-container-manager.ts` lifecycle hooks:

- **Post-start (managed service):** after Docker assigns the container's IP and it transitions to `Running`, call `EnvFirewallManager.addManagedContainer(env, ip)`.
- **Post-start (bypass service):** no firewall action — bypass containers are not tracked in any ipset.
- **Post-stop (managed service):** call `EnvFirewallManager.delManagedContainer(env, ip)`.

The gateway container itself: not in the ipset, no `addContainer` call. Reachable from managed containers via the bridge-CIDR ACCEPT rule.

### Phase 2 acceptance criteria

- `egress-fw-agent` builds and runs against a Linux container with `NET_ADMIN`/`NET_RAW`.
- Adversarial-input tests pass for the agent.
- Per-env feature flag exists and defaults OFF.
- Opted-in env in observe mode produces `fw_drop` NDJSON events visible via `EgressLogIngester` (Phase 1 work picks them up).
- Integration test: spin up a temporary iptables ruleset and a real fw-agent in a Linux container; verify rules and ipset entries are inserted/removed correctly across:
  - env create/destroy
  - container start/stop
  - Docker daemon restart (reconcile fires)
  - agent restart (state survives, agent picks up where it left off)

---

## Phase 3 — `egress-gateway` (Smokescreen-based) + env injection

**Goal:** Land the per-env Smokescreen-backed gateway, swap it in for the TS `egress-sidecar`, and inject `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` into managed containers. Initially runs in Smokescreen's `report` mode (allows everything, logs decisions) when the per-env flag is flipped ON.

### 3.1 Add Smokescreen + implement wrapper

In `egress-gateway/`:

- Add `github.com/stripe/smokescreen` (pinned to a commit ≥ `7d45971`) to `go.mod`.

Implement `internal/proxy/`:

**`aclswap.go`** — `ACLSwapper` implements `acl.Decider` with `atomic.Pointer[*acl.ACL]`:

```go
type ACLSwapper struct {
    p atomic.Pointer[acl.ACL]
}

func (s *ACLSwapper) Decide(args acl.DecideArgs) (acl.Decision, error) {
    return s.p.Load().Decide(args)
}

func (s *ACLSwapper) Swap(newACL *acl.ACL) {
    s.p.Store(newACL)
}
```

**`role.go`** — `roleFromRequest` maps `r.RemoteAddr` → `stackId` via the container map:

```go
func (srv *Server) roleFromRequest(r *http.Request) (string, error) {
    src := remoteIP(r)
    attr := srv.containers.Lookup(src)
    if attr == nil {
        return "", smokescreen.MissingRoleError("unknown source")
    }
    return attr.StackID, nil
}
```

**`logadapter.go`** — `logrus.Hook` that translates Smokescreen log entries into our NDJSON `EgressEvent` shape on stdout. Pulls `bytes_in` / `bytes_out` from `CANONICAL-PROXY-CN-CLOSE` entries (so we don't need a custom `ConnTracker`).

**`doh_gate.go`** — `http.Handler` middleware that wraps the proxy and 403s known DoH endpoints regardless of stack rules (denylist of `dns.google`, `cloudflare-dns.com`, etc.). Pre-ACL gate.

**`compile.go`** — converts `StackPolicy` snapshot from `mini-infra-server` into a Smokescreen `*acl.ACL` (a tree of `acl.Rule` keyed by service/role). Run on each `POST /admin/rules`.

**`ipranges.go`** — built-in private/loopback/link-local CIDRs, populated as `[]smokescreen.RuleRange` for `Config.DenyRanges`. Covers RFC1918, loopback, link-local (incl. `169.254.169.254`), IPv6 ULA, multicast.

### 3.2 Implement gateway `main.go` + admin API

`cmd/gateway/main.go`:

```go
func main() {
    srv := newServer(loadConfig())

    sk := smokescreen.NewConfig()
    sk.RoleFromRequest = srv.roleFromRequest
    sk.EgressACL = srv.aclSwapper
    sk.DenyRanges = builtinPrivateRanges()
    sk.ConnectTimeout = 10 * time.Second
    sk.Log = newLogrusToNDJSON(srv.events)
    sk.AdditionalErrorMessageOnDeny = "egress denied by mini-infra policy; see UI"

    proxy := smokescreen.BuildProxy(sk)
    handler := srv.dohGateMiddleware(proxy)

    server := &http.Server{
        Addr:              ":3128",
        Handler:           handler,
        ReadHeaderTimeout: 30 * time.Second,
    }

    go srv.runAdminAPI(srv.aclSwapper)
    go srv.runHealthEndpoint()
    go srv.gracefulShutdownOn(syscall.SIGTERM, server)

    if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
        log.Fatal(err)
    }
}
```

**Critical: do not call `smokescreen.StartWithConfig(...)`** — it installs `signal.Notify(SIGUSR2, SIGTERM, SIGHUP)` on our process and we don't want SIGHUP behaviour. Use `BuildProxy(cfg)` and run the result under our own `http.Server`.

**Do not replace `ConnTracker`.** The `TrackerInterface` has 7 methods coupled to Smokescreen's internal `*InstrumentedConn`; re-implementing is not worth it. Pull byte counts via the logrus hook from `CANONICAL-PROXY-CN-CLOSE` entries.

**Implement admin API** in `internal/admin/server.go`:

- `POST /admin/rules` → `compile()` → `aclSwapper.Swap(newACL)`.
- `POST /admin/container-map` → `containerMap.Replace(snapshot)`.
- `GET /admin/health` → `{ ok, rulesVersion, uptimeSeconds, listeners: { proxy, admin } }`.

### 3.3 Container deployment swap

`EnvironmentManager` swaps the TS `egress-sidecar` for the Go `egress-gateway` image (same per-env container, just different binary in the existing slot).

Per-env `egress-gateway` container spec:

- `image: mini-infra/egress-gateway:<version>`
- `entrypoint: ["/usr/local/bin/egress-gateway"]`
- Joins the env's applications network with `--network-alias=egress-gateway` (no pinned IP)
- Labels: `mini-infra.egress.gateway=true`, `mini-infra.environment=<env>`
- Env vars: `PROXY_PORT=3128`, `LOG_LEVEL`
- No `cap_add`, no sysctls, no host network access

Discovery is unchanged from today — server finds the per-env gateway by container label.

### 3.4 Proxy env-var injection in `stack-container-manager.ts`

For managed (non-bypass) services, inject the env vars listed in [Proxy env-var injection](#proxy-env-var-injection-managed-services-only). Mirror the existing `egressBypass` skip pattern: bypass + host-level + non-environment stacks skip injection entirely. **Remove DNS injection** for both managed and bypass — Docker's default applies.

### 3.5 Wire `EgressRulePusher` into `ACLSwapper`

`EgressRulePusher` continues to push to one admin endpoint per env. The gateway's admin handler compiles the snapshot to an `*acl.ACL` and atomically swaps via `ACLSwapper.Swap()`. Wire contract is unchanged.

### Phase 3 acceptance criteria

- Gateway image builds; both binaries available.
- Gateway in `report` mode allows all traffic, logs every decision as NDJSON.
- Gateway in `enforce` mode 403s on rule-deny.
- Atomic ACL swap: rule push during in-flight requests does not panic or interleave decisions.
- SSRF defences validated via Smokescreen's existing `classifyAddr` path (test that internal IPs are denied even if on an allowlist).
- DoH denylist gate 403s known DoH endpoints regardless of stack rules.
- Integration test: managed app container resolves `egress-gateway` via Docker DNS and successfully proxies HTTPS through the gateway.
- Listener-up booleans exposed on `/admin/health`.
- Per-env feature flag (introduced in Phase 2) gates Phase 3 deployment.

---

## Phase 4 — Per-env enforce promotion + TS sidecar removal

No new code. Operational rollout work.

### 4.1 Per-env enforce promotion

Two independent flips per env:

1. **Gateway**: `report` → `enforce`. 403s on rule-deny.
2. **Firewall agent**: `observe` → `enforce`. Drops direct egress (the `DROP` lines added in addition to `NFLOG`).

Both are independent so we can stage. The promote-to-Enforce wizard from v2 handles per-stack progression.

For each env: validate observe-mode events for ≥ 1 week before flipping to enforce. Operators surface unexpected `fw_drop` events as "mark as bypass or fix the client" actions.

### 4.2 Phase out TS sidecar

Once **all** envs run v3, delete `egress-sidecar/`. Verify no lingering references in `EnvironmentManager`, compose definitions, or docs.

---

## Constraints, accepted limitations, and open spikes

Carry forward from the design doc. These shape implementation choices in the phases above.

**Constraints (non-negotiable):**

- All `iptables` / `ipset` calls must use explicit argv arrays. No shell. (Phase 2.)
- fw-agent input validation is the entire privilege boundary — adversarial-input tests are required for PR 2 acceptance. (Phase 2.4.)
- Do not call `smokescreen.StartWithConfig`. Do not replace `ConnTracker`. (Phase 3.2.)
- All Socket.IO / event work uses the existing channel/event constants from `lib/types/socket-events.ts` if applicable.

**Accepted limitations (document, do not mitigate):**

- **Container-start race window.** Between `docker start` and the post-start ipset add (~ms), the container is unfiltered.
- **Literal-IP egress lacks FQDN attribution.** `fw_drop` events include `destIp` but not the FQDN.
- **`NO_PROXY` is baked at container create time.** New peers added later don't appear in existing containers' `NO_PROXY`.
- **Gateway upgrade is a per-env outage.** ~1-5s of failed proxied egress while the gateway container is recreated.
- **Migration of existing envs is operator-driven.** Existing envs without proxy injection / ipset membership stay on current behaviour until each app is recreated under v3. We do not auto-recreate.

**Open spikes (call out and resolve before / during the relevant phase):**

- **WSL2 platform availability.** Confirm `xt_set`, `nfnetlink_log`, `libnetfilter_log1`, `ipset` are available on the canonical WSL2 base distro. (Block-of-work for early Phase 2.) Colima is verified.
- **WebSocket through CONNECT.** WSS goes through CONNECT; plain WS over HTTP traverses the HTTP forward proxy. Verify with a fixture during Phase 3.
- **Rule reload performance.** ipset membership churn during container start/stop must be sub-100ms. Benchmark with 50 containers/env during Phase 2.
- **fw-agent ↔ server outage queue cap.** Decide bounded cap and overflow behaviour (probably: drop oldest, log loudly). Phase 2.6.

---

## Out of scope for v3 (explicitly deferred)

- Arbitrary TCP allowlists (non-HTTP). Bypass is the escape hatch.
- TLS interception (SSL bump).
- Per-environment default policies (still per-stack only).
- Egress proxy for `mini-infra-server`'s own outbound calls.
- HTTP/3 / QUIC.
- Deep request body inspection.
- IPv6 (mirrors v1+v2).
- **Lateral isolation between managed and bypass containers on the same env bridge.** Operators control this via Docker network topology — put bypass services on a separate Docker network if isolation is required. Revisit if a compliance-driven posture later demands firewall-enforced lateral deny.
