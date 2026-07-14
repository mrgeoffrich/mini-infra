---
title: Managing Applications
description: How to create, deploy, configure, upgrade, stop, and remove applications in Mini Infra.
tags:
  - applications
  - deployment
  - docker
  - configuration
  - stacks
---

# Managing Applications

An **application** is the simplified way to run a service on Mini Infra. Under the hood there is no separate "application" object — an application is a **stack** built from a **user-source stack template**. The application layer gives you a friendly form (image, ports, environment variables, volumes, routing) and hides the template/stack plumbing; everything you see on the [Stacks page](/help/applications/host-stacks) is the same object viewed one layer down.

That matters in one practical way: every lifecycle rule described here — statuses, drift, plan/apply, Upgrade & deploy — is a *stack* rule. If an application ever behaves in a way the application UI doesn't explain, open its stack and the answer will be there.

## Key concepts

- **Application** — a user-source stack template plus the stack deployed from it.
- **Stack** — the deployed unit: containers, networks, volumes, and config files, managed with plan/apply semantics.
- **Template version** — an immutable snapshot of the application's configuration. Saving publishes a new version; the running stack stays on the version it was deployed with until you upgrade it.
- **Environment** — the target the stack runs in. It cannot be changed after creation.

## Viewing applications

The Applications page shows every application as a card. Each card displays:

- Name, optional description, and category badge.
- The deployed stack's **status badge** (see [Stack status values](/help/applications/host-stacks#stack-status-values)).
- A **Needs attention** badge when the stack has an unresolved problem — hover it to see exactly what and why.
- An **Update available** badge when the template has a newer published version than the running stack.
- The application URL, when a running stack has a configured hostname.
- Action buttons: Deploy, Update, Upgrade & deploy, Stop, and a `⋯` menu.

## Creating an application

Click **Add Application** to open the creation form.

### Basic information

- **Display name** — a human-readable name.
- **Description** — optional.

### Service configuration

- **Service name** — the container name prefix. Lowercase with hyphens.
- **Service type**:
  - **Stateful** — databases, caches, workers. Replaced with a stop/start cycle, so there's a brief gap on each apply.
  - **StatelessWeb** — web apps and APIs. Released blue-green via HAProxy, so updates are zero-downtime.
- **Environment** — the deployment target. Permanent once set.

### Container configuration

- **Docker image** and **tag**.
- **Restart policy** — Always, Unless Stopped, On Failure, or No.

### Health check (optional)

A Docker health check with a command, interval, timeout, retries, and start period.

> **Durations are milliseconds.** `interval`, `timeout`, and `startPeriod` are all in milliseconds; `retries` is a plain count. The form's units are already correct — this only matters if you also author templates through the API or YAML, where these fields were previously written in seconds. See `docs/user/stack-definition-reference.md` and `docs/API-CHANGELOG.md` in the repository.

### Ports, environment variables, volumes

Host-to-container port mappings (TCP or UDP), key-value environment variables, and named Docker volumes with mount paths for persistent data.

### Routing (StatelessWeb only)

- **Hostname** — the domain traffic arrives on.
- **Listening port** — the port the container listens on. **Detect Ports** reads it from the image.
- **SSL/TLS** — issues a TLS certificate and DNS record automatically.
- **Cloudflare Tunnel** — creates a tunnel ingress for internet-type environments.

### Deploy immediately

Toggle whether to deploy right away or just save the definition for later.

## Deploying an application

Click **Deploy** and choose the environment to deploy into. Mini Infra instantiates the template as a stack there and applies it — pulling images, creating networks and volumes, then starting containers. Progress streams into the task tracker in the header.

For an **adopted** application (one wrapped around pre-existing containers) the button reads **Connect** instead.

## Running in several environments

An application can be deployed into more than one environment — staging and production, say. Each is its own stack with its own status, its own installed template version, and its own containers.

The **Environments** panel on the application's Overview lists every deployment, one row per environment, with **Deploy to environment** to add another. **Manage** opens that environment's stack, where Apply, Upgrade, Change version, and Stop act on that deployment alone.

When an application runs in several environments, its card shows a count and how many need attention (e.g. *2 environments · 1 needs attention*) rather than a single status — one deployment's health is not the application's health. The rest of the application detail page still describes the primary deployment; open the specific stack when you need to act on one.

The environments offered are those matching the application's network type. An environment that already has this application is shown but not selectable — deploy once per environment.

### Promoting a version between environments

