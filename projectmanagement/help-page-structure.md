# Help Documentation Structure

## Guiding Principles

- **Explain how things actually work.** Don't just list button labels — describe what happens when you click them, why the system behaves the way it does, and what to expect.
- **Sysadmin audience, human writing.** Readers are technical but shouldn't need to reverse-engineer the app. Be direct, skip marketing fluff, and respect the reader's time.
- **Troubleshooting lives with features.** Each feature category includes its own troubleshooting section so readers don't have to hunt across pages.
- **One concept per page.** Keep articles focused. If a page needs more than 3-4 scroll lengths, split it.
- **Progressive depth.** Each category starts with an overview that gives the full picture, then deeper pages cover specific workflows.

## Content Structure

```
user-docs/
├── getting-started/
│   ├── overview.md                    (order: 1)
│   ├── managing-containers.md         (order: 2)  ← exists
│   └── navigating-the-dashboard.md    (order: 3)
│
├── containers/
│   ├── viewing-containers.md          (order: 1)
│   ├── container-actions.md           (order: 2)
│   ├── container-logs.md              (order: 3)
│   └── troubleshooting.md            (order: 4)
│
├── postgres-backups/
│   ├── backup-overview.md             (order: 1)
│   ├── configuring-backups.md         (order: 2)
│   ├── restoring-backups.md           (order: 3)
│   └── troubleshooting.md            (order: 4)
│
├── deployments/
│   ├── deployment-overview.md         (order: 1)
│   ├── creating-deployments.md        (order: 2)
│   ├── deployment-lifecycle.md        (order: 3)
│   └── troubleshooting.md            (order: 4)
│
├── tunnels/
│   ├── tunnel-monitoring.md           (order: 1)
│   └── troubleshooting.md            (order: 2)
│
├── connectivity/
│   ├── health-monitoring.md           (order: 1)
│   └── troubleshooting.md            (order: 2)
│
├── github/
│   ├── github-app-setup.md            (order: 1)
│   ├── packages-and-registries.md     (order: 2)
│   ├── repository-integration.md      (order: 3)
│   └── troubleshooting.md            (order: 4)
│
├── api/
│   └── api-overview.md                (order: 1)
│
└── settings/
    ├── system-settings.md             (order: 1)
    ├── api-keys.md                    (order: 2)
    └── user-preferences.md            (order: 3)
```

## Page Outlines

### getting-started/overview.md

What Mini Infra is and the problem it solves — managing a single Docker host without the overhead of Kubernetes or Portainer. Cover first login via Google OAuth, what the dashboard shows at a glance, and how the sidebar maps to features.

### getting-started/navigating-the-dashboard.md

Layout walkthrough: sidebar navigation, dashboard cards, dark/light mode toggle, timezone settings. Explain what each top-level section does in one sentence so users know where to go.

### containers/viewing-containers.md

How the container list works: what data comes from Docker, what the status indicators mean, how to filter and sort. Explain the refresh behaviour — is it polled, manual, or event-driven?

### containers/container-actions.md

Start, stop, restart, remove — what each action does at the Docker level. Cover confirmation dialogs, what happens to volumes on remove, and any actions that are intentionally not exposed.

### containers/container-logs.md

How log viewing works: streaming vs snapshot, any line limits, search/filter within logs. Mention that these are Docker container logs (stdout/stderr) and not application-level log files.

### containers/troubleshooting.md

Common issues: container won't start, container keeps restarting, logs not appearing, stale status. For each, explain what to check and what the likely cause is.

### postgres-backups/backup-overview.md

How the backup system works end-to-end: which PostgreSQL databases can be backed up, where backups are stored (Azure Blob Storage), what format they're in, and how scheduling works with node-cron.

### postgres-backups/configuring-backups.md

Setting up a backup: connecting a PostgreSQL instance, choosing a schedule, setting retention policies. Explain what each configuration option does and what sensible defaults look like.

### postgres-backups/restoring-backups.md

The restore process step by step. What happens during a restore, how long it takes, whether it's destructive to the target database, and how to verify a restore was successful.

### postgres-backups/troubleshooting.md

Backup stuck at 80%, Azure connection failures, credential issues, backup too large. Reference the race condition fix from commit `7625d29` as context for the progress tracking.

