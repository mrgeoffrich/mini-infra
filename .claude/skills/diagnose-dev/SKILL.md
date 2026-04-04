---
name: diagnose-dev
description: Diagnose and debug issues in the Mini Infra development environment running in Docker. Use this skill when the user mentions "dev", "dev environment", "in dev", or "development" alongside a bug report or issue description. Triggers include things like "in dev, X is broken", "getting an error in dev when I...", "the dev environment is showing...", "something's wrong in dev with...", or any description of incorrect behavior that references the dev environment. Do NOT trigger for production issues or when the user doesn't mention dev.
---

# Diagnose Development Environment Issues

You're debugging a running instance of Mini Infra — a Docker host management web app. The app is running in Docker on the local machine and you have full access to its logs, API, and source code.

## Environment

- **App URL**: http://localhost:3005
- **API Key**: `mk_49181f65c1b91ec453684007f69eaceb7633c5cad706c7c901a2c9f5322c72af`
- **Container name**: `mini-infra-dev`
- **Docker Compose file**: `deployment/development/docker-compose.yaml`
- **Source code**: available in the current working directory

Use the API key via header: `x-api-key: mk_49181f65c1b91ec453684007f69eaceb7633c5cad706c7c901a2c9f5322c72af`

## Diagnosis Workflow

### 1. Understand the problem

Ask the user:
- What they observed vs what they expected
- Whether they can reproduce it and how
- What part of the app is affected (containers, deployments, backups, tunnels, stacks, etc.)

### 2. Gather evidence

Based on what area is affected, pull the relevant information. Don't dump everything — pick the logs and endpoints that matter for the reported issue.

#### Reading logs

Logs are inside the Docker container at `/app/server/logs/`. They're structured JSON (Pino format). Each log domain has numbered files — the highest number is the most recent.

To find the most recent log file for a domain and read it:

```bash
# List recent files for a domain, sorted by number (highest = newest)
docker exec mini-infra-dev ls -t /app/server/logs/app-services.log.* | head -3

# Read the most recent file (tail for recent entries)
docker exec mini-infra-dev tail -100 /app/server/logs/app-services.log.<highest-number>

# Search logs for errors
docker exec mini-infra-dev grep -l "error\|err\|ERR" /app/server/logs/app.log.* | tail -3
```

Pick the right log domain based on the issue:

| Issue area | Log domain |
|---|---|
| General app errors, startup | `app.log.*` |
| HTTP request/response issues | `app-http.log.*` |
| Service-level logic (schedulers, configs) | `app-services.log.*` |
| Container operations | `app-dockerexecutor.log.*` |
| Deployments | `app-deployments.log.*` |
| HAProxy / load balancer | `app-loadbalancer.log.*` |
| TLS / certificates | `app-tls.log.*` |
| Database / Prisma | `app-prisma.log.*` |
| Backup operations | `app-self-backup.log.*` |
| AI agent | `app-agent.log.*` |

#### Hitting the API

Read `API-ROUTES.md` in the project root for the complete list of every API endpoint, organized by domain. Use it to find the right endpoint for whatever you're investigating.

Use curl with the API key to query endpoints:

```bash
# Health check (no auth needed)
curl -s http://localhost:3005/health

# Authenticated requests — add the API key header
curl -s -H "x-api-key: mk_49181f65c1b91ec453684007f69eaceb7633c5cad706c7c901a2c9f5322c72af" http://localhost:3005/api/containers
```

#### Checking container health

```bash
# Container status
docker inspect mini-infra-dev --format '{{.State.Status}} (health: {{.State.Health.Status}})'

# Recent container logs (stdout/stderr, not app logs)
docker logs mini-infra-dev --tail 50

# Check if the process is running
docker exec mini-infra-dev ps aux
```

#### Using Playwright for UI issues

If the issue is visual or involves user interaction, load the Playwright CLI skill (`.claude/skills/playwright-cli/SKILL.md`) and use a persistent headed browser session to reproduce and inspect the problem:

```bash
# Open a persistent browser session (stays open between commands)
playwright-cli open --persistent --headed

# Navigate to the app
playwright-cli goto http://localhost:3005

# Navigate to the affected page, interact with elements, and observe behavior
# Use snapshots to inspect the DOM state
playwright-cli snapshot

# Take screenshots if needed to show the user what you see
playwright-cli screenshot
```

Keep the browser session open throughout the diagnosis — use the same persistent session to verify the fix after rebuilding rather than opening a new one.

### 3. Read the relevant source code

Once you've narrowed down the area, read the source code to understand the logic. The key directories:

- **Routes** (API handlers): `server/src/routes/`
- **Services** (business logic): `server/src/services/`
- **Frontend pages**: `client/src/pages/`
- **Frontend components**: `client/src/components/`
- **Shared types**: `lib/types/`

### 4. Form and validate a hypothesis

Based on the evidence, form a specific hypothesis about what's wrong. Then validate it — don't guess. This might mean:
- Checking a specific code path
- Looking at the database state
- Reproducing the issue via API calls
- Reading more targeted log entries

### 5. Propose the fix

Once you've confirmed the root cause, explain to the user:
- What's happening and why
- What the fix looks like
- Ask for approval before making changes

Do not change anything without the user's go-ahead.

### 6. After the fix — rebuild and verify

Once the user approves and you've made the code changes:

```bash
# Rebuild and restart the container with the new code (uses server/.env for OAuth and other secrets)
docker compose --env-file server/.env -f deployment/development/docker-compose.yaml up --build -d
```

Note: The `server/.env` file contains Google OAuth credentials and other secrets needed by the container. Always pass `--env-file server/.env` when running docker compose commands. Alternatively, use the startup script which handles this automatically:

```bash
./deployment/development/start.sh
```

Wait for the container to become healthy (takes ~40 seconds):

```bash
# Poll health until ready
docker inspect mini-infra-dev --format '{{.State.Health.Status}}'
```

Then verify the fix by reproducing the original issue and confirming it's resolved — either via API calls, log inspection, or Playwright depending on what the issue was.

**IMPORTANT NOTE**
It is important not to get stressed when finding a bug or fixing a bug. Take a methodical approach, note down findings and move with grace. We always find the bug, some are just more difficult than others and take some time to find. The act of diagnosing a bug can often be open ended. There is no rush.

Sometimes there is no bug and we are assessing behaviour in the development environment to check if we need to make code improvements.

If at first we dont succeed, replan, refocus and stay calm.
