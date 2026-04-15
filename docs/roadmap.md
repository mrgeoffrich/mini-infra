# Mini Infra — Features & Enhancements Roadmap

A living document tracking upcoming features, enhancements, and chores for Mini Infra. Items are grouped by theme rather than strict priority; ordering within each section is a rough suggestion.

## Chores

## UI / UX

### Onboarding flow
A fresh Mini Infra instance has a lot of knobs that almost every operator ends up setting the same way. Build a guided onboarding that establishes sensible defaults up front so users aren't hunting through settings pages.

- **Time & locale** — host timezone, date/time format, and any locale-driven defaults.
- **TLS / ACME** — set the ACME account, default issuer, renewal window, and Cloudflare DNS provider so certificates "just work" from day one.

### Stacks & Applications UI refresh
The Stacks and Applications surfaces have grown organically and would benefit from a design pass to improve clarity and reduce cognitive load.

- Revisit information hierarchy on the Stacks list (status, drift, version, environment).
- Improve the Application detail page — surface deploy status, blue/green state, routing, and recent events more clearly.
- Unify action affordances (deploy / apply / stop / remove) so they behave consistently between Stacks and Applications.
- Improve empty states, loading states, and error presentation.
- Reconsider the plan/apply flow — make the diff between current and desired state easier to read.
- Accessibility sweep (keyboard nav, focus rings, contrast).

## Stacks as Code

Make stack definitions portable and version-controllable so they can live alongside application code and flow through normal review processes.

- **YAML import / export** — round-trip a stack definition (services, networks, volumes, routing, env) to and from a canonical YAML format.
- **Schema & validation** — publish the YAML schema, validate on import, and show clear diffs against the running stack before apply.
- **CLI / API parity** — same import/export available via the REST API so it can be driven from CI.
- **GitOps sync** (later phase) — point a stack or environment at a git repository + path; Mini Infra periodically (or on webhook) reconciles the running state with the repo.
  - Support branch/tag/commit pinning per environment (e.g. `main` for staging, tagged releases for production).
  - Plan/apply loop with drift detection against the git source of truth.
  - Status surfaced in the UI: last sync, current revision, drift, sync errors.
  - Auth via existing GitHub connection; extend to generic git providers later.

## GitHub Integration

Now that GitHub connectivity exists, it is only lightly used. The goal is to make Mini Infra a credible place to run the full production lifecycle of an application sourced from GitHub.

- **Repository browsing & selection** — pick a repo/branch as the source of an Application.
- **Managed builds** — build images from a Dockerfile in a connected repo, tag, and push to the configured registry. Trigger on push, tag, or manual dispatch.
- **Deployments** — wire GitHub Deployments API so deploys from Mini Infra show up on PRs and commits (with environment + status progression).
- **Dependabot visibility** — surface Dependabot alerts and version PRs per application so owners can see outstanding upgrades without leaving Mini Infra.
- **Dependabot escalation** — when an alert crosses a severity threshold (e.g. critical CVE on a production app), page the operator via the configured messaging channel (see Alerting & Messaging) with a direct link to the advisory and affected app.
- **Automated Dependabot response** — for sufficiently urgent alerts, optionally let Mini Infra take action on the operator's behalf: merge the existing Dependabot PR, or open a PR with the required bump if one doesn't exist, gated by configurable policy (severity, app criticality, business hours, requires-approval flag).
- **Security** — surface code scanning / secret scanning alerts for connected repos, and gate deploys on severity thresholds.
- **PR preview environments** — optionally spin up an ephemeral environment per PR, linked to the PR with a comment.
- **Release notes** — derive release notes from commit range between the running version and the candidate version.
- **Repo-driven config** — allow stack templates or app config to live alongside the code in the repo.

## Monitoring & Metrics

There is significant room to grow beyond the small set of metrics currently surfaced on the dashboard and diagnostics pages.

- **Log scraping** — tail and collect files, not just stdout/stderr
- **Container metrics** — Improve the monitoring page to show any metrics available.
- **Application-level metrics** — can we get postgres specific and haproxy specific metrics?

## Alerting & Messaging Agent

Give Mini Infra a way to reach operators proactively, starting simple and building toward an AI-driven watchdog.

- **Telegram integration (first cut)** — outbound notifications via the Telegram Bot API. Easy to set up (bot token + chat id) and good enough for a one-operator home/prod setup.
  - Connected service for Telegram with token storage and test-message action.
  - Per-event-type subscriptions (deploy success/failure, cert renewal, backup status, tunnel down, etc.).
  - Template the message format so alerts are consistent and include links back into the UI.
- **Pluggable channels** — design the notifier interface so Slack, Discord, email, and generic webhook can slot in later without rewiring event producers.
- **Alert rules** — let users define conditions (metric thresholds, log patterns, event types) that fire a notification, with cooldown / dedupe to avoid storms.
- **Monitoring agent / heartbeat** (later phase) — a subagent, in the spirit of the existing agent sidecar, that runs on a schedule and inspects the system.
  - Pulls current state (container health, stack drift, cert expiry, backup freshness, host metrics, recent errors) and decides whether anything is worth paging about.
  - Uses the LLM to summarise issues in plain language and send a concise message via the configured channel (e.g. Telegram).
  - Configurable cadence (e.g. every 15 min) plus event-triggered runs for high-signal changes.
  - "All clear" heartbeat option so operators know the watchdog itself is alive.
  - Persist findings and actions taken so the UI has a history of what the agent noticed and said.

## Cloudflare Improvements

Expand the Cloudflare integration beyond DNS and basic tunnel wiring so internet-exposed applications can be protected with minimal effort.

- **WAF rules** — manage Cloudflare firewall rules from Mini Infra (block/challenge by country, ASN, user agent, path).
- **Country / geo blocking** — per-application allow/deny lists with a simple UI.
- **Rate limiting** — configure rate-limit rules per route or application.
- **Bot management** — toggles for known-bot handling on a per-application basis.
- **Tunnel enhancements**
  - Manage multiple tunnels and route apps across them.
  - Show tunnel health, connector status, and throughput in the UI.
  - Rotate tunnel credentials from the UI.
  - Per-route access policies (Cloudflare Access) tied to an application.
- **Cache rules** — expose page rules / cache rules for static assets served through Cloudflare.
- **Analytics** — pull Cloudflare analytics (requests, threats blocked, bandwidth) into the application view.

## Status key

- **Proposed** — in this document, not yet scheduled.
- **Planned** — scoped and scheduled.
- **In progress** — actively being worked on (link to branch/PR).
- **Shipped** — merged and released (link to release).

All items above are currently **Proposed** unless linked to a PR or release.
