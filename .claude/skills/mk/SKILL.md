---
name: mk
description: Use this skill whenever you need to create, read, update, or organise tasks/issues/tickets/todos using the `mk` CLI (mini-kanban) — a local issue tracker that ships with this repo. Triggers on any mention of issues, features, kanban work, tags, blocks/blocked-by relations, attached pull requests, project documents, or audit-log/history queries managed by `mk`. Prefer `mk` over external trackers (e.g. GitHub Issues) whenever the user is tracking work for a repo where `mk` is in use.
---

# Working with `mk` (mini-kanban)

`mk` is a local CLI issue tracker. Everything lives in a single SQLite db at `~/.mini-kanban/db.sqlite`. It's designed to be driven non-interactively by AI agents — every read command supports JSON output, every mutation accepts a JSON payload via `--json`, and every payload shape is published at runtime via `mk schema`.

## Agent quick start

The five conventions below combine into one straightforward flow. Each is documented in detail further down; this section is the cheat-sheet:

1. **Discover the shape:** `mk schema show <command>` (or `mk schema all` for one-shot ingestion). Worked examples are in every schema's `examples[0]`.
2. **Compose the payload as JSON.** Every mutating command accepts `--json '<payload>'`, `--json -` (stdin), or `--json @path/to.json`. Long text (descriptions, comment bodies, doc content) goes inline as a string.
3. **Rehearse with `--dry-run`** if the call is destructive or non-trivial. Stdout has the same shape as a real call; stderr emits `[dry-run] no changes were written`. Especially useful before `mk issue rm` / `feature rm` / `doc rm`, where the dry-run reports cascade counts.
4. **Run for real** without `--dry-run`. **Always pass `--user <agent-name>`** so the audit log attributes work correctly.
5. **Query lean by default.** `mk issue list -o json` and `mk feature list -o json` strip the heavy `description` field; pass `--with-description` if you actually need bodies. `mk doc show --metadata` skips the body. `mk issue brief --no-doc-content` gives you the structure without inlining linked-doc bodies.

A worked example, end to end:

```bash
# 1. Discover.
mk schema show issue.add | jq .examples[0]

# 2. Compose & rehearse.
mk issue add --user agent-claude --dry-run --json '{
  "title": "Pin tab strip",
  "feature_slug": "tui-polish",
  "description": "Body height should clip the tab strip.",
  "tags": ["ui", "tui"]
}' -o json

# 3. Commit (drop --dry-run).
mk issue add --user agent-claude --json '{ ...same payload... }' -o json
```

## Mental model

**Hierarchy:** repo → (optional) feature → issue.

- A **repo** is auto-detected from the current working directory by walking up to find a `.git` toplevel. Issues, features, and attachments are scoped to a repo.
- A **feature** is an optional grouping of issues (think a project or epic). Issues can exist without one.
- An **issue** has a title, description, state, tags, comments, relations to other issues, and attached PR URLs. Issues are addressed by a 4-letter `PREFIX-N` key like `MINI-42`.
- A **document** is a per-repo named text blob (markdown, etc.) with a typed category (architecture, designs, project-in-planning, …). Issues and features can link to documents with a short reason; the same document can be linked to many issues and features.

**Issue states**: `backlog | todo | in_progress | in_review | done | cancelled | duplicate`. The state parser also accepts dashes or spaces (`in-progress`, `in progress`).

**Auto-create on first use:** running any `mk` command in a git repo that hasn't been registered yet automatically creates the repo row and allocates a 4-char prefix from the directory basename (e.g. `mini-kanban` → `MINI`). Outside any git repo, `mk` errors out — never invent a working directory just to make it run.

**Identity:** the repo is keyed by its absolute git toplevel path. Moving the repo on disk creates a new row.

## Calling `mk` from an agent

- **Working directory matters.** Most commands resolve the repo from `cwd`. `cd` to the repo before running unless using `--all-repos` (available on `mk issue list` and `mk history`).
- **Output format.** Default is human-readable text. Pass `-o json` (alias `--output json`) for structured output — use this when parsing.
- **Timestamps.** Every entity carries a `created_at`. Features, issues, and documents additionally have `updated_at` (bumped automatically on edits / state changes / tag mutations). In JSON they're UTC RFC 3339 (e.g. `2026-05-03T07:27:14Z`) — that is the parsing contract. In text mode they render in the user's local timezone (`2026-05-03 17:27 AEST`).
- **Long-text inputs.** Description and comment body MUST come from a file (`--description-file path.md`) or stdin (`--description -`). There is no inline editor. For multi-line descriptions/comments, write to a temp file or pipe via `printf`/heredoc.
- **Identifiers.**
  - Issue keys: `PREFIX-N` (e.g. `MINI-42`). Any 4 alnum chars + `-` + digits.
  - Feature: slug string (kebab-case auto-derived from title, override with `--slug`).
  - `mk doc link` / `unlink` accept either an issue key or a feature slug as the target; they auto-detect issue keys by the `PREFIX-N` shape and treat anything else as a feature slug in the current repo.
- **Comment author.** `--as <name>` is required on every comment. There is no auth — use a sensible identity (e.g. `Claude`, `Geoff`).
- **`--user` is REQUIRED for AI agents.** Every mutation is recorded in an audit log alongside the actor that performed it. The CLI will silently fall back to the OS username if `--user` is omitted, but for agents that produces useless `<your-os-user> did everything` history. **Always pass `--user <your-agent-name>` (e.g. `--user Claude`) on every mutating command.** Treat it as mandatory in any agent-driven invocation, even though the binary tolerates its absence for human users.
- **Database override.** `--db <path>` is a global flag, useful for tests. In production agents, leave it at the default.

### Recommended: drive `mk` via `--json` (JSON)

Every mutating command accepts `--json` (alias `-j`) — a JSON payload that fully describes the operation. **Prefer this over typed flags when driving `mk` from an agent.** It's strict (typos surface as `unknown field` errors instead of silent no-ops), it removes the `--description-file` / stdin dance for long text, and the schema is published at runtime so you don't have to memorise field names.

- `--json '<json>'` — inline JSON.
- `--json -` — read JSON from stdin.
- `--json @path/to.json` — read JSON from a file.

`--json` is **mutually exclusive** with positionals and per-field flags (`--title`, `--state`, etc.). Mixing them is rejected with a clear error.

