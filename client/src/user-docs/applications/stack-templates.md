---
title: Stack Templates
description: How to create, version, publish, roll back, and install reusable stack templates in Mini Infra.
tags:
  - stack-templates
  - infrastructure
  - docker
  - configuration
  - versioning
---

# Stack Templates

A **stack template** is a reusable blueprint for a stack: services, parameters, inputs, networks, and volumes, in a structured format similar to Docker Compose. Installing a template creates a [stack](/help/applications/host-stacks); publishing a new version of the template offers every stack built from it an **Upgrade & deploy**.

Applications are templates too — an [application](/help/applications/application-management) is a user-source template with a friendlier editor in front of it. This page describes the raw template surface.

## Viewing templates

The Stack Templates page lists all templates. Each row shows its source, scope, current published version, and **Used by** — how many stacks were built from it. That count is the one to check before you change anything: publishing a new version puts an **Update available** badge on every one of those stacks.

Filter by:

- **Source** — **System** (built-in, ships with Mini Infra) or **User** (yours).
- **Scope** — **Host** (host-level infrastructure) or **Environment** (per-environment).
- **Include archived** — show or hide archived templates.

### System templates are read-only

System templates — HAProxy, monitoring, Vault, NATS, Postgres, Cloudflare Tunnel — are managed by Mini Infra and updated with each release. The detail page renders them explicitly read-only: no draft, no publish, no rollback. When a release ships a new version of one, the stacks using it show **Update available** and you adopt it with **Upgrade & deploy**.

## Creating a template

Click **Create Template**, give it a name and basic metadata, then define its services and configuration in the editor.

## The template editor

The editor has a main editing area and a **version sidebar**.

### Services

One or more Docker services, each with an image and tag, container configuration, init commands, dependencies, and routing rules.

> **Health check durations are milliseconds.** `interval`, `timeout`, and `startPeriod` are milliseconds; `retries` is a plain count. If you are porting a template that was authored in seconds, multiply by 1000. See `docs/user/stack-definition-reference.md` and `docs/API-CHANGELOG.md` in the repository.

### Parameters

Input variables supplied when the template is installed — each with a name, type, description, and default. Parameters let one template serve many configurations.

### Inputs

Values the operator must supply, held encrypted at rest and never returned by the API — passwords, API tokens, keys.

An input can be marked **rotate on upgrade**. When it is, every upgrade to a version declaring it must supply a *fresh* value: Mini Infra opens a **Supply upgrade inputs** dialog and refuses the upgrade until the field is filled. Use it for credentials that must not be carried across versions.

### Networks and volumes

Docker networks and persistent volumes the template's services use.

### Cross-stack prerequisites

Templates can declare conditions that must hold before a stack can be applied. Two kinds:

- **Stack prerequisite** — a stack from a named template must exist with a minimum status (e.g. `synced`). The match scope can be `host`, `environment`, or `same-environment` (the same environment as the applying stack).
- **Predicate prerequisite** — a built-in named check, e.g. `vault-bootstrapped` (true when Vault has been bootstrapped and the operator passphrase is unlocked).

Behaviour:

- **Installing is allowed even if prerequisites aren't met** — the dialog soft-warns, so you can stage stacks ahead of time.
- **Applying is blocked** until every prerequisite passes. The stack detail page renders a banner explaining each unmet requirement, with deep-link CTAs to fix it (deploy a missing stack, apply a pending one, bootstrap Vault).

## Versioning

Templates use a draft-and-publish workflow. Published versions are immutable; the draft is the only mutable thing.

1. **Create Draft** — starts an editable draft from the current published version. The sidebar shows it tagged `editing`.
2. **Edit** — changes save to the draft as you work. Nothing you do here affects a running stack.
3. **Publish Draft** — finalises the draft as a new immutable version, with optional release notes.
4. **Discard Draft** — abandons the draft and returns to the last published version.

The version sidebar lists the full history. The current published version is tagged `current`. Select any version to view it read-only, or **Create Draft from v*N*** to start editing from an older one.

### Reviewing the diff before you publish

The publish dialog shows a **diff of the draft against the current published version** before you commit — services added, services removed, and field-level changes on each changed service, plus template-level configuration changes. Read it. It is the last cheap moment to catch an accidental change, because publishing immediately flags every stack using this template as having an update available.

You can also diff any two versions from the detail page by selecting a version — it compares against the previous one.

### Rolling back

Select an older published version in the sidebar and click **Make current**. That version becomes the template's current published version.

Rollback does not touch any running stack — it only changes what "current" means.

A stack already running the newer version therefore stays on it, and is now *ahead* of the template's current version. It does not show **Update available** (there is nothing newer than what it runs) and **Upgrade & deploy** is refused. Instead it shows an **Ahead of current** badge, and you move it with **Change version** on the stack detail page, choosing the version you want. See [Stacks](/help/applications/host-stacks).

## Installing a template

Click **Install** on a template with a published version. The dialog collects:

- **Name** (optional) — defaults to the template's name.
- **Environment** — required for environment-scoped templates. Only environments whose network type matches the template are offered.
- **Parameters** — pre-filled with their defaults; override any of them.
- **Inputs** — required values, masked if the input is marked sensitive.

**Install** creates the stack and takes you to its detail page. It does **not** apply it — the stack lands **Undeployed**, so you can review its plan first, then Apply. If the template's prerequisites aren't met yet you'll get a soft warning, but the install still succeeds; the Apply is what's gated.

## Archiving and deleting

**Archive** hides a template from the default list without destroying it — the right move for a template you've stopped using but whose stacks may still exist. Unarchive from the same menu.

**Delete** removes it permanently. Templates still in use by a stack can't be deleted — archive them instead.

### Archiving a single version

Old published versions can be archived individually from the version sidebar. An archived version stays readable but can no longer be installed, upgraded to, or made current — use it to retire a version you don't want anyone deploying while keeping it on the record. **Restore** puts it back.

Two versions can't be archived: the template's **current** version (a template pointing at an archived version couldn't install or upgrade anything), and the **draft** (drafts are discarded, not archived).

Stacks already running an archived version keep running. Archiving retires the version; it doesn't touch deployments.

## The Code view

The **Code** tab shows the whole template version as YAML, and it is the complete document — services, parameters, inputs, prerequisites, networks, volumes, config files, and the Vault and NATS sections. What you save is what you see, including deletions: remove a section in the editor and it is removed.

Vault and NATS have no graphical editor. The Code view is where you author them.

## Template scopes

- **Host** — host-level infrastructure stacks (HAProxy, monitoring, and friends).
- **Environment** — application stacks that live inside a named environment.
