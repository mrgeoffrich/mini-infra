---
title: Stacks
description: How to find, review, apply, upgrade, stop, and remove stacks — the plan/apply unit behind every application and infrastructure service in Mini Infra.
tags:
  - stacks
  - docker
  - infrastructure
  - configuration
  - drift
---

# Stacks

A **stack** is a collection of Docker containers and their supporting infrastructure — networks, volumes, config files — managed as a single unit with **plan/apply** semantics. You declare the desired state, review a plan of what would change, and apply it.

Every deployed thing in Mini Infra is a stack. An [application](/help/applications/application-management) is a stack built from a user template; HAProxy, monitoring, Vault, and NATS are stacks built from system templates. The Stacks page is where you see all of them at once.

Stacks support two service types:

- **Stateful** — stop/start replacement. Databases and infrastructure services.
- **StatelessWeb** — zero-downtime blue-green release via HAProxy. Web apps and APIs.

## The Stacks page

**Stacks** in the sidebar lists every stack across both scopes — host-level infrastructure and environment-scoped applications alike. The table shows:

| Column | Description |
|--------|-------------|
| **Name** | Links to the stack detail page. |
| **Scope** | `Host`, or the environment the stack belongs to. |
| **Source** | `Infrastructure` (system template), `Application` (user template), or `Manual`. |
| **Status** | The stack's sync state — see below. |
| **Template version** | The version the stack is running, and the latest published version if they differ. |
| **Attention** | A **Needs attention** badge when something is unresolved. Hover it for the reasons. |
| **Last applied** | When the stack was last successfully applied. |

Filter by search, scope, source, and status, or flip on **Needs attention** to show only the stacks asking for a human. The list updates live — you do not need to refresh it to see a stack change state.

## Stack status values

| Status | Colour | Meaning |
|--------|--------|---------|
| **Synced** | Green | Running containers match the last applied definition. Nothing to do. |
| **Drifted** | Orange | Live containers no longer match the definition. **Run Apply to reconcile.** |
| **Pending** | Yellow | The definition changed but hasn't been applied. Run Apply to deploy it, or discard the changes. |
| **Error** | Red | The last apply failed. Check the failure reason and retry. |
| **Undeployed** | Grey | The containers don't exist — never deployed, or stopped. Deploy or Apply to create them. |

Every badge in the UI carries a tooltip saying what the status means and what to do next.

### Drifted does not always mean "someone edited it"

**Drifted is also how a crash shows up.** A background monitor watches Docker events and sweeps the fleet every 60 seconds, so a stack whose container dies an hour after a clean deploy flips from **Synced** to **Drifted** on its own. Drift is no longer only noticed when a human opens the plan view.

So a Drifted stack means one of:

- A service **crashed or was stopped** — the app is down.
- A service's container **is missing** entirely.
- A container was **replaced or edited out of band** — it's running, but it isn't what Mini Infra applied.

You don't have to guess which. The **Needs attention** badge names the service and the specific problem.

## Needs attention

**Needs attention** rolls every unresolved signal for a stack — failed applies, dead containers, drift, unapplied edits, NATS drift, and available upgrades — into one badge with a plain-language reason list. Hover it to see them.

It has four levels:

| Level | Meaning | Examples |
|-------|---------|----------|
| **Critical** | The app is down, or an apply failed. | `Service 'api' is not running (exited) — run Apply to restart it.` `Service 'web' has no container — run Apply to recreate it.` `Last apply failed: …` |
| **Warning** | Something diverged, but the app is still up. | Out-of-band container replacement, unapplied definition edits, NATS drift. |
| **Info** | An opportunity, not a problem. | A newer template version is available. |
| **None** | Nothing to do — no badge is shown. |

The distinction that matters: `status` is a coarse lifecycle field, and a crashed container lands there as **Drifted**, which badly undersells "your app is down". The attention level says so directly, and names the service.

## Reviewing a plan

Open a stack to see its **plan** — a comparison between the desired definition and the containers actually running. Click **Refresh Plan** to recompute it.

### Action summary

Coloured badges summarise the operations:

- **Create** (green) — containers that will be created.
- **Recreate** (orange) — containers that will be stopped, removed, and rebuilt.
- **Remove** (red) — containers that will be deleted.
- **Unchanged** (grey) — containers with no differences.