**Discover shapes at runtime, don't guess:**

```bash
mk schema list                # every command name with --json + one-line description
mk schema show issue.add      # full JSON Schema (draft 2020-12) for one command
mk schema all                 # every schema, keyed by command name (one ingest pass)
```

Each schema includes a worked `examples[0]` you can copy and adapt:

```bash
$ mk schema show issue.add | jq .examples[0]
{
  "title": "Pin tab strip in place",
  "feature_slug": "tui-polish",
  "description": "Body height should clip the tab strip so it doesn't drift on overflow.",
  "state": "todo",
  "tags": ["ui", "tui"]
}

$ mk schema show issue.add | jq .examples[0] | mk issue add --user agent-claude --json -
```

**Conventions baked into the JSON path:**

- **Issue keys must be canonical** (`MINI-42`, not `42`). The bare-number shortcut is for humans on the CLI flag path only.
- **Long-text fields are inline strings.** No JSON-side `--description-file`; just put the markdown directly in the `description` / `body` / `content` field.
- **Edit semantics on `*string` fields:** field absent = no change; empty string = clear (where the model allows). Required fields like `title` reject empty strings — omit the field to leave the value alone.
- **Globals stay as flags.** `--user`, `--db`, and `-o text|json` are passed as flags alongside `--json`, not inside the JSON.
- **Strict decoding.** Unknown fields fail the call. If you get `unknown field "..."` errors, run `mk schema show <command>` to see the exact accepted shape.

### `--dry-run` for safe rehearsals

Every mutating command accepts a global `--dry-run` flag. When set, the command runs everything up to the SQL write — input validation, entity resolution, slug/key derivation, cascade lookups — and emits the projected result without touching the database or the audit log. A `[dry-run] no changes were written` line is written to stderr; stdout has the same shape as a real call's output, so the same parsing code works.

Worth using when:

- You want to rehearse an `--json` payload before committing it, especially after composing it from `mk schema show`.
- You're about to delete something and want the cascade counts first. `mk issue rm --dry-run` returns the issue plus how many comments / relations / PR attachments / doc links would be removed alongside it; same shape on `mk feature rm --dry-run` (issues unlinked, doc links removed) and `mk doc rm --dry-run` (links removed).
- You want to confirm a complicated `mk issue edit` patch would resolve to the right object (especially for `feature_slug: null` clears).

Notes:

- `mk issue next --dry-run` is equivalent to `mk issue peek` — it reports what would be claimed without flipping state.
- `mk doc export --dry-run` reports the absolute destination path it would write to and the byte count, but doesn't create directories or files.
- Server-time fields (`id`, `created_at`, `updated_at`) come back as zero values in dry-run output; everything else is faithful to the real call.

### Output is lean by default

To keep agent context windows small, list-style commands strip heavy fields by default:

- `mk issue list -o json` — no `description`. Pass `--with-description` to inline bodies.
- `mk feature list -o json` — no `description`. Pass `--with-description` to inline bodies.
- `mk doc list -o json` — already metadata-only (emits `size_bytes`, never `content`).

When you need just the metadata of a single document, pass `--metadata` to `mk doc show <name>` and the body is skipped. Pair it with `--raw` (mutually exclusive) only if you wanted the body and nothing else.

`mk issue brief <KEY>` is the one bulk-context call that *does* inline doc bodies on purpose — it exists so a skill can read everything in one shot. Three opt-outs trim it when the full payload is too much:

- `--no-feature-docs` — skip docs linked to the parent feature.
- `--no-comments` — skip the comments section.
- `--no-doc-content` — keep linked-doc metadata (filename, type, source_path, linked_via, description) but drop the bodies. Fetch specific bodies later via `mk doc show <name>`.

### Input validation contract

Every mutation runs through validators in the store layer, so malformed input fails fast with a clear error rather than being silently normalised or stored as garbage. Rules an agent should know:

