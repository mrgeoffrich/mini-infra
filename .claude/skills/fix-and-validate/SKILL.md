---
name: fix-and-validate
description: Takes a GitHub issue number, reads the issue and its comments to understand the bug and suggested fix, implements the fix in the current worktree following Mini Infra coding conventions, spins up the dev environment if needed, then validates the fix using playwright-cli browser automation. Creates a PR if validation passes. Use this skill whenever the user says something like "fix issue #N", "implement the fix from issue #N", "work on issue #N", or "can you fix and validate issue #N".
---

# Fix and Validate from GitHub Issue

You're implementing and validating a bug fix for Mini Infra — a Docker host management web app. The workflow moves through four phases: read the issue, implement the fix, spin up the environment, validate with a browser.

## Phase 1 — Read the Issue

Use `gh` to fetch the full issue including all comments:

```bash
gh issue view <NUMBER> --repo <OWNER/REPO> --json title,body,comments
```

The repo can be found from `git remote get-url origin` if the user didn't specify it.

Parse the output to extract:
- **Bug description** — what's broken and how to reproduce it
- **Root cause** — if identified in the issue body or comments
- **Suggested fix** — any implementation notes or direction in comments
- **Files to touch** — any specific files mentioned

If the issue doesn't contain a clear fix direction, explore the codebase yourself to find the right approach before writing any code.

---

## Phase 2 — Implement the Fix

Follow all Mini Infra coding conventions from CLAUDE.md. Key rules:
- Never use `any` in TypeScript — use proper types
- Never use raw `docker.pull()`, `DockerService` directly, or raw dockerode calls — use the wrappers
- Use `Channel.*` and `ServerEvent.*` constants for Socket.IO, never raw strings
- Keep changes DRY — don't duplicate logic

### Exploration first

Before writing code:
1. Read the relevant source files to understand the current implementation
2. Check for related patterns elsewhere in the codebase so your fix is consistent
3. Look for flow-on effects — will this change break anything else?

### Implementation

Make the minimal change that fixes the bug. Don't clean up unrelated code or add features beyond the fix scope.

### Build verification

After making changes, verify the code compiles without errors:

```bash
# Build shared types first (always required)
pnpm build:lib

# Then build the affected workspace(s)
pnpm --filter mini-infra-server build   # if server changed
pnpm --filter mini-infra-client build   # if client changed
```

Fix any build errors before proceeding. Do not skip this step — a fix that doesn't compile is not a fix.

If tests exist for the area you changed, run them:

```bash
pnpm --filter mini-infra-server test   # or mini-infra-client
```

---

## Phase 3 — Spin Up the Environment

Check whether the dev environment is already running:

```bash
ls environment-details.xml 2>/dev/null || echo "MISSING"
```