Once staging is running a version you're happy with, **Promote** on that row deploys *that exact version* into another environment. It is the same primitive as an upgrade — the target moves to the version the source already has — so there is no separate "promotion" state to reason about.

Before it does anything it shows you the diff: what actually changes in the target environment, service by service. Two cases it will not let you get wrong:

- **The target is already on that version.** Nothing to do, and it says so rather than failing.
- **The target is on a *newer* version** — a hotfix that went straight to production, or a template that was rolled back. Promoting the older version onto it is still allowed and is sometimes exactly what you want, but it is a **rollback**, not a promotion, and it is labelled as one.

Promoting changes the target's definition and leaves it **pending**; the deploy runs as a normal apply, and you can watch it in the task tracker.

## Saving configuration changes

Open an application and go to **Configuration**. The two buttons do different things, and the difference is the whole point:

| Button | What happens |
|--------|--------------|
| **Save** | Publishes a new template version. The running stack is **not touched** — it keeps running the old version. The application then shows **Update available**, and a banner offers to deploy it. |
| **Save & deploy** | Publishes the new version *and* upgrades the running stack to it *and* applies, as one tracked operation. |

**Save** exists so you can stage a change without releasing it. If you save and walk away nothing breaks — but nothing ships either, and the running containers stay on the previous version until you deploy. That's why the banner is persistent rather than a dismissible toast.

## Upgrade & deploy

Whenever an application's template has a newer published version than the running stack, an **Update available** badge and an **Upgrade & deploy** button appear. Clicking it re-materialises the stack from the template's current published version and applies it — one action, tracked end to end in the task tracker.

You'll see this after a **Save**, after someone else publishes a change to the template, and after a Mini Infra release ships a new version of a built-in template.

If the target version declares inputs marked **rotate on upgrade** — a password or key that must be freshly supplied every time — a **Supply upgrade inputs** dialog appears first and collects them. The upgrade won't proceed until every such field is filled.

## Discarding pending changes

A stack in **Pending** status has edits to its definition that were never applied. To throw them away, click **Discard pending changes** on the card and confirm. The definition is restored from the last applied snapshot and the status returns to **Synced**.

This only touches the definition — no containers are stopped or recreated, and it is instant. An application that has never been deployed has no snapshot to fall back to, so there is nothing to discard.

## Updating the image

Click **Update** to pull the latest image for the current tag and redeploy. For **StatelessWeb** services the update runs blue-green, so traffic is never interrupted. For **Stateful** services the container is stopped and recreated, so there is a short gap.

Update picks up a new image build under the same tag. It is not the same as **Upgrade & deploy**, which adopts a new *template version*.

## Stop, Remove, and Delete

These were once conflated under a single "Stop". They are now distinct, and picking the wrong one is the difference between a five-second restart and losing your data.

| Action | Where | Containers | Volumes | Stack | Template |
|--------|-------|------------|---------|-------|----------|
| **Stop** | Card / stack detail | Stopped and removed | **Kept** | **Kept** (status → Undeployed) | Kept |
| **Remove deployment** | `⋯` menu | Removed | **Destroyed** | **Destroyed** | Kept |
| **Delete application** | `⋯` menu | — | — | — | **Deleted** |

- **Stop** is the reversible one. It stops the containers but keeps the stack definition and its volumes, so **Deploy** brings it straight back with its data intact. Use this to park an application.
- **Remove deployment** tears the deployment down: containers, networks, volumes, and the stack record all go, along with the Cloudflare tunnel hostname and its DNS record if it had one. The application (the template) survives, so you can deploy a fresh one — but **the data in its volumes is gone**. For an adopted application this reads **Disconnect & remove**.
- **Delete application** removes the template itself. Remove the deployment first; an application whose stack still has containers won't delete.

## Editing metadata

**Edit** in the `⋯` menu changes the application's name and description. Configuration changes belong on the Configuration page.

## What to watch out for

- **A Drifted or Needs attention application may mean it is down.** A background monitor watches Docker events, so a container that crashes an hour after a clean deploy flips the stack to **Drifted** on its own — you don't have to open the plan to find out. Hover the **Needs attention** badge: it names the service and says whether it's missing, not running, or no longer matches what was applied.
- **Save does not deploy.** See the table above.
- **The environment is permanent.** To move an application, recreate it in the target environment.
- **StatelessWeb needs HAProxy.** A StatelessWeb service can't route without a running HAProxy stack.