- **No control characters** anywhere. Single-line fields (titles, slugs, names, filenames, URLs, tags) reject all C0 controls and DEL (`\x00–\x1F`, `\x7F`). Multi-line fields (descriptions, comment bodies, document content) allow `\t \n \r` but reject the rest.
- **No silent trimming on identifiers.** Leading or trailing whitespace in a `filename`, `slug`, or URL is rejected — if you fat-finger a payload you'll see it instead of having it normalised away.
- **Length caps:** title 200 chars, name/assignee/`--user` 80, slug 60, filename 200, tag 80, PR URL 2 KiB, body fields 1 MiB. Generous for legitimate content, tight enough to fail loud on a runaway paste.
- **Slugs must be kebab-case** matching `^[a-z0-9][a-z0-9-]*$`. Auto-derived slugs (when you omit `slug` on `feature.add`) always satisfy this; explicit slugs in JSON must too.
- **PR URLs** must use `http` or `https` and have a host. `javascript:` and similar exotic schemes are rejected.
- **`--user` is validated once per command.** A `--user` that contains a newline or a control character is rejected at the start of the command before any work happens.
- **Strict JSON decode.** Unknown fields fail (covered by principle #1). Combined with the above, an agent that sends garbage gets a useful error pointing at the bad field rather than a successful write of corrupted data.

## Command reference

Every command supports `-o text|json` and `--db <path>` as global flags. Examples below omit them unless relevant.

### Repos

```
mk init [--prefix XXXX]              Bind cwd to a prefix (auto-runs on first
                                     use; pass --prefix to override the
                                     derived prefix)
mk repo list                         List every tracked repo
mk repo show [PREFIX]                Show a repo (defaults to cwd's repo)
mk status                            Show the current repo, DB path, and
                                     quick stats (feature count + issues
                                     grouped by state); outside any tracked
                                     repo it shows the global counts instead
```

**Example:**
```bash
cd ~/Repos/mini-kanban && mk init --prefix MINI
mk repo show
```

### Features

Optional groupings of issues, scoped to the current repo.

```
mk feature add <title>               Create a feature
  --slug <kebab>                       Override slug (default: derived from title)
  --description <text|->                Inline text or "-" for stdin
  --description-file <path>             Read description from a file

mk feature list                      List features in the current repo
mk feature show <slug>               Show a feature with its issues and
                                     linked documents
mk feature edit <slug>               Patch fields (pass --title and/or --description-file)
  --title <new title>
  --description <text|->
  --description-file <path>
mk feature rm <slug>                 Delete a feature (issues remain, but lose their feature link)
mk feature plan <slug>               Print open issues in execution order,
                                     respecting `blocks` dependencies. Issues
                                     with all blockers satisfied appear first;
                                     blocked issues appear after their
                                     blockers, annotated with `blocked_by`.
                                     Open = not done/cancelled/duplicate.
                                     Cross-feature blockers are surfaced as
                                     `blocked_by` hints but don't gate the
                                     topo position. Errors out on a cycle.
                                     Use `-o json` to drive an agent through
                                     the order one issue at a time.
```

**Example:**
```bash
mk feature add "Auth rewrite" --slug auth-rewrite \
  --description-file docs/auth-spec.md
```

### Issues

```
mk issue add <title>                 Create an issue in the current repo
  -f, --feature <slug>                  Attach to a feature
  --description <text|->                Inline or stdin
  --description-file <path>
  --state <state>                       Initial state (default: backlog)
  --tag <name>                          Repeatable; attach a tag at creation

mk issue list                        List issues in the current repo
  --state s1,s2                         Filter by comma-separated states
  -f, --feature <slug>                  Limit to one feature
  --tag <name>                          Repeatable; require this tag (AND semantics)
  --all-repos                           Search every tracked repo

mk issue show <KEY>                  Show issue + tags + comments + relations
                                     + PRs + linked documents
mk issue brief <KEY>                 Bulk JSON for skills / LLMs: the issue,
                                     parent feature, deduped linked docs
                                     (with full content inlined), comments,
                                     relations, PRs, and a warnings array.
                                     Always emits JSON. Single read; replaces
                                     the show + jq + per-doc-fetch dance.
  --no-feature-docs                     Skip docs linked to the parent feature
  --no-comments                         Skip the comments section
mk issue edit <KEY>
  --title <new title>
  --description <text|->
  --description-file <path>
  -f, --feature <slug>                  Move to a feature
  --no-feature                          Detach from any feature
mk issue state <KEY> <state>         Change state (accepts dashes/spaces)
mk issue assign <KEY> <name>         Set the assignee (free-form name; pass
                                     an agent identity when a bot picks
                                     up the work)
mk issue unassign <KEY>              Clear the assignee
mk issue next --feature <slug>       Atomically claim the next ready issue
                                     in a feature: lowest-numbered todo
                                     issue with all blockers
                                     done/cancelled/duplicate and no
                                     existing assignee. Flips it to
                                     in_progress and stamps the assignee
                                     with --user. Emits
                                     `{"issue": null}` (and exit 0) when
                                     nothing is currently claimable —
                                     callers should poll/retry rather
                                     than treat that as an error.
mk issue peek --feature <slug>       Read-only counterpart to `next`:
                                     shows what `next` would claim
                                     without mutating state. Same empty
                                     result shape when nothing is ready.
mk issue rm <KEY>                    Delete an issue (cascades to comments,
                                     relations, PRs, tags, doc links)
```

A bare number like `42` is also accepted for `<KEY>` and is interpreted relative to the current repo's prefix.

**Example:**
```bash
mk issue add "Login broken on Safari" -f auth-rewrite \
  --description-file /tmp/repro.md
mk issue list --state todo,in_progress -o json
mk issue state MINI-42 in-progress
mk issue show MINI-42

# Bulk context for an LLM/skill: issue + feature + linked docs (with raw
# content) + comments, in one read. Always JSON.
mk issue brief MINI-42 | tee /tmp/ctx.json
```

`mk issue brief` returns a single object: `{issue, feature?, relations, pull_requests, documents, comments, warnings}`. Each entry in `documents` carries `filename`, `type`, `description` (the link's `--why`), `linked_via` (one or both of `"issue"` and `"feature/<slug>"`), `source_path`, and `content`. Docs reachable from both the issue and its parent feature are deduped to a single entry whose `linked_via` lists both paths. If the issue and feature link rows have differing `--why` descriptions, the issue's wins and a string is appended to `warnings`.

**Driving an agent through a feature in dependency order.** Use `mk feature plan <slug>` to inspect the topo order, then loop on `mk issue next --feature <slug> --user <agent>` to claim issues one at a time:

```bash
# Read the plan once to understand what's ahead
mk feature plan service-addons-framework

# Agent loop: claim → work → mark done → repeat
while :; do
  next=$(mk issue next --feature service-addons-framework --user agent-1 -o json)
  key=$(jq -r '.issue.key // empty' <<<"$next")
  if [ -z "$key" ]; then sleep 30; continue; fi
  # ... agent does the work ...
  mk issue state "$key" done --user agent-1
done
```

Two agents can call `mk issue next` against the same feature in parallel; the SQLite writer lock plus a conditional UPDATE serialise claims, so each issue is handed to exactly one agent. When the DAG is currently serial (everything else blocked) the second agent simply gets `{"issue": null}` and should retry later. Crashed agents leave a stale `in_progress`/assigned issue — clear with `mk issue state <KEY> todo --user <human>` and `mk issue unassign <KEY>` to release it.

### Comments

```
mk comment add <KEY>                 Add a comment
  --as <name>                           Required: author name (no auth)
  --body <text|->                       Inline or stdin
  --body-file <path>                    Read body from a file
mk comment list <KEY>                List comments on an issue
```

**Example:**
```bash
printf 'Repro:\n1. open /login\n2. submit\n3. 500\n' \
  | mk comment add MINI-42 --as Claude --body -
```

### Relations between issues

Stored one-directionally. `blocked-by` is implicit — it's just the inverse view of `blocks`, surfaced automatically in `mk issue show`.

```
mk link <FROM> <type> <TO>           Create a relation
                                     types: blocks, relates-to, duplicate-of
mk unlink <A> <B>                    Remove every relation between two issues
                                     (regardless of direction)
```

**Example:**
```bash
mk link MINI-42 blocks MINI-43      # MINI-42 blocks MINI-43
mk link MINI-44 duplicate-of MINI-42
mk unlink MINI-42 MINI-43
```

### History (audit log)

Every mutation made via `mk` is appended to a per-DB audit log: who did it, when, against what, and a short detail string. Reads are not logged. The audit table has no foreign keys, so entries survive deletion of the entities they describe.

**Retention is 60 days.** Older entries are pruned automatically on every `mk` invocation, so don't expect long-term forensic history. Snapshot the DB if you need to keep something forever.

```
mk history                           Last 50 mutations in the current repo
  --limit N                            Cap output (default 50; 0 = no limit)
  --offset N                           Skip the first N entries (pagination)
  --oldest-first                       Reverse the default newest-first order
  --user-filter <name>                 Only entries by this actor
  --op <op>                            Exact op match (e.g. issue.state)
  --kind <kind>                        Filter by entity kind: issue, feature,
                                       document, or repo
  --since <duration>                   Look back this far: 30m, 1h, 1d, 2w
  --from <timestamp>                   Inclusive lower bound (mutually
                                       exclusive with --since)
  --to   <timestamp>                   Inclusive upper bound
  --all-repos                          Include every repo
```

`--from` / `--to` accept either local-time stamps (`YYYY-MM-DD`, `YYYY-MM-DD HH:MM`, `YYYY-MM-DD HH:MM:SS`) or RFC 3339 (e.g. `2026-05-03T07:27:14Z`). Bare dates start at 00:00 in the local timezone.

Op naming is dotted: `repo.create`, `feature.{create,update,delete}`, `issue.{create,update,state,assign,claim,delete}`, `comment.add`, `relation.{create,delete}`, `pr.{attach,detach}`, `tag.{add,remove}`, `document.{create,update,rename,delete,link,unlink}` (`mk doc upsert` records `document.create` or `document.update` depending on whether it created the row). Filtering by op prefix is not currently supported — match exactly, or use `--kind` for an entity-level cut.

**Examples:**
```bash
mk history --since 1d                                  # last 24h
mk history --user-filter Claude --op issue.create      # what Claude filed
mk history --kind document --since 1w                  # all doc activity this week
mk history --from 2026-05-01 --to 2026-05-03           # absolute range
mk history --oldest-first --since 1d                   # chronological replay
mk history --limit 25 --offset 25                      # second page
```

### Documents

A per-repo store of named text documents (markdown specs, design notes, vendor docs, …). Each document has a logical filename (unique within the repo) and a type drawn from a fixed vocabulary. Issues and features can link to documents with an optional `--why` description; re-linking the same pair upserts the description.

**Document types** (canonical underscore form; the parser also accepts dashes/spaces):
`user_docs | project_in_planning | project_in_progress | project_complete | vendor_docs | architecture | designs | testing_plans`. The list is extensible — additional types may appear over time.

```
mk doc add [filename]                Create a document
  --type <type>                         Required (unless derivable from --from-path)
  --content <text|->                    Body, or '-' for stdin
  --content-file <path>                 Read body from a file (UTF-8 text)
  --from-path <repo-relative-path>      Derive filename (and optionally type
                                         and content) from a path on disk

mk doc upsert [filename]             Create or update — same flag surface as add.
                                     Use this from skills to skip the
                                     "show, branch on exit code, then add or
                                     edit" shell dance.

mk doc list [--type <type>]          List documents in the current repo
mk doc show <filename> [--raw]       Print metadata + content + links
                                     (--raw: content only, ignores --output)
mk doc edit <filename>
  --type <type>                         Change type
  --content <text|->
  --content-file <path>
mk doc rename <old> <new>            Rename in place. Links are preserved
  --type <new-type>                      Optionally also change the type
                                          (handy when a plan moves
                                           not-shipped/ → shipped/)
mk doc export <filename>             Materialise a document onto disk
  --to-path                              Write to the path the doc was last
                                          imported from (--from-path on
                                          add/upsert; errors if none)
  --to <path>                            Write to an explicit repo-relative
                                          path
mk doc rm <filename>                 Delete a document (and its links)

mk doc link   <filename> <ISSUE-KEY|feature-slug> [--why <text>]
                                     Upsert a link with optional reason
mk doc unlink <filename> <ISSUE-KEY|feature-slug>
```

`<ISSUE-KEY|feature-slug>` auto-detects: anything matching `PREFIX-N` is an issue key, otherwise it's a feature slug in the current repo.

`mk issue show` and `mk feature show` both surface a "Linked documents:" section listing each document with its type and the per-link `--why` description (e.g. `auth-spec.md (architecture) — Source of truth for the JWT switch`).

**`--from-path` filename derivation:** replaces `/` with `-`, so
`docs/planning/not-shipped/foo-plan.md` → `docs-planning-not-shipped-foo-plan.md`.

**`--from-path` type derivation** (skip `--type` when one of these matches):

| path prefix                       | derived type           |
| --------------------------------- | ---------------------- |
| `docs/planning/not-shipped/`      | `project_in_planning`  |
| `docs/planning/in-progress/`      | `project_in_progress`  |
| `docs/planning/shipped/`          | `project_complete`     |

For any other path, pass `--type` explicitly. Explicit `--type` / `--content-file` always wins over derivation. When `--from-path` is given without `--content`/`--content-file`, the path itself is used as the content file.

**Example:**
```bash
# One-liner add: filename and type both derived, content read from disk.
mk doc add --from-path docs/planning/not-shipped/auth-plan.md

# Idempotent maintenance from a skill — no probe-then-branch shell dance.
mk doc upsert --from-path docs/planning/not-shipped/auth-plan.md

# Plan shipped: rename and bump the type in one step. Links survive.
mk doc rename \
  docs-planning-not-shipped-auth-plan.md \
  docs-planning-shipped-auth-plan.md \
  --type project_complete

# Materialise the canonical version back onto disk (the inverse of
# --from-path; mkdir -p as needed; overwrites if the file exists).
mk doc export docs-designs-foo.svg --to-path
mk doc export auth-spec.md --to docs/auth-spec.md  # or to an explicit path

# Manual filename / type still works.
mk doc add auth-spec.md --type architecture --content-file docs/auth.md
mk doc link auth-spec.md auth-rewrite --why "Source of truth for the JWT switch"
mk doc link auth-spec.md MINI-42 --why "Reference for the 500 fix"
mk doc list --type architecture
mk doc show auth-spec.md --raw > /tmp/auth.md
```

### Tags

Free-form string labels on issues. Case-sensitive (`WIP` ≠ `wip`), no internal whitespace, no fixed vocabulary — invent tags as you need them. Adding the same tag twice is a no-op.

```
mk tag add <KEY> <tag> [<tag>...]    Add one or more tags (idempotent)
mk tag rm  <KEY> <tag> [<tag>...]    Remove tags
```

For filtering or setting at creation, use the `--tag` flag on `mk issue add` and `mk issue list` (see above). Multiple `--tag` filters are AND-combined.

**Example:**
```bash
mk issue add "Login broken" --tag bug --tag backend --tag P0
mk tag add MINI-42 needs-design
mk issue list --tag bug --tag P0       # bugs that are also P0
```

### Pull requests

Attach plain HTTPS URLs (typically GitHub PR URLs) to an issue. URLs are stored verbatim — no normalisation, so `…/pull/374` and `…/pull/374/` are distinct.

```
mk pr attach <KEY> <URL>             Validates http/https + host
mk pr detach <KEY> <URL>             Exact URL match
mk pr list <KEY>                     One URL per line (or JSON)
```

**Example:**
```bash
mk pr attach MINI-42 https://github.com/owner/repo/pull/7
```

## Common workflows (JSON path — agent-preferred)

**File a bug with repro steps:**
```bash
mk issue add --user agent-claude --json '{
  "title": "Login returns 500",
  "state": "todo",
  "description": "## Repro\n1. POST /login with valid creds\n2. Server returns 500\n\n## Logs\nNullPointerException at AuthFilter.java:42"
}'
```

**Pick up an issue and link the PR:**
```bash
mk issue state   --user agent-claude --json '{"key":"MINI-42","state":"in_progress"}'
mk comment add   --user agent-claude --json '{"issue_key":"MINI-42","author":"Claude","body":"Picking this up."}'
mk pr attach     --user agent-claude --json '{"issue_key":"MINI-42","url":"https://github.com/owner/repo/pull/123"}'
```

**Mark blocked work:**
```bash
mk link --user agent-claude --json '{"from":"MINI-42","type":"blocks","to":"MINI-43"}'
mk issue show MINI-43          # MINI-43 will show "blocked by MINI-42" in relations
```

**Find what's in flight across all repos:**
```bash
mk issue list --all-repos --state in_progress,in_review -o json
```

**Preview a destructive change before committing:**
```bash
mk issue rm --user agent-claude --dry-run --json '{"key":"MINI-99"}' -o json
# Inspect cascade counts in the output, then re-run without --dry-run.
```

The same workflows are available via the older flag/positional surface for human use (`mk issue add "Login returns 500" --state todo --description-file /tmp/repro.md`). Agents should prefer the JSON path because it's strict, schema-published, and dry-runnable.

## HTTP API

`mk api` exposes every CLI mutation and read over HTTP, backed by the same SQLite database, the same `inputs.*Input` JSON shapes, the same store-side validators, and the same audit log. Use this surface when you can't be a child process of `mk` — web UIs, IDE plugins, long-running agents that already speak HTTP. The CLI stays available for shell-driven flows; the API is byte-for-byte equivalent for what overlaps.

Start it with:

```bash
mk api                                # bind 127.0.0.1:5320 (default), no auth
mk api --port 8080                    # same host, different port
mk api --addr 127.0.0.1:7777 --token T   # require Authorization: Bearer T
MK_API_TOKEN=T mk api                 # token via env (same effect as --token)
```

The same five conventions apply, in the same order:

1. **Discover the shape:** `GET /schema` (every command, one JSON object) or `GET /schema/{name}` (one command's schema with `examples[0]`). Both mirror `mk schema all` / `mk schema show` byte-for-byte.
2. **Compose the JSON body** to match the schema. Bodies are strict-decoded — unknown fields get a `400 invalid_input`.
3. **Rehearse with `?dry_run=true`** (or `X-Dry-Run: 1`). The response carries `X-Dry-Run: applied`, the body shape matches the real call, no row is written, no history entry is recorded.
4. **Execute** by dropping the dry-run flag and sending `X-Actor: <agent-name>` so audit rows attribute correctly.
5. **Query lean** by default. Issue / feature lists drop `description`; doc lists drop `content`. Opt-in to inflation with `?with_description=true` or `?with_content=true`.

Worked example, end to end:

```bash
# 1. Discover.
curl -s http://127.0.0.1:5320/schema/issue.add | jq .examples[0]

# 2. Compose & rehearse.
#    WHY ?dry_run=true: prove the payload validates and the projected
#    issue looks right before we touch the DB.
curl -s -X POST 'http://127.0.0.1:5320/repos/MINI/issues?dry_run=true' \
  -H 'Content-Type: application/json' \
  -H 'X-Actor: agent-claude' \
  -d '{
    "title": "Pin tab strip",
    "feature_slug": "tui-polish",
    "description": "Body height should clip the tab strip.",
    "tags": ["ui","tui"]
  }'

# 3. Commit (drop dry_run).
curl -s -X POST http://127.0.0.1:5320/repos/MINI/issues \
  -H 'Content-Type: application/json' \
  -H 'X-Actor: agent-claude' \
  -d '{ ...same payload... }'
```

### Endpoints

`{prefix}` is the 4-char repo prefix uppercased (`MINI`). `{key}` is the canonical `PREFIX-N` issue key (`MINI-42`) — the bare-number CLI shortcut is not accepted here. `{slug}` is the kebab-case feature slug. `{filename}` is the document filename. All bodies and responses are `application/json` except `GET /documents/{filename}/download`. Mutating endpoints accept `?dry_run=true|1` or `X-Dry-Run: 1|true`.

#### Meta

| Method | Path | Body | Success | Audit op |
|---|---|---|---|---|
| `GET` | `/healthz` | — | 200 `{ok,version}` | — |
| `GET` | `/schema` | — | 200 — every schema, keyed by name | — |
| `GET` | `/schema/list` | — | 200 — name + one-line summary | — |
| `GET` | `/schema/{name}` | — | 200 — single schema with `examples[0]` | — |

#### Repos

| Method | Path | Body | Success | Audit op |
|---|---|---|---|---|
| `GET` | `/repos` | — | 200 array | — |
| `POST` | `/repos` | `{prefix?, name, path, remote_url?}` | 201 repo | `repo.create` |
| `GET` | `/repos/{prefix}` | — | 200 repo | — |

`POST /repos` is the explicit equivalent of `mk init`. The CLI's auto-create-on-first-use only works because it can read CWD; over HTTP you have to spell out `name` and `path`. `prefix` is optional — the server allocates from `name` if omitted, same as the CLI.

#### Features

| Method | Path | Body | Success | Audit op |
|---|---|---|---|---|
| `GET` | `/repos/{prefix}/features` | — (`?with_description`) | 200 array | — |
| `POST` | `/repos/{prefix}/features` | `FeatureAddInput` | 201 feature | `feature.create` |
| `GET` | `/repos/{prefix}/features/{slug}` | — | 200 view (issues + linked docs) | — |
| `PATCH` | `/repos/{prefix}/features/{slug}` | `FeatureEditInput` | 200 feature | `feature.update` |
| `DELETE` | `/repos/{prefix}/features/{slug}` | — | 204 (200 dry-run preview) | `feature.delete` |
| `GET` | `/repos/{prefix}/features/{slug}/plan` | — | 200 plan | — |
| `GET` | `/repos/{prefix}/features/{slug}/next` | — | 200 `{issue}` (peek) | — |
| `POST` | `/repos/{prefix}/features/{slug}/next` | — (requires `X-Actor`) | 200 `{issue}` (claim) | `issue.claim` |

#### Issues

| Method | Path | Body | Success | Audit op |
|---|---|---|---|---|
| `GET` | `/repos/{prefix}/issues` | — (`?state`,`?feature`,`?tag`,`?with_description`) | 200 array | — |
| `POST` | `/repos/{prefix}/issues` | `IssueAddInput` | 201 issue | `issue.create` |
| `GET` | `/repos/{prefix}/issues/{key}` | — | 200 view (comments + relations + PRs + docs) | — |
| `GET` | `/repos/{prefix}/issues/{key}/brief` | — (`?no_feature_docs`,`?no_comments`,`?no_doc_content`) | 200 brief | — |
| `PATCH` | `/repos/{prefix}/issues/{key}` | `IssueEditInput` | 200 issue | `issue.update` |
| `DELETE` | `/repos/{prefix}/issues/{key}` | — | 204 (200 dry-run preview) | `issue.delete` |
| `PUT` | `/repos/{prefix}/issues/{key}/state` | `{state}` | 200 issue | `issue.state` |
| `PUT` | `/repos/{prefix}/issues/{key}/assignee` | `{assignee}` | 200 issue | `issue.assign` |
| `DELETE` | `/repos/{prefix}/issues/{key}/assignee` | — | 200 issue (no-op when already clear) | `issue.assign` |

#### Comments

| Method | Path | Body | Success | Audit op |
|---|---|---|---|---|
| `GET` | `/repos/{prefix}/issues/{key}/comments` | — | 200 array | — |
| `POST` | `/repos/{prefix}/issues/{key}/comments` | `CommentAddInput` (`{author, body}`) | 201 comment | `comment.add` |

#### Relations

| Method | Path | Body | Success | Audit op |
|---|---|---|---|---|
| `POST` | `/repos/{prefix}/relations` | `{from, type, to}` (canonical keys) | 201 relation | `relation.create` |
| `DELETE` | `/repos/{prefix}/relations` | `{a, b}` | 204 (200 dry-run preview) | `relation.delete` |

`type` is one of `blocks`, `relates-to` (alias `relates`), `duplicate-of` (alias `duplicates`).

#### Pull requests

| Method | Path | Body | Success | Audit op |
|---|---|---|---|---|
| `GET` | `/repos/{prefix}/issues/{key}/pull-requests` | — | 200 array | — |
| `POST` | `/repos/{prefix}/issues/{key}/pull-requests` | `{url}` | 201 pr | `pr.attach` |
| `DELETE` | `/repos/{prefix}/issues/{key}/pull-requests` | `{url}` or `?url=` | 204 (200 dry-run preview) | `pr.detach` |

#### Tags

| Method | Path | Body | Success | Audit op |
|---|---|---|---|---|
| `POST` | `/repos/{prefix}/issues/{key}/tags` | `{tags:[...]}` | 200 issue | `tag.add` |
| `DELETE` | `/repos/{prefix}/issues/{key}/tags` | `{tags:[...]}` | 200 issue | `tag.remove` |

#### Documents

| Method | Path | Body | Success | Audit op |
|---|---|---|---|---|
| `GET` | `/repos/{prefix}/documents` | — (`?type`, `?with_content`) | 200 array | — |
| `POST` | `/repos/{prefix}/documents` | `DocAddInput` | 201 document | `document.create` |
| `GET` | `/repos/{prefix}/documents/{filename}` | — (`?with_content=false` to drop body) | 200 view (doc + links) | — |
| `PUT` | `/repos/{prefix}/documents/{filename}` | `DocAddInput` (filename in URL wins) | 200 document | `document.create` or `document.update` |
| `PATCH` | `/repos/{prefix}/documents/{filename}` | `DocEditInput` | 200 document | `document.update` |
| `DELETE` | `/repos/{prefix}/documents/{filename}` | — | 204 (200 dry-run preview with cascade) | `document.delete` |
| `GET` | `/repos/{prefix}/documents/{filename}/download` | — | 200 `text/markdown` body, `Content-Disposition: attachment` | — |
| `POST` | `/repos/{prefix}/documents/{filename}/rename` | `{new_filename, type?}` | 200 document | `document.rename` |
| `POST` | `/repos/{prefix}/documents/{filename}/links` | `{issue_key OR feature_slug, description?}` | 201 link | `document.link` |
| `DELETE` | `/repos/{prefix}/documents/{filename}/links` | `{issue_key OR feature_slug}` | 204 (200 dry-run preview) | `document.unlink` |

#### History

| Method | Path | Body | Success | Audit op |
|---|---|---|---|---|
| `GET` | `/history` | — | 200 array (every repo) | — |
| `GET` | `/repos/{prefix}/history` | — | 200 array (single repo) | — |

Filters mirror the CLI: `?limit=` (default 50, 0 = no cap), `?offset=`, `?op=`, `?kind=`, `?actor=` (alias `?user_filter=`), `?since=`, `?from=`, `?to=`, `?oldest_first=true`. `since` and `from` are mutually exclusive. Bare-date stamps are local-timezone; RFC 3339 stamps are honoured as written. Reads are not audited.

### Authentication

When the server is started with `--token T` (or `MK_API_TOKEN=T`), every request except `GET /healthz` MUST send `Authorization: Bearer T`. Missing or wrong token → `401 unauthorized`. The token is compared with `subtle.ConstantTimeCompare`.

When no token is configured, requests are accepted without an `Authorization` header — the loopback default address (`127.0.0.1:5320`) is the trust boundary. There is no per-user auth; one token serves every caller.

### Actor identity

```
X-Actor: agent-claude
```

Every mutating endpoint stamps the audit row with the value from `X-Actor`. When the header is absent, the actor falls back to the literal string `"api"` (NOT the OS user the server runs as). The header is validated by `store.ValidateActor` once per request — control characters or overlength values fail with `400 invalid_input`.

`POST /repos/{prefix}/features/{slug}/next` is the one endpoint where `X-Actor` is **required**: claiming work demands a real assignee, so the server returns `400 invalid_input` with `details.field=X-Actor` if it's missing.

### Dry-run

```
?dry_run=true        # query parameter
?dry_run=1           # also accepted
X-Dry-Run: true      # header form (use whichever your client makes easier)
X-Dry-Run: 1
```

Every mutating endpoint accepts dry-run. The response status matches what a real call would return (e.g. `201 Created` on `POST /issues?dry_run=true`), the body is the projected entity in the same shape, the response carries `X-Dry-Run: applied`, no row is written, no history entry is recorded. Server-time fields (`id`, `created_at`, `updated_at`) come back zero, same as the CLI's `--dry-run`. Destructive endpoints (`DELETE`) return a `*DeletePreview` carrying cascade counts.

### Errors

Every error response is a single envelope:

```json
{
  "error": "title is required",
  "code": "invalid_input",
  "details": {"field": "title"}
}
```

| Status | Code | When |
|---|---|---|
| 400 | `invalid_input` | malformed JSON, unknown fields (strict decode), validator failure, missing required `X-Actor` on claim |
| 401 | `unauthorized` | `--token` configured and bearer is missing/wrong |
| 404 | `not_found` | path resolves no such repo / feature / issue / document |
| 409 | `conflict` | duplicate slug, duplicate prefix, duplicate PR attachment, document already exists |
| 413 | `payload_too_large` | request body exceeds the 4 MiB cap |
| 500 | `internal` | bug — server-side panic was caught by the recovery middleware |

`details` is optional and field-specific. Most validation errors include `details.field` pointing at the offending payload key.

### Lean lists

Same defaults as the CLI. List endpoints strip heavy fields by default; use these flags to inflate when you really need bodies:

- `GET /repos/{prefix}/issues?with_description=true|1` — inline `description` per row.
- `GET /repos/{prefix}/features?with_description=true|1` — same.
- `GET /repos/{prefix}/documents?with_content=true|1` — inline `content` per row.
- `GET /repos/{prefix}/documents/{filename}?with_content=false|0` — opposite direction: skip the body when fetching one doc by name.

`GET /repos/{prefix}/issues/{key}/brief` is the one bulk-context endpoint that *does* inline doc bodies on purpose. Use the three opt-out filters when the full payload is too large:

- `?no_feature_docs=1` — skip docs linked to the parent feature.
- `?no_comments=1` — skip the comments section.
- `?no_doc_content=1` — keep linked-doc metadata but drop the bodies.

### Special endpoints

- `GET /repos/{prefix}/issues/{key}/brief` — the agent's bulk-context single-fetch. Returns `{issue, feature?, relations, pull_requests, documents, comments, warnings}` in one call, with linked-doc bodies inlined. Replaces the `show` + per-doc-fetch dance. Always JSON.
- `POST /repos/{prefix}/features/{slug}/next` — atomic claim. **Requires `X-Actor`.** Picks the lowest-numbered todo issue in the feature with all blockers resolved and no existing assignee, flips it to `in_progress`, and stamps the assignee with the actor. Returns `{"issue": null}` (status 200) when nothing is currently claimable — poll/retry rather than treating that as an error. Records `issue.claim`.
- `GET /repos/{prefix}/features/{slug}/next` — read-only peek. Same response shape as the claim, no mutation, no audit row. Use this to inspect what the next claim *would* return before committing.
- `GET /repos/{prefix}/documents/{filename}/download` — the only non-JSON endpoint. Streams the doc body as `text/markdown; charset=utf-8` with `Content-Disposition: attachment; filename="<name>"`. No audit row, no `?dry_run`, no `with_content`. This replaces the CLI's `mk doc export --to-path`: the API never reads or writes the server filesystem, so callers materialise on disk by piping the response body themselves (e.g. `curl -O`).

### CLI verbs that have no API equivalent

Some CLI verbs touch the developer's local filesystem or terminal. They stay local-only and have no HTTP analogue:

- **`mk init`** — auto-detects the repo from CWD by walking up to a `.git` toplevel. The API can't see your working tree; use `POST /repos` with explicit `{name, path}`.
- **`mk install-skill`** — writes `.claude/skills/mk/SKILL.md` into the local repo. No remote sense.
- **`mk doc add --from-path` / `--content-file`** — read a file off the server's disk. Over HTTP, put the body in the request `content` field directly (it's just a JSON string, multi-line is fine).
- **`mk doc export --to-path` / `--to`** — write a file onto the server's disk. Over HTTP, use `GET /documents/{filename}/download` and let the client save the response stream.
- **`mk tui`** — full-screen terminal UI. Same DB; no point exposing it over HTTP.

The `mk schema*` commands have HTTP equivalents (`GET /schema*`) but the registry is identical, so a CLI agent can keep using either.

### Worked examples

**1. Create a repo and a first issue.**

```bash
# WHY: the API can't auto-detect a repo from CWD, so we register it explicitly.
curl -s -X POST http://127.0.0.1:5320/repos \
  -H 'Content-Type: application/json' \
  -H 'X-Actor: agent-claude' \
  -d '{"prefix":"MINI","name":"mini-kanban","path":"/home/me/Repos/mini-kanban"}'

# WHY: file the first ticket. Strict decode means a typo in `tilte` returns 400.
curl -s -X POST http://127.0.0.1:5320/repos/MINI/issues \
  -H 'Content-Type: application/json' \
  -H 'X-Actor: agent-claude' \
  -d '{"title":"First ticket","state":"todo","tags":["bootstrap"]}'
```

**2. Agent claim loop.**

```bash
# WHY: claim → work → mark done. Each iteration writes an audit row stamped
#      with X-Actor=agent-x, so the audit log shows exactly which agent did
#      what. Returns {"issue": null} when nothing is claimable; sleep+retry.
while :; do
  resp=$(curl -s -X POST \
    "http://127.0.0.1:5320/repos/MINI/features/auth-rewrite/next" \
    -H 'X-Actor: agent-x')
  key=$(jq -r '.issue.key // empty' <<<"$resp")
  if [ -z "$key" ]; then sleep 30; continue; fi

  # ... agent does the work, opens a PR, etc ...

  # WHY: PUT /issues/{key}/state replaces the state. Body shape published at
  #      /schema/issue.state — strict decode rejects extras.
  curl -s -X PUT "http://127.0.0.1:5320/repos/MINI/issues/$key/state" \
    -H 'Content-Type: application/json' \
    -H 'X-Actor: agent-x' \
    -d '{"state":"done"}'
done
```

**3. Bulk-context fetch for an LLM prompt.**

```bash
# WHY: one read returns the issue, parent feature, all linked docs (with
#      bodies inlined), comments, relations, and PRs. Drop --no-doc-content
#      if the docs themselves are too large for context.
curl -s "http://127.0.0.1:5320/repos/MINI/issues/MINI-42/brief?no_doc_content=1" \
  -H 'X-Actor: reader' \
  | jq .
```

### What the API deliberately doesn't do

Same posture as the CLI's "what we deliberately don't do" — these came up during design and were rejected for v1. New consumers shouldn't expect them.

- **No NDJSON / streaming / WebSockets.** Largest realistic response is one `issue brief`. Streaming complexity isn't justified.
- **No per-user auth or sessions.** One shared bearer token. This is a local helper, not a SaaS.
- **No remote `from-path` / `to-path` doc commands.** The API never reads or writes the server filesystem. Inline content in the body; pipe `/download` to disk.
- **No metrics / Prometheus endpoint.** `/healthz` is the only non-resource endpoint.
- **No CORS, no TLS termination, no rate limiting.** Designed for loopback and trusted LAN.
- **No cursor pagination.** History uses `?limit=` + `?offset=`; nothing else paginates yet.

For the full design rationale, the threat model, and the forward-looking "Phase 6: CLI client mode" sketch, see `docs/rest-api-design.md`.

## CLI client mode (`--remote` / `MK_REMOTE`)

The same `mk` binary can drive a remote `mk api` server instead of the local SQLite database, so an agent can use the familiar CLI surface against a shared kanban without changing flags or output format. Set one of:

- `--remote http://host:5320` (per-invocation flag), or
- `MK_REMOTE=http://host:5320` (env, persists across the shell), and
- `--token <secret>` / `MK_API_TOKEN=<secret>` if the server enforces auth.

```bash
MK_REMOTE=http://team-mk:5320 MK_API_TOKEN=$T mk issue list -o json
mk --remote http://team-mk:5320 issue add "Login broken" --feature auth
```

In remote mode every read and mutating verb above behaves exactly as it does locally — same flags, same JSON output, same `--dry-run` semantics, same `--user` actor. The client transparently translates each verb into the corresponding HTTP route from the table above. Audit rows are written by the API server, not the client.

Verbs that touch the developer's local filesystem stay local-only and error clearly when `MK_REMOTE` is set:

- `mk init` — auto-detects CWD; use `POST /repos` (or run `mk init` against the local DB) instead.
- `mk install-skill` — writes `.claude/skills/mk/SKILL.md` locally.
- `mk doc add --from-path` / `mk doc upsert --from-path` — read from the client filesystem; pass `--content`/`--content-file` instead.
- `mk doc export` (`--to-path` and `--to`) — writes to the client filesystem; use `mk doc download <filename>` (writes to stdout, or `--to <path>`) to get the body locally over HTTP.
- `mk tui` — opens the local DB directly.

`mk schema *` and `mk status` also stay local-direct (no remote endpoint exists in v1; the registry / stats are local concerns).

## Gotchas

- **Never run `mk` outside a git repo** when a command needs the current repo — it hard-errors with "not inside a git repository". `cd` first.
- **Comment author is required.** On the JSON path the field is `author`; on the flag path it's `--as <name>`. Forgetting it is the most common mistake.
- **`--user` is required for agents.** It controls the actor field in the audit log; without it every action looks like the OS user. The flag is permissive (no rejection if omitted) so this is on you to pass consistently.
- **Long text in JSON is just a string.** `description`, `body`, `content` etc. take inline strings — no `\n` translation magic, JSON's own `\n` escapes work as expected. The flag path's `--description-file` is unnecessary here.
- **Issue keys in JSON must be canonical** (`MINI-42`). The bare-number shortcut (`42`) is for humans on the flag path; agents driving JSON should always pass the prefix.
- **Mixing `--json` with positionals/flags is rejected.** Choose one mode per call.
- **State values** accept `in-progress`, `in progress`, or `in_progress` — but parsing is case-sensitive on the lowercase form.
- **Auto-created prefix can collide.** If two repos share a basename, `mk init` allocates `XXX2`, `XXX3`, etc. Use `mk repo list` to confirm what was assigned.
- **Issue numbers never repeat.** Deleting `MINI-3` does not free up the number — the next issue is still `MINI-4`.
- **JSON output is the contract.** When parsing programmatically, always pass `-o json`. Text output is for humans and may shift.

## Installation

If unsure whether `mk` is installed for the user, run `mk --help`. If it's missing, build from source in the mini-kanban repo:

```bash
go build -o ~/.local/bin/mk ./cmd/mk
```

The binary is self-contained (pure-Go SQLite, no CGO).

To install this skill into another repo so its agents can find it via Claude Code's project-skill auto-discovery, run from anywhere inside that repo:

```bash
mk install-skill
```

It walks up to the git root and writes `.claude/skills/mk/SKILL.md`, creating the directory if needed. The bundled SKILL.md content is the version embedded in the build of `mk` you're running, so re-run after upgrading `mk` to pull doc updates.