If **missing**, start it (this takes a few minutes — it's idempotent):

```bash
bash deployment/development/worktree_start.sh
```

Once complete, read the URL and credentials:

```bash
MINI_INFRA_URL=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)
ADMIN_EMAIL=$(xmllint --xpath 'string(//environment/admin/email)' environment-details.xml)
ADMIN_PASSWORD=$(xmllint --xpath 'string(//environment/admin/password)' environment-details.xml)
```

Optionally read the worktree description to understand the job this environment was created for:

```bash
xmllint --xpath 'string(//environment/description/short)' environment-details.xml
xmllint --xpath 'string(//environment/description/long)'  environment-details.xml
```

If the environment **already exists**, rebuild the containers to pick up your code changes:

```bash
bash deployment/development/worktree_start.sh
```

The script is idempotent — it rebuilds the image and recreates the container without wiping data.

---

## Phase 4 — Validate with Playwright

Use the playwright-cli skill for all browser automation.

### Session naming

Multiple worktrees share the same playwright-cli daemon. Always derive a session name from the port to avoid conflicts:

```bash
UI_PORT=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml 2>/dev/null | grep -oE '[0-9]+$')
SESSION="p${UI_PORT:-3005}"
```

Pass `-s="$SESSION"` to every `playwright-cli` command.

### Login

```bash
playwright-cli -s="$SESSION" open "$MINI_INFRA_URL"
```

If redirected to `/login`:

```bash
playwright-cli -s="$SESSION" run-code "async page => {
  await page.fill('input[type=email]', '$ADMIN_EMAIL');
  await page.fill('input[type=password]', '$ADMIN_PASSWORD');
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard', { timeout: 10000 });
}"
```

If login fails: **STOP** — log a BLOCKER and do not continue.

### Validation test cases

Design test cases that directly verify the fix:
- **Regression test**: reproduce the original bug steps — confirm the bad behaviour is gone
- **Happy path**: confirm the fixed flow works end-to-end
- **Edge cases**: anything adjacent that the fix might have broken

After each significant interaction:
- Take a snapshot to get element refs: `playwright-cli -s="$SESSION" snapshot`
- Take a screenshot for evidence: `playwright-cli -s="$SESSION" screenshot --filename=screenshots/fix-evidence-1.png`

**Async data**: pages fetch via React Query — they render empty then populate. Wait for a specific element before snapshotting:

```bash
playwright-cli -s="$SESSION" run-code "async page => {
  await page.waitForSelector('text=expected-content', { timeout: 5000 });
}"
```

Avoid `waitForLoadState('networkidle')` — React SPAs never fully settle.

**Clicking specificity**: always re-snapshot before clicking to get fresh refs. Target the specific button ref, not a container that spans multiple buttons.

### Screenshots

Save all validation screenshots to `screenshots/` in the project root, e.g.:
- `screenshots/fix-before.png` — if you can show the broken state first
- `screenshots/fix-after.png` — the working state after the fix
- `screenshots/fix-edge-case.png` — any edge cases tested

Create the folder if needed: `mkdir -p screenshots`

### Playwright quick reference

```bash
# Navigate
playwright-cli -s="$SESSION" goto "$MINI_INFRA_URL/some/path"

# Inspect DOM to get element refs
playwright-cli -s="$SESSION" snapshot

# Interact
playwright-cli -s="$SESSION" click e5
playwright-cli -s="$SESSION" fill e7 "some value"
playwright-cli -s="$SESSION" press Enter
playwright-cli -s="$SESSION" select e9 "option-value"

# Run arbitrary Playwright code
playwright-cli -s="$SESSION" run-code "async page => { /* ... */ }"

# Check console errors
playwright-cli -s="$SESSION" console

# Screenshot
playwright-cli -s="$SESSION" screenshot --filename=screenshots/fix-evidence.png

# Close when done
playwright-cli -s="$SESSION" close
```

---

## Phase 5 — Create a PR

If validation **passes**:

1. Stage and commit the changes:

```bash
git add <specific files>
git commit -m "$(cat <<'EOF'
fix: <short description of what was fixed>

Fixes #<issue-number>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

2. Push and create the PR:

```bash
git push -u origin HEAD

gh pr create \
  --title "fix: <short description>" \
  --body "$(cat <<'EOF'
## Summary

Fixes #<issue-number> — <one-line description of the bug>.

## Root Cause

<Brief explanation of why the bug occurred.>

## Fix

<Brief explanation of what changed and why it resolves the issue.>

## Validation

Validated via playwright-cli browser automation:
- [x] Regression: original bug steps no longer reproduce the error
- [x] Happy path: fixed flow works end-to-end
- [x] Edge cases: <any additional checks>

Screenshots available in `screenshots/` on this branch.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

If validation **fails**: do not create a PR. Report the failure, describe what still doesn't work, and suggest next steps.

---

## Validation Report

Always end with a structured report regardless of outcome:

```
## Fix & Validation Report — Issue #<N>: <Title>

### Fix Summary
- **Root cause**: <what caused the bug>
- **Change**: <what was changed and in which files>
- **Build**: PASSED / FAILED

### Validation
- Status: PASSED / FAILED / BLOCKED
- Regression test: PASS / FAIL
- Happy path: PASS / FAIL
- Edge cases: PASS / FAIL / SKIPPED

### Evidence
- Screenshot: screenshots/fix-after.png

### PR
- Created: <URL> / Not created (<reason>)
```

---

## Notes

- Keep the browser session open for the full validation run — don't close and reopen between test cases.
- If the app is unresponsive, `playwright-cli -s="$SESSION" close` and report a BLOCKER.
- Source code is in the current working directory — read it to understand intended behaviour when in doubt.
- If the issue's suggested fix direction turns out to be wrong after exploration, note that and propose an alternative before implementing. Don't blindly follow a bad suggestion.
- Always check for console errors after interacting: `playwright-cli -s="$SESSION" console` — a silent 400/500 in the network is easy to miss visually.
