# OpenTelemetry Tracing — Adding Tempo to the Monitoring Stack

**Status:** planned, not implemented. Phased rollout — each phase is a separate Linear issue.
**Builds on:** the existing `monitoring` stack (Prometheus + Loki + Alloy + Telegraf, see [server/templates/monitoring/template.json](../../../server/templates/monitoring/template.json)) and the `NatsBus` chokepoint shipped through Phase 3 of the [internal-nats-messaging-plan](./internal-nats-messaging-plan.md).
**Pairs with:** [docs/architecture/internal-messaging.md](../../architecture/internal-messaging.md) — once tracing lands, that doc gets the trace-context propagation rules added to §3 and a worked end-to-end example in §5.

---

## 1. Background

We can already see what individual components are doing in isolation: Prometheus shows container-level metrics, Loki has every container's stdout, Pino NDJSON files carry `requestId` and `operationId` correlators inside the server. What we **can't** do today is follow a single request across components — for example, a UI click that triggers a stack apply that pushes firewall rules to `egress-fw-agent` over NATS that updates iptables and emits a heartbeat. That request touches Express, Prisma, Docker, NATS, JetStream, KV, Postgres, and a Go sidecar; we have eight separate logs and no spine that joins them.

The standard answer is **distributed tracing**: every component instrumented with OpenTelemetry, every cross-process boundary propagating a W3C `traceparent`, every span shipped to a single backend that knows how to render the call graph and the service map. We already have Prometheus and Loki for metrics and logs; this plan adds the third signal, **traces**, to the same monitoring stack.

The lucky structural fact: thanks to Phases 1–3 of the NATS messaging migration, **every system-internal cross-component message already goes through one chokepoint per language** — `NatsBus` in TypeScript, `egress-shared/natsbus` in Go. Instrument those once and every NATS hop is in traces for free. Without that chokepoint this plan would be much larger.

## 2. Goals