### deployments/deployment-overview.md

How zero-downtime deployments work: the blue-green model, HAProxy's role in traffic routing, and what "zero-downtime" actually means in this context (connection draining, health checks).

### deployments/creating-deployments.md

Setting up a deployment config: selecting the image, registry credentials, environment variables, health check endpoints. Explain the relationship between deployment configs and the actual deploy action.

### deployments/deployment-lifecycle.md

What happens during a deploy from start to finish: image pull, container start, health check, HAProxy switchover, old container teardown. Cover rollback — when it triggers automatically and how to trigger it manually.

### deployments/troubleshooting.md

Deploy stuck in progress, health check failures, HAProxy not switching, image pull errors, rollback behaviour.

### tunnels/tunnel-monitoring.md

What the tunnels page shows: Cloudflare tunnel status, which tunnels are active, what the health indicators mean. Explain the relationship between tunnels and the services they expose.

### tunnels/troubleshooting.md

Tunnel showing as degraded or down, Cloudflare API connectivity issues, tunnel not routing traffic.

### connectivity/health-monitoring.md

What the connectivity page monitors: Docker daemon, Azure Storage, Cloudflare API. For each, explain what "healthy" means, how often checks run, and what a failure indicates.

### connectivity/troubleshooting.md

Service showing as unhealthy when it shouldn't be, intermittent connectivity, how to verify connectivity outside of Mini Infra.

### github/github-app-setup.md

How to install and configure the GitHub App integration. What permissions it needs, what data it accesses, and how authentication works.

### github/packages-and-registries.md

Using GitHub Container Registry (ghcr.io) with Mini Infra: how package discovery works, linking packages to deployment configs, image tag selection.

### github/repository-integration.md

What repository data Mini Infra pulls and how it's used. Cover GitHub Actions visibility if applicable.

### github/troubleshooting.md

App installation issues, permission errors, rate limiting, webhook delivery failures.

### api/api-overview.md

A placeholder page that covers: API keys exist, how to create one, the two header formats (Authorization Bearer and x-api-key), and a note that detailed endpoint docs are coming. Include a simple curl example.

### settings/system-settings.md

Docker registry configuration, deployment infrastructure settings. Explain what each setting controls and when you'd change it.

### settings/api-keys.md

Creating, viewing, and revoking API keys. Explain the security model — keys are hashed, only shown once, development-only auto-key.

### settings/user-preferences.md

Timezone selection and any other per-user settings. Explain that timezone affects how timestamps display throughout the app.

## Writing Approach

### Structure of Each Page

Every help page should follow this general shape:

1. **Opening sentence** — What this page covers, in one sentence.
2. **How it works** — The mental model. Not the code, but the system behaviour a sysadmin needs to understand. Use plain language. If there's a concept that's non-obvious (like blue-green deploys or connection draining), explain it here.
3. **Walkthrough** — Step-by-step for task-oriented pages, or a section-by-section breakdown for reference pages.
4. **What to watch out for** — Gotchas, edge cases, or things that might surprise someone.

Troubleshooting pages follow a different shape:

1. **Symptom** — What the user is seeing.
2. **Likely cause** — What's probably happening.
3. **What to check** — Specific things to verify (logs, database state, config).
4. **Fix** — What to do about it.

### Tone

- Second person ("you") when addressing the reader.
- Present tense for describing system behaviour.
- No hedging language ("simply", "just", "easily") — if something is simple it doesn't need the word.
- Technical terms are fine (the audience is sysadmins) but explain Mini Infra-specific concepts on first use.

### Screenshots and Visuals

- Not required for the initial pass. The markdown renderer supports images if we add them later.
- Prefer descriptive text over screenshots where possible — screenshots go stale faster than prose.

## Suggested Writing Order

1. **getting-started/overview.md** — Sets the stage for everything else.
2. **containers/** — The most-used feature; builds on the existing managing-containers doc.
3. **postgres-backups/** — High-value, high-anxiety feature (backups are critical).
4. **deployments/** — Complex feature that benefits most from clear documentation.
5. **api/api-overview.md** — Quick win, short page.
6. **github/** — Newest feature, likely has the most questions.
7. **tunnels/** and **connectivity/** — Monitoring pages, lighter docs.
8. **settings/** — Reference material, lowest urgency.