### Service details

Each service shows its planned action, any image change (e.g. `telegraf:1.32 → telegraf:1.33`), a short reason ("image tag changed", "environment variable updated"), and a **Show Diff** toggle for a field-by-field view — removed values in red, new values in green.

## Applying changes

- **Apply All** — applies every planned change in dependency order.
- **Apply Selected** — tick individual services and apply only those.

During apply, a progress view shows each service's result: success or failure, the action performed, its duration, and error details if it failed. Progress also streams into the task tracker in the header, so you can navigate away without losing it. When it finishes, click **View Updated Plan** to confirm the stack is **Synced**.

## Discarding pending changes

A **Pending** stack has definition edits that were never applied. **Discard pending changes** restores the definition from the last applied snapshot and returns the stack to **Synced**.

It touches only the definition — no containers are stopped or recreated, and it completes instantly. A stack that has never been applied has no snapshot to fall back to, so there is nothing to discard.

## Upgrade & deploy

When a stack's template has a newer published version than the one the stack is running, an **Update available** badge appears alongside an **Upgrade & deploy** button. Clicking it re-materialises the stack from the template's current published version and applies it, as a single tracked operation.

If the target version declares **rotate on upgrade** inputs, a **Supply upgrade inputs** dialog collects fresh values first — the upgrade won't proceed without them.

## Stop, Remove, and Delete

These are three different operations with three different blast radii.

| Action | Containers | Volumes | Stack record | Reversible? |
|--------|------------|---------|--------------|-------------|
| **Stop** | Stopped and removed | **Kept** | **Kept** (status → Undeployed) | Yes — Deploy brings it back with its data. |
| **Remove** / **Uninstall** | Removed | **Destroyed** | **Destroyed** | No — the data is gone. |
| **Delete** | Must already be gone | — | Removed from the database | No. |

- **Stop** keeps the definition and the volumes. This is the one you want for "turn it off for now".
- **Remove** (labelled **Uninstall** on the stack detail page, **Remove deployment** on an application card) destroys containers, networks, volumes, and the stack record — and cleans up the Cloudflare tunnel hostname and its DNS record, so a torn-down stack stops leaving a hostname pointing at nothing.
- **Delete** only removes the database record. Mini Infra verifies no labelled containers are still running first, so a partially-failed teardown can't silently orphan them.

## Service configuration fields

| Field | Description |
|-------|-------------|
| **Service Name** | Unique within the stack. |
| **Service Type** | `Stateful` or `StatelessWeb`. |
| **Docker Image** / **Tag** | e.g. `prom/prometheus` / `v3.3.0`. |
| **Environment Variables** | Key-value pairs passed to the container. |
| **Ports** | Host-to-container port mappings. |
| **Mounts** | Volume and bind mount definitions. |
| **Command / Entrypoint** | Override the container's default command. |
| **Restart Policy** | Container restart behaviour. |
| **Health Check** | Command, interval, timeout, retries, start period. Durations are **milliseconds**; `retries` is a count. |
| **Config Files** | Files written to volumes before the container starts. |
| **Init Commands** | Shell commands for volume preparation (mkdir, chown, …). |
| **Depends On** | Services that must start first. |
| **Order** | Numeric deployment order — lower deploys first. |

**StatelessWeb** services add routing fields for HAProxy: hostname, listening port, SSL settings, certificate, load balancing algorithm, and optional Cloudflare DNS management.

## What to watch out for

- **The monitoring stack** (Telegraf, Prometheus, Loki, Alloy) is a host-level stack — removing it stops metrics and log collection across Mini Infra.
- **Apply recreates containers.** For **Stateful** services there is brief downtime during the recreate. **StatelessWeb** services go blue-green and stay up.
- **A failed service can cascade.** Services that depend on it may fail too. Fix the root error and re-apply.
- **StatelessWeb requires a running HAProxy stack** to route traffic.
- **After upgrading Mini Infra, stacks with health checks may report Drifted once.** Health check durations were canonicalised to milliseconds, which changes the definition hash of every service that has one. A single Apply reconciles it — and is worth doing, because the running containers genuinely have the wrong health check timings until they're recreated.
