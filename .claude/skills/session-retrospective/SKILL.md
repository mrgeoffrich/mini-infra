---
name: session-retrospective
description: |
  Analyze a Claude Code session JSONL and post a retrospective to `mk` as a new issue
  tagged "retro" in the backlog state, linked back to the original issue the run was working on.
  Use when the user (or another skill, e.g. `execute-next-task`) wants to capture lessons
  learned from an `mk`-tracked execution run so a retrospective trail builds up over time.
  Triggers: "retrospective", "what did we learn", "session summary", "lessons learned", "retro".

  Project-specific fork of github.com/accidentalrebel/claude-skill-session-retrospective —
  the upstream skill prints markdown to console; this version posts to the local `mk`
  (mini-kanban) issue tracker for the current repo.
---

# Session Retrospective

Analyze a Claude Code session JSONL, generate a reflective summary of what happened, and
post it as a new "retro"-tagged `mk` issue in the `backlog` state, linked back to the
original issue the run was working on. The point of writing each retro to its own issue
(rather than a comment on the original) is that retros accumulate in their own searchable
list and have their own lifecycle — separate from the contract-style handoff comment the
executor leaves on the original.

## Parameters

The skill is invoked with two **required** parameters, parsed from the args string:

- `--session-id <UUID>` — the Claude Code session ID to retrospect on. Must be passed
  explicitly.
- `--issue <MINI-NN>` — the `mk` issue key the parent run was working on. The retro
  issue's title and description reference this so the trail is navigable.

If either parameter is missing, **stop and report**. Do not fall back to defaults — silently
analyzing the wrong session or failing to link back to the source issue both produce a
worthless retro.

## Workflow

1. **Validate parameters.** Both `--session-id` and `--issue` are required. Stop if
   either is missing.

2. **Confirm `mk` is available.** A one-line sanity check from the repo root is enough:

   ```bash
   mk status
   ```

   If `mk` is missing or errors out (not in a git repo, etc.), stop and surface the
   error — don't try to continue. Tags are free-form in `mk`, so there is no label
   pre-flight to do; the `retro` tag is created implicitly the first time it's used.

3. **Retrieve the session JSONL.** Run the helper script with the session ID as a positional
   arg (do not rely on env):

   ```bash
   .claude/skills/session-retrospective/scripts/get-session.sh <session-id>
   ```

   If the script errors (`Session file not found`), stop and surface the error — don't try
   to continue with empty input.

4. **Parse and analyze the JSONL.** Extract:
   - `"type":"user"` entries for user messages
   - `"type":"assistant"` entries for Claude responses and tool uses
   - `tool_result` blocks with `is_error: true` for rejected/failed actions
   - User messages immediately following an assistant turn (often corrections)

5. **Resolve the original issue** for posting:
   - Run `mk issue show <MINI-NN> -o json` to grab its title — needed for the retro's
     title.
   - The retro lives in the same repo as the original (the current repo, auto-scoped by
     `mk` from `cwd`). No team or label resolution is required.

6. **Generate the retrospective markdown** per the Output Format below.

7. **Create the retro issue** via `mk issue add`. Write the body to a temp file first
   (long-text inputs in `mk` come from a file or stdin — there is no inline editor):

   ```bash
   cat > /tmp/retro-body.md <<'EOF'
   <retrospective markdown body, per Output Format below>
   EOF

   mk issue add "Retro: MINI-NN — <original-issue-title>" \
     --description-file /tmp/retro-body.md \
     --state backlog \
     --tag retro \
     --user Claude
   ```

   - **Title**: `Retro: MINI-NN — <original-issue-title>` (truncate the original title to
     keep the combined length under ~80 chars).
   - **State**: `backlog`.
   - **Tag**: `retro` (free-form; created on first use).
   - **`--user Claude`** is **mandatory** for AI-driven calls — without it the audit log
     silently attributes the change to the OS user.
   - Capture the new issue key from the command output (use `-o json` if you need to
     parse it programmatically).

8. **Link the retro back to the original** so `mk issue show` on either side surfaces the
   relation:

   ```bash
   mk link <NEW-RETRO-KEY> relates-to MINI-NN --user Claude
   ```

   Optionally, drop a one-line pointer comment on the original so a human reading just
   that issue can find the retro:

   ```bash
   printf 'Retro filed: <NEW-RETRO-KEY>\n' \
     | mk comment add MINI-NN --as Claude --body - --user Claude
   ```

   `--as` is required on every `mk comment add`; `--user Claude` is the audit-log
   attribution and is mandatory for agent-driven calls.

9. **Return only** the new retro issue's key (e.g. `MINI-83`). Do not echo the markdown
   body — the caller (typically a subagent in `execute-next-task`) just needs the key
   to relay back.

## Output Format

The retrospective markdown that goes into the issue description:

```markdown
## TL;DR

[2-3 sentence summary of what was accomplished and the key takeaway]

## What We Set Out To Do

[Brief description of the initial goal/problem]

## The Journey

### [Challenge / Phase 1 Title]

[What happened, what was tried, what worked, what didn't]

**Key insight**: [The important lesson from this phase]

### [Challenge / Phase 2 Title]

[Continue for each significant phase...]

## Mistakes Made (And What I Learned)

- **[Mistake 1]**: [What went wrong] → [What the fix/lesson was]
- **[Mistake 2]**: ...

## Techniques Worth Remembering

- **[Technique 1]**: [When and why to use it]
- **[Technique 2]**: ...

## Key Takeaways

1. [Most important lesson]
2. [Second most important lesson]
3. [Third most important lesson]
```

## Writing Guidelines

- **Be specific**: include actual error messages, command names, file paths where relevant.
- **Show the process**: document the messy middle, not just the clean final solution.
- **Extract transferable lessons**: frame insights so they apply beyond this specific run.
- **Honest about mistakes**: the most valuable lessons usually come from what went wrong.
- **Conversational tone**: write as if explaining to a fellow developer over coffee.
- **Don't pad**: omit a section entirely if there's nothing real to put in it. An honest
  short retro is more useful than a long one with hollow bullets.

## Script reference

The helper script (`scripts/get-session.sh`) is read-only — it just `cat`s the matching
session JSONL out of `~/.claude/projects/`. The fallback to `$CLAUDE_SESSION_ID` exists for
direct human invocation outside the parameterized flow above; in this skill's normal use
path the session ID is always passed explicitly.
