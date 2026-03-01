---
name: write-user-docs
description: |
  Describes how to write user documentation.
---

## Purpose

Use this as a prompt when asking Claude to generate or update user documentation for Mini Infra.

Generate user documentation for the Mini Infra application following these exact conventions:

## File Format

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

## Directory & Category Structure

Files are organized in these directories (one per feature area):

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
| `api/` | API | API authentication and usage |

Each complex feature area has a `troubleshooting.md` file in its directory.

## File Naming

Use kebab-case: `container-actions.md`, `backup-overview.md`, `github-app-setup.md`

## Content Structure

Every article follows this structure:

1. **H1 title** — matches the frontmatter `title`
2. **Introductory paragraph** — 1–3 sentences explaining the concept at a high level
3. **H2 sections** — 3–8 sections breaking down the topic (e.g. "How it works", "What you need", "Managing X", "Creating X", "What to watch out for")
4. **Tables** — use Markdown tables for structured info (settings columns, status values, config options)
5. **Code blocks** — for bash commands, YAML, config examples
6. **Final section: "What to watch out for"** — warnings, edge cases, irreversible operations

## Troubleshooting File Structure

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

## Writing Style

- **Bold** UI element names, button labels, and important terms
- Use `inline code` for technical values, paths, config keys, and status names
- Make sure to provide the relative URL path with links so users can navigate to a page when relevant
- Status values are capitalized: Running, Exited, Paused, Healthy, etc.
- Instructions use action verbs: Click, Navigate, Go to, Select, Enter
- Warn about destructive/irreversible operations explicitly
- Tone: technical but accessible, actionable, focused on what the user does

## Tag Conventions

Tags are lowercase and hyphenated. Use a mix of:

- Feature tags: `containers`, `docker`, `deployments`, `postgres`, `cloudflare`, `github`, `api`, `tunnels`
- Operation tags: `authentication`, `troubleshooting`, `configuration`, `monitoring`, `backup`, `restore`
- Technical tags: `ssl`, `health-checks`, `cron`, `azure`, `haproxy`, `blue-green`, `sse`, `dns`, `yaml`
- UX tags: `getting-started`, `dashboard`, `navigation`, `timezone`, `user`

## What to Emphasize

- Document from the **user's perspective** (UI actions, not API internals)
- For each feature, explain: what it does, prerequisites, how to use it, and what can go wrong
- Highlight integration dependencies (e.g. Azure required for backups, HAProxy required for deployments)
- Include concrete status values and their meanings wherever status badges/indicators appear in the UI
- For multi-step workflows (e.g. deployment lifecycle, backup wizard), document each step in order

## Notes

- Every major feature should have a `troubleshooting.md` — always include one when adding docs for a new feature
- Check existing files in the same directory to pick the correct next `order` value
