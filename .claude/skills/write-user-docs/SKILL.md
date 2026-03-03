---
name: write-user-docs
description: |
  Generates or updates user documentation for Mini Infra by reading the docs structure plan and exploring source code.
---

## Purpose

Use this skill when asked to generate or update user documentation for Mini Infra. It guides you through a structured process: read the docs plan, explore the source code for each article, then write accurate docs grounded in the actual implementation.

---

## Step 1 — Read the Docs Structure Plan

Start by reading:

```
client/src/user-docs-structure/user-docs-structure.md
```

This file maps every app route to its doc coverage status and lists all articles to create. Identify which articles are missing (❌) based on what the user has asked for, or if asked to generate all missing docs, work through the full list systematically.

---

## Step 2 — Explore Source Files for Each Article

Before writing each article, explore the actual source code so the docs reflect real UI and behaviour — not assumptions.

### Frontend source locations

| What you're documenting | Where to look |
|---|---|
| Page layout and UI elements | `client/src/app/<feature>/page.tsx` (and subdirectories) |
| Detail pages | `client/src/app/<feature>/[id]/page.tsx` |
| Feature-specific components | `client/src/app/<feature>/*.tsx` and `client/src/components/<feature>/` |
| Status values and badges | Look for badge/status components in the page or its imports |
| Forms and config fields | Look for form components, Zod schemas, or `react-hook-form` usage |

### Route-to-directory mapping

| Route prefix | Frontend source directory |
|---|---|
| `/dashboard` | `client/src/app/dashboard/` |
| `/containers` | `client/src/app/containers/` |
| `/deployments` | `client/src/app/deployments/` |
| `/environments` | `client/src/app/environments/` |
| `/postgres-server`, `/postgres-backup` | `client/src/app/postgres/`, `client/src/app/postgres-server/` |
| `/tunnels` | `client/src/app/tunnels/` |
| `/haproxy` | `client/src/app/haproxy/` |
| `/certificates` | `client/src/app/certificates/` |
| `/events` | `client/src/app/events/` |
| `/connectivity-*` | `client/src/app/connectivity/` |
| `/api-keys` | `client/src/app/api-keys/` |
| `/settings-*` | `client/src/app/settings/<subsection>/` |
| `/user/settings` | `client/src/app/user/` |

### What to extract from source files

- **Page headings and section names** — use the actual UI labels, not invented ones
- **Status values** — look for status badge components, enums, or string literals (e.g. `Running`, `Exited`)
- **Actions and buttons** — look for `onClick` handlers, button labels, and form submit actions
- **Configuration fields** — look for form field names, labels, and validation rules
- **Dependencies and prerequisites** — look for conditional rendering, feature flags, or "not configured" states
- **Table columns** — look for column definitions in data table components

If server-side detail is needed (e.g. API behaviour, scheduling, backup mechanics), also look in:
- `server/src/routes/` — API endpoint definitions
- `server/src/services/` — business logic

---

## Step 3 — Write the Documentation

After reading the source files, write the article following these conventions.

### File format

Every documentation file is a Markdown file with YAML frontmatter:

```yaml
---
title: [Article Title]
description: [One-sentence summary of what this article covers]
category: [Category Name]
order: [Sequential integer within the category, starting at 1]
tags:
  - [lowercase-hyphenated-tags]
  - [relevant-feature-terms]
---
```

### Output directory & category structure

Files are written to `client/src/user-docs/`:

| Directory | Category Name | Covers |
|---|---|---|
| `getting-started/` | Getting Started | Onboarding, navigation, dashboard overview, running with Docker |
| `containers/` | Containers | Docker container viewing, actions, logs |
| `deployments/` | Deployments | Blue-green deployment lifecycle, configuration, triggering |
| `postgres-backups/` | PostgreSQL Backups | Backup configuration, scheduling, restore |
| `tunnels/` | Tunnels | Cloudflare tunnel monitoring and hostnames |
| `connectivity/` | Connectivity | Service health monitoring (Docker, Azure, Cloudflare, GitHub) |
| `github/` | GitHub | App setup, packages, repository and actions integration |
| `settings/` | Settings | System settings, API keys, user preferences |
| `networking/` | Networking | TLS certificates, HAProxy |
| `monitoring/` | Monitoring | Event log |
| `api/` | API | API authentication and usage |

### File naming

Use kebab-case matching the filenames in the docs structure plan.

### Content structure

Every article follows this structure:

1. **H1 title** — matches the frontmatter `title`
2. **Introductory paragraph** — 1–3 sentences explaining the concept at a high level
3. **H2 sections** — 3–8 sections breaking down the topic (e.g. "How it works", "What you need", "Managing X", "Creating X")
4. **Tables** — use Markdown tables for structured info (settings columns, status values, config options)
5. **Code blocks** — for bash commands, YAML, config examples
6. **Final section: "What to watch out for"** — warnings, edge cases, irreversible operations

### Troubleshooting file structure

Troubleshooting files use a strict repeating pattern for each issue, separated by `---`:

```markdown
---

## [Descriptive Issue Title]

**Symptom:** [What the user sees]

**Likely cause:** [Root cause(s)]

**What to check:** [Diagnostic steps]

**Fix:** [Solution steps]

---
```

### Writing style

- **Bold** UI element names, button labels, and important terms
- Use `inline code` for technical values, paths, config keys, and status names
- Provide relative URL paths in links so users can navigate to pages when relevant
- Status values are capitalized: Running, Exited, Paused, Healthy, etc.
- Instructions use action verbs: Click, Navigate, Go to, Select, Enter
- Warn about destructive/irreversible operations explicitly
- Tone: technical but accessible, actionable, focused on what the user does

### Tag conventions

Tags are lowercase and hyphenated. Use a mix of:

- Feature tags: `containers`, `docker`, `deployments`, `postgres`, `cloudflare`, `github`, `api`, `tunnels`
- Operation tags: `authentication`, `troubleshooting`, `configuration`, `monitoring`, `backup`, `restore`
- Technical tags: `ssl`, `health-checks`, `cron`, `azure`, `haproxy`, `blue-green`, `sse`, `dns`, `yaml`
- UX tags: `getting-started`, `dashboard`, `navigation`, `timezone`, `user`

### What to emphasize

- Document from the **user's perspective** (UI actions, not API internals)
- For each feature, explain: what it does, prerequisites, how to use it, and what can go wrong
- Highlight integration dependencies (e.g. Azure required for backups, HAProxy required for deployments)
- Include concrete status values and their meanings wherever status badges/indicators appear in the UI
- For multi-step workflows (e.g. deployment lifecycle, backup wizard), document each step in order

---

## Notes

- Check existing files in the same directory to pick the correct next `order` value
- Every major feature should have a `troubleshooting.md` — create one when adding docs for a new feature area
- If a source file is large or complex, focus on the sections relevant to the user-visible feature being documented
