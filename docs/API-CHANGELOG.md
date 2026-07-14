# API Changelog

Breaking and behavioural changes to the Mini Infra REST API and to the stack/template
definition format. Newest first.

This file exists for people who talk to Mini Infra *programmatically* — API-key
integrations, the agent sidecar, and anyone authoring stack templates via the API or
YAML rather than through the UI. Changes that are purely visual are not recorded here;
changes that can silently break a caller are.

Release mechanics (tags, image promotion) live in [`RELEASING.md`](../RELEASING.md).

---

## Unreleased — Stacks & Applications overhaul (P0–P3)

### Breaking: healthcheck durations are milliseconds

`services[].containerConfig.healthcheck` durations are now **milliseconds**, everywhere:

| Field | Unit |
|-------|------|
| `interval` | milliseconds |
| `timeout` | milliseconds |
| `startPeriod` | milliseconds |
| `retries` | a **count** — never scaled |

A 30-second interval is `30000`, not `30`.

**Why it changed.** The field had four writers using two conventions and five readers
using three, and nothing pinned the unit. The authoring UIs stored milliseconds, but the
container-create paths multiplied by `1e9` as though the value were seconds — so a
UI-authored 30-second interval was sent to Docker as 30,000 *seconds* (about 8.3 hours),
and the healthcheck effectively never ran. Meanwhile the built-in templates stored
seconds, so a template's `startPeriod: 30` arrived as 30 ms. Milliseconds is now
canonical, declared on `StackContainerConfig` in `@mini-infra/types`, and the conversion
to Docker's nanoseconds happens in exactly one place.

**What you must do.** If you author templates through the API or as YAML/JSON **in
seconds, multiply by 1000**. Definitions you write from now on must already be in
milliseconds — nothing converts new input for you.

**What happens to values already stored.** An idempotent boot-time backfill converts
existing rows: `StackService.containerConfig`, `StackTemplateService.containerConfig`,
and `Stack.lastAppliedSnapshot`. Stored values are not self-describing (a `30` could be a
template's 30 seconds or a UI author's 30 ms), so the backfill **discriminates on
magnitude: values below 1000 are treated as seconds and multiplied by 1000.** The two
real-world populations sit far apart and a sub-second healthcheck interval is
pathological, so the ambiguous band is empty for any realistic configuration. `retries` is
a count and is never touched.

### Operational: expect one round of drift on first boot after upgrading

**This is the important one for operators.**

A stack's definition hash covers `containerConfig`, and `containerConfig` includes the
healthcheck. Converting the units therefore **changes the hash of every service that has a
healthcheck**. On the first boot after upgrading:

- Stacks with healthchecks will report **`drifted`**.
- Each needs **one Apply** to reconcile.

This is expected, and it is desirable — not a cosmetic hash churn to be suppressed. The
running containers genuinely have the wrong healthcheck timings (a UI-authored 30-second
interval was being handed to Docker as roughly 8.3 hours), and the only way to fix a
container's healthcheck is to recreate it. The drift is Mini Infra telling you the truth:
these containers need replacing to get the fix.

Plan for it. If you have many stacks with healthchecks, they will all light up at once.

### Breaking: `GET /api/stacks` no longer implies `source=system` on scoped queries

Source filtering is now **explicit only**. A scoped query — `?scope=host` or
`?environmentId=<id>` — returns stacks of **all sources** unless you also pass `source`.

Previously a scoped query implicitly filtered to system-source stacks, which surprised
callers who expected a scope filter to filter by scope and nothing else.

```
GET /api/stacks?scope=host                  # was: system stacks only.  now: ALL sources.
GET /api/stacks?scope=host&source=system    # the old behaviour, explicitly.
```

**What you must do.** If you relied on the old implicit behaviour, **add `source=system`**.
Accepted values are `system`, `user`, and (unfiltered) omission.

### Breaking: `StackStatus` no longer includes `removed`; `Stack.removedAt` is gone