1. **One trace backend, in the existing monitoring stack.** Add **Grafana Tempo** as a fifth service in the `monitoring` template. Same operator surface, same lifecycle, same volumes pattern as Loki/Prometheus.
2. **One ingestion path.** An **OpenTelemetry Collector** alongside Tempo. All instrumented processes export OTLP to the collector; the collector decides where signals go. Application code never talks to a backend directly.
3. **Trace context across NATS, transparently.** Inject/extract W3C `traceparent` headers at the bus chokepoint — `NatsBus.publish/request/subscribe/respond` and the JetStream wrappers, plus the Go counterpart. Application code stays unaware.
4. **Logs ↔ traces ↔ metrics correlation in Grafana.** Add Grafana to the monitoring stack (it isn't there today) so a Pino log line's `trace_id` field links to the Tempo trace, and the trace's spans link to Loki logs and Prometheus metrics on the same time window.
5. **Service map for free.** Enable Tempo's `metrics-generator` so service-graph metrics flow into Prometheus and the call graph renders as a Grafana Node Graph panel. This is the literal "see all interactions between components" view.
6. **No app-level metrics in this plan.** Prometheus already scrapes container-level data through Telegraf; that's enough for now. Custom request-rate / NATS-publish-rate metrics are a separate follow-up.

## 3. Non-goals

- **Replacing Loki or Prometheus.** Both stay. This plan adds Tempo, not a replacement.
- **Migrating away from Pino.** Pino stays. We add `@opentelemetry/instrumentation-pino` (or a small mixin) so `trace_id` / `span_id` ride on every log line. The existing `component`, `subcomponent`, `requestId`, `operationId` fields are unchanged.
- **Replacing the `*_STARTED → *_STEP → *_COMPLETED` Socket.IO triplet.** Tracing is for engineers; the triplet is for end users. They serve different audiences and stay parallel.
- **Tracing `pg-az-backup`.** It's a one-shot Bash + Node script behind a Docker exec; the cost of context propagation through the shell boundary outweighs the benefit. Skip.
- **App-level metrics (`prom-client`, `http_requests_total`, etc.).** Out of scope; covered as an optional Phase 6.

## 4. Architecture

### 4.1 Where Tempo lives

```
                      Mini Infra monitoring stack (existing)
       ┌─────────────────────────────────────────────────────────────┐
       │                                                             │
       │  telegraf  ─▶  prometheus  ◀── alloy (log shipper)          │
       │                                  │                          │
       │                                  ▼                          │
       │                                loki                         │
       │                                                             │
       │  ┌───────── new ──────────┐                                 │
       │  │                        │                                 │
       │  │  otel-collector  ─▶  tempo                               │
       │  │       ▲                │                                 │
       │  │       │                ▼                                 │
       │  │   (OTLP gRPC      tempo_data volume                      │
       │  │    :4317,                                                │
       │  │    HTTP :4318)                                           │
       │  └────────────────────────┘                                 │
       │                                                             │
       │  grafana ◀──── all four backends as data sources            │
       │                                                             │
       └─────────────────────────────────────────────────────────────┘
                            ▲
                            │  OTLP from instrumented apps
        ┌───────────────────┴────────────────────┐
        │   server, agent-sidecar, update-       │
        │   sidecar (Node), egress-gateway,      │
        │   egress-fw-agent (Go)                 │
        └────────────────────────────────────────┘
```

Tempo and the OTel Collector join the existing `monitoring_network` bridge. The collector exposes OTLP on `:4317` (gRPC) and `:4318` (HTTP); applications dial it as `monitoring-otel-collector:4317` from inside Docker. Tempo writes to a new `tempo_data` named volume, mirroring how Loki uses `loki_data`.

### 4.2 Why a collector, not direct OTLP to Tempo

Three reasons that justify the extra container:

- **One pipeline, two backends.** The collector fans out to Tempo (traces) **and** to Prometheus (service-graph metrics derived from spans, see §4.4). One config, no per-app branching.
- **Sampling & redaction at the boundary.** Tail-based sampling, attribute scrubbing, and rate limiting live in the collector — applications stay simple. The fw-agent's NFLOG events especially benefit: we'll drop spans for high-cardinality decisions and keep only the aggregates.
- **Backend-agnostic apps.** If we ever add a second trace backend (or move to a hosted one), only the collector config changes. The instrumentation isn't aware of Tempo.

### 4.3 Adding Grafana

Grafana is not in the monitoring stack today — the server's `/api/monitoring/*` routes proxy Prometheus and Loki directly. That works for two signals; for traces it doesn't:

- The server would need to re-implement Tempo's TraceQL search, the trace waterfall, and the service-graph node panel from scratch.
- Cross-signal correlation (click `trace_id` in a log → jump to trace → jump to a span's logs) is what Grafana is for. Building it in our own UI is months of work for parity, not differentiation.

So this plan **adds Grafana** as a sixth service in the monitoring template. The existing `/api/monitoring/*` proxy routes stay (the in-app help, agent-sidecar, and embedded panels keep working); Grafana opens in a new tab for tracing-heavy workflows. We can fold the proxy routes into Grafana iframes later if we want to unify, but that's a separate UX decision.

Alternative considered and rejected: **keep Grafana out and proxy Tempo through the existing routes**. We don't get the service-map view for free, and TraceQL via REST is a meaningful UI surface to recreate. The added container is cheaper than the recreated UI.

### 4.4 Service map for free — Tempo metrics-generator

Tempo's [metrics-generator](https://grafana.com/docs/tempo/latest/metrics-generator/) processes incoming spans and emits two Prometheus metrics:

- `traces_spanmetrics_*` — request rate, error rate, latency per service.
- `traces_service_graph_request_total{client, server}` — the edge metric for the service graph.

Pointed at the existing Prometheus, the result is a Grafana Node Graph panel that shows every component as a node and every call as an edge with rate/error/latency overlays. Built-in dashboards exist; we provision them via Grafana's file-based provisioning so the template is self-contained.

## 5. The shared instrumentation chokepoints

Same DRY rule as `NatsBus` and `DockerService`: instrument the chokepoint once, never instrument call sites.

### 5.1 Server (Node) — `server/src/lib/otel.ts` (new)

A single module imported **first** in `server/src/server.ts` (before anything else, including the logger factory) that:

1. Initialises `@opentelemetry/sdk-node` with the OTLP exporter pointing at `OTEL_EXPORTER_OTLP_ENDPOINT` (env var, injected by template `dynamicEnv`).
2. Registers auto-instrumentations: `http`, `express`, `pg` (Prisma), `socket.io`, `undici` (used by node-fetch / our HTTP clients).
3. Registers the W3C `TraceContext` propagator. This is the default; we name it explicitly so the rule is greppable.
4. Wires `@opentelemetry/instrumentation-pino` so every Pino log line carries `trace_id` and `span_id` automatically. Existing `requestId` / `operationId` fields stay untouched.

No code in route handlers or services changes. `getLogger("integrations", "nats-bus")` keeps working; its lines just get richer.

### 5.2 NatsBus — TypeScript

The bus's publish/request/subscribe paths today encode JSON with no NATS headers ([nats-bus.ts](../../../server/src/services/nats/nats-bus.ts)). Phase 2 of this plan adds:

```ts
import { propagation, context, trace } from "@opentelemetry/api";

publish<T>(subject, payload, opts) {
  const headers = createHeaders();
  propagation.inject(context.active(), headers, headersSetter);
  // span: kind=PRODUCER, name=`nats publish ${subject}`, attrs={messaging.system, messaging.destination}
  this.nc.publish(subject, ENCODER.encode(JSON.stringify(payload)), { headers });
}

subscribe<T>(subject, handler) {
  // in the consume loop:
  const ctx = propagation.extract(context.active(), msg.headers, headersGetter);
  // span: kind=CONSUMER, name=`nats subscribe ${msg.subject}`, parent=ctx
  context.with(trace.setSpan(ctx, span), () => handler(...));
}
```

Same pattern for `request` (PRODUCER + CONSUMER pair, the reply gets its own span via the `_INBOX.>` subscription), `respond`, `jetstream.publish`, and `jetstream.consume`. Headers are NATS-native (since 2.2); they're not used today, so adding them is a strict superset — no consumer breaks.

### 5.3 NatsBus — Go

Mirror in [egress-shared/natsbus/bus.go](../../../egress-shared/natsbus/bus.go). Same publish/request/subscribe/respond methods, same propagator (`go.opentelemetry.io/otel/propagation`), same NATS-headers-as-carrier shape. The Go SDK's `nats.Msg.Header` is a `nats.Header` (alias for `textproto.MIMEHeader`); it satisfies the OTel `TextMapCarrier` interface with a one-line adapter. Constants for header field names live in [egress-shared/natsbus/](../../../egress-shared/natsbus/) so TS and Go agree without the CI drift check needing a second pass — they only have to agree on `traceparent` and `tracestate`, which are W3C standards.

### 5.4 DockerService and Express handlers

`DockerService.getInstance()` is the other chokepoint that's worth a span manually — Docker calls dominate request latency for some routes (container list, container inspect). Wrap each public method with a span at the singleton boundary. `@opentelemetry/instrumentation-express` covers HTTP handler spans automatically; we don't add per-route instrumentation.

### 5.5 What stays uninstrumented

- **Pino-internal:** the logger doesn't get its own spans — log lines carry the active span's IDs, that's enough.
- **Synchronous helpers:** utility functions, parsers, schema validators. Spans here would be noise.
- **Inside JetStream consumer batch loops:** one span per message, not one per batch iteration.

## 6. Phased rollout

Each phase is a separate Linear issue. Phases land in order; Phase 1 unblocks every later one. Phases 3–5 are independent of each other after Phase 2.

### Phase 1 — Tempo + Collector + Grafana in the monitoring stack

**Goal:** the trace backend is up; a single hand-rolled span makes it through end-to-end.

Deliverables:
- `tempo`, `otel-collector`, and `grafana` services added to [server/templates/monitoring/template.json](../../../server/templates/monitoring/template.json).
- `tempo.yaml`, `otel-collector.yaml`, and `grafana/{datasources,dashboards}/` config files alongside the existing `prometheus.yml` / `loki.yaml` / `alloy.alloy` in `server/templates/monitoring/`.
- `tempo_data` named volume; Grafana volume for provisioning + (optional) persisted user settings.
- Grafana provisioning: Prometheus, Loki, and Tempo as data sources; one starter dashboard with a Node Graph panel pointed at the service-graph metrics.
- A new `dynamicEnv` kind `otel-otlp-endpoint` (mirroring `nats-url`) that injects `OTEL_EXPORTER_OTLP_ENDPOINT=http://monitoring-otel-collector:4317` into any service that opts in via `services[].dynamicEnv`. Rendered through the same pipeline as `NATS_URL`.
- A trivial smoke trace: server emits a span on boot (`server.boot`) before the OTel SDK is even instrumented further, just to prove OTLP → collector → Tempo → Grafana works.

Done when: a fresh worktree boots, Grafana opens at the worktree-allocated port, the `server.boot` span is searchable in Tempo, and the Prometheus/Loki/Tempo data sources all show "OK".

### Phase 2 — `NatsBus` context propagation (TS + Go)

**Goal:** every NATS hop is a span. A trace started by an HTTP request arrives at `egress-fw-agent` and continues into Go.

Deliverables:
- TS `NatsBus` injects/extracts W3C trace headers in `publish`, `request`, `subscribe`, `respond`, `jetstream.publish`, `jetstream.consume`.
- Span kinds: `PRODUCER` on publish/request, `CONSUMER` on subscribe/respond/consume. Span names follow OTel messaging conventions: `nats {publish|receive|process} {subject}`.
- Standard messaging attributes: `messaging.system="nats"`, `messaging.destination=<subject>`, `messaging.operation=<op>`, plus our existing `applyId` / `inboxId` correlation fields as span attributes.
- Go counterpart in `egress-shared/natsbus/` — same shape, same span names, so Tempo treats TS and Go halves of a flow as one trace.
- The smoke ping (`mini-infra.system.ping`) gains an end-to-end test: client request triggers `pingSelf()`, the resulting trace shows two spans (the client request and the loopback responder) joined by parent/child.

Done when: a `POST /api/egress-firewall/...` route in the server triggers an `envUpsert` over NATS, and Tempo shows a single trace with: HTTP server span → NatsBus PRODUCER span → fw-agent CONSUMER span → fw-agent's local work spans → reply CONSUMER span — all stitched together.

### Phase 3 — Auto-instrumentation across the server

**Goal:** the boring pile of obvious things — Express, Prisma, Socket.IO, outbound HTTP — become spans without per-call-site work.

Deliverables:
- `@opentelemetry/sdk-node` registered as the first import in [server/src/server.ts](../../../server/src/server.ts), gated behind `OTEL_EXPORTER_OTLP_ENDPOINT` so an unset env var disables tracing entirely (zero overhead in tests).
- Auto-instrumentations for `http`, `express`, `pg`, `socket.io`, `undici`. Each has a small allow-list of attributes to keep cardinality sane.
- `@opentelemetry/instrumentation-pino` so Pino lines carry `trace_id` / `span_id`. `getLogger()`'s contract doesn't change.
- Manual spans wrapped around `DockerService.getInstance()` public methods — Docker calls dominate latency on some routes and `dockerode` has no first-party instrumentation.
- Sampling: head-based, parent-respecting, default 100% in dev (we want every trace), to be tuned in prod.

Done when: opening a stack-detail page in the UI produces one trace per request, every database query is a child span, every outbound HTTP call (Cloudflare, Azure, Vault) is a span, and every server log line for that request carries the same `trace_id`.

### Phase 4 — Sidecars

**Goal:** instrument the components that aren't the main server. Phase 2 gave us NATS-side traces from Go sidecars; this phase fills in the local work inside each.

Deliverables:
- `agent-sidecar/` — Node OTel SDK boot in [agent-sidecar/src/index.ts](../../../agent-sidecar/src/index.ts), Express auto-instrumentation, Pino instrumentation. The agent's tool calls become child spans of the user request's trace.
- `update-sidecar/` — minimal: a single `update.run` span around `main()` in [update-sidecar/src/index.ts](../../../update-sidecar/src/index.ts). Limited value (one-shot, runs in seconds) but lets us see the self-update window inside a trace alongside the rest of the system. Optional; defer to a follow-up if Phase 5 of the NATS migration hasn't landed yet, since the cleaner integration is "self-update progress over NATS, traced end-to-end".
- `egress-fw-agent/` — Go OTel SDK boot in [egress-fw-agent/cmd/main.go](../../../egress-fw-agent/cmd/main.go). NATS context propagation already in from Phase 2; this phase adds local spans for nftables apply, NFLOG batch flush, and the heartbeat publisher.
- `egress-gateway/` — same shape in [egress-gateway/cmd/main.go](../../../egress-gateway/cmd/main.go). Local spans for the proxy decision path; NFLOG-equivalent decisions are already a JetStream stream, so the existing PRODUCER span from Phase 2 covers the egress hop.

Done when: a UI action that fans out to the gateway shows a trace with spans inside the Go process, not just at the NATS boundary.

### Phase 5 — Service map, dashboards, and correlation polish

**Goal:** turn the raw spans into the "see all interactions between components" view the planning conversation started with.

Deliverables:
- Tempo `metrics-generator` enabled in `tempo.yaml`, emitting `traces_service_graph_*` and `traces_spanmetrics_*` to Prometheus.
- A Grafana dashboard committed in `server/templates/monitoring/grafana/dashboards/` with:
  - A Node Graph panel rendering the service map (filterable by environment and time window).
  - A trace search panel (TraceQL).
  - Per-service latency / error / request-rate panels (RED method) sourced from `traces_spanmetrics_*`.
- Trace ↔ logs correlation: data-source-level config so clicking a span jumps to the matching Loki query (`{component=~"...", trace_id="<id>"}`).
- Trace ↔ metrics correlation: exemplars from Prometheus dashboards link back to traces.
- A short [docs/architecture/internal-messaging.md §7](../../architecture/internal-messaging.md#7-observability--how-nats-traffic-reaches-the-ui) update — the Observability section grows a "tracing" subsection that points readers at Grafana.

Done when: opening Grafana, picking a time window, and looking at the service-graph panel shows every Mini Infra component with edges representing real cross-component traffic. Clicking an edge drills into traces for that interaction.

### Phase 6 — App-level metrics (optional, deferred)

**Goal:** add custom Prometheus metrics for things the spans summarise but are easier to consume as a counter / histogram (`mini_infra_nats_publish_total`, `mini_infra_stack_apply_duration_seconds`, etc.). Out of scope for this plan; pre-listed here only so it doesn't get folded back into Phase 5 by accident.

## 7. Risks & open questions

- **OTel SDK boot ordering.** The Node SDK must initialise *before* anything that monkey-patches `http`, `express`, etc. Today [server/src/server.ts](../../../server/src/server.ts) imports `getLogger` and a few services at the top of the file; Phase 1 must move OTel setup to position 1, ahead of every other import. A small ESM-side-effect file (`server/src/lib/otel.ts`) imported first solves it cleanly.
- **Pino log volume in Loki when traces are also live.** Loki ingests every container's stdout via Alloy already; adding `trace_id` to every line doesn't increase line count, but makes correlation queries practical. No change in cost expected, but worth re-checking after Phase 3.
- **NATS header behaviour change.** Today messages have no `Headers`; Phase 2 starts setting `traceparent` on every publish. Subscribers that read `msg.headers === undefined` and branch on it would break — a grep over both TS and Go confirms no such code today, but Phase 2's PR description should call this out.
- **JetStream historical replay.** When the bus reconnects and JetStream replays old messages, those messages won't have headers. Extraction must tolerate missing headers (start a root span, log a debug line). The plan: never assume `traceparent` is present.
- **Tempo storage budget.** Default Tempo config writes blocks to a local volume. With 100% sampling in dev that's fine; for prod we'll need to revisit (sampler tuning + retention policy on the metrics-generator output). Defer to Phase 5.
- **`pg-az-backup` left out.** Sometimes a backup is the slow piece on the timeline; we won't see it in traces. Document in the plan; reconsider if it becomes load-bearing after Phase 4 of the NATS migration moves backup status onto the bus (then a backup is just another NATS-traced operation).
- **Grafana auth.** Built-in stacks shipped today don't have user auth. We should not expose Grafana to the public network without putting it behind the existing auth-proxy or basic-auth-on-HAProxy. Phase 1 ships it on the worktree-local port only; production exposure is a separate decision.
- **Cross-process clock skew.** Spans crossing into Go containers running on a separate `egress-fw-agent` Linux namespace can render with negative durations if the host clocks drift. NTP is on by default; flag if we ever see weird waterfalls.

## 8. Linear tracking

Phase issues will be created under a new "OTel Tracing" project on the Altitude Devops team and linked here once filed. Phase 1 blocks every later phase; Phase 4 also blocks on Phase 2 (Go side context propagation must exist before sidecar local spans are useful).

- ALT-_TBD_ — Phase 1: Tempo + OTel Collector + Grafana in monitoring stack
- ALT-_TBD_ — Phase 2: `NatsBus` context propagation (TS + Go)
- ALT-_TBD_ — Phase 3: Server auto-instrumentation (Express, Prisma, Socket.IO, outbound HTTP, Pino)
- ALT-_TBD_ — Phase 4: Sidecar instrumentation (`agent-sidecar`, `update-sidecar`, `egress-fw-agent`, `egress-gateway`)
- ALT-_TBD_ — Phase 5: Service map, Grafana dashboards, trace ↔ logs ↔ metrics correlation
- ALT-_TBD_ — Phase 6 (deferred): App-level Prometheus metrics