Neither was ever written. Destroy hard-deletes the row; stop writes `undeployed`. Every
`removedAt IS NULL` filter was always-true and every `status != 'removed'` guard was a
no-op, so removing them changes no behaviour — but the enum member and the column are gone
from the API and the schema.

**What you must do.** Stop matching on `status === 'removed'`, and stop reading
`removedAt`. A stack that no longer exists is absent from the API, not tombstoned.

Note that `'removed'` **is** still a live, actively-written status on HAProxy
frontends/backends/routes, DNS records, and deployments. Those are a different enum that
happens to share the literal and are unaffected.

### New response fields on `serializeStack()`

Every endpoint returning a stack now also returns:

**`needsAttention`** — the server-computed "does this stack need a human?" rollup. Folds
status, live runtime issues, NATS drift, and template-update-available into one signal, so
an API consumer no longer has to reimplement it (and in practice go without).

```jsonc
"needsAttention": {
  "level": "critical",          // "none" | "info" | "warning" | "critical"
  "needsAttention": true,
  "reasons": [                  // human-readable, phrased as "what's wrong → what to do"
    "Service 'api' is not running (exited) — run Apply to restart it."
  ],
  "updateAvailable": false
}
```

| Level | Meaning |
|-------|---------|
| `critical` | The app is down — a service is not running or has no container — or the last apply failed. |
| `warning` | Something diverged but the app is still up: out-of-band replacement, unapplied edits, NATS drift. |
| `info` | An opportunity, not a problem: a newer template version is available. |
| `none` | Nothing to do. |

**`runtimeIssues`** — what the background status monitor last found wrong with the stack's
live containers, naming the offending service. Empty or absent means the last check was
clean.

```jsonc
"runtimeIssues": [
  { "kind": "not-running", "serviceName": "api", "status": "exited" }
  // kind: "missing" | "not-running" | "hash-mismatch"
]
```

Use these rather than inferring health from `status` alone. `status` is a coarse lifecycle
field: a crashed container lands there as `drifted`, which badly undersells "your app is
down".

### Behavioural: `drifted` is now detected in the background

A stack whose service crashes now flips `synced` → `drifted` on its own, driven by Docker
`die`/`destroy`/`stop`/`start` events plus a 60-second sweep as a backstop. Previously
drift was persisted only when a human opened the plan view, so a stack could sit at
`synced` with zero running containers.

**What this means for a poller.** A stack's `status` can now change without any API call
from you. If you cache stack status, subscribe to the `stack:status` Socket.IO event
rather than assuming status only changes in response to your own writes.

Transitions are deliberately narrow — only `synced` ↔ `drifted`. The monitor never touches
`error`, `pending`, or `undeployed`, which are states a human action owns.

### New endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/stacks/:id/stop` | Stop the stack's containers but **keep** its definition, DB row, and volumes. Status → `undeployed`; Deploy/Apply brings it back. Distinct from `/destroy`, which deletes the stack record and its volumes. |
| `POST /api/stacks/:id/upgrade` | Re-materialise the stack from its template's current published version. Status → `pending`. **Does not apply** — chain `POST /:id/apply` afterwards. Returns `400 STACK_INPUT_ROTATION_REQUIRED` if the target version declares `rotateOnUpgrade` inputs and you didn't supply `inputValues`. |
| `POST /api/stacks/:id/revert-pending` | Discard unapplied definition edits by restoring the last applied snapshot. Status → `synced`. Synchronous; touches no containers. Returns `400 STACK_NO_APPLIED_SNAPSHOT` for a never-applied stack. |
| `POST /api/stack-templates/:id/rollback` | Make an older published version the template's current version. |
| `POST /api/stack-templates/:id/instantiate` | Create a stack from a template's current published version, with `parameterValues` and `inputValues`. Does not apply. |

### Behavioural: destroying a stack cleans up its tunnel hostname

`POST /api/stacks/:id/destroy` now also removes the stack's Cloudflare tunnel hostname and
deletes the dangling CNAME, so a torn-down stack stops leaving a hostname routing to a
service that no longer exists. Idempotent — a "not found" is treated as success — and
non-fatal, matching the DNS cleanup beside it.
