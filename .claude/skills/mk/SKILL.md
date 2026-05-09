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

**Driving an agent through a feature in dependency order.** Inspect the topo order with `mk feature plan <slug>`, then loop on `mk issue next --feature <slug> --user <agent> -o json`, treating `{"issue": null}` as "retry later". Multiple agents can call `next` in parallel — SQLite serialises the claim. Crashed agents leave a stale `in_progress`/assigned issue; clear with `mk issue state <KEY> todo` + `mk issue unassign <KEY>`.

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

**`--from-path` type derivation:** `docs/planning/{not-shipped,in-progress,shipped}/` → `project_in_{planning,progress,complete}`. For any other path, pass `--type` explicitly. Explicit `--type` / `--content-file` always wins over derivation. When `--from-path` is given without `--content`/`--content-file`, the path itself is used as the content file.

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

## HTTP API

`mk api` exposes every CLI mutation and read over HTTP, backed by the same SQLite database, JSON shapes, validators, and audit log. **The CLI conventions above all apply** — discover schemas, compose JSON, dry-run, then commit. The only differences are HTTP plumbing.

```bash
mk api                                # bind 127.0.0.1:5320, no auth
mk api --addr 127.0.0.1:7777 --token T   # require Authorization: Bearer T
MK_API_TOKEN=T mk api                 # token via env
```

### Discovery

- `GET /schema/list` — every command name + one-line summary (mirrors `mk schema list`).
- `GET /schema/{name}` — full JSON Schema for one command with `examples[0]` (mirrors `mk schema show`).
- `GET /schema` — every schema in one object.

Schemas describe payload shapes, not routes. Routes follow REST conventions under `/repos/{prefix}/...` — list/create on the collection, show/patch/delete on the item, plus sub-resources for state changes (`/state`, `/assignee`), batch ops (`/tags`, `/pull-requests`), graph edges (`/relations`, `/links`), bulk reads (`/brief`, `/plan`), and claim/peek (`/next`). Use `GET /schema/list` to enumerate every operation. Issue keys in URLs and bodies must be canonical (`MINI-42`); the bare-number CLI shortcut isn't accepted.

A few non-obvious mappings:

- **Tags:** `POST/DELETE /repos/{prefix}/issues/{key}/tags` with `{"tags":[...]}` (batch, not per-tag URLs).
- **Relations:** `POST /repos/{prefix}/relations` with `{"from","type","to"}`; `DELETE` with `{"a","b"}` (bidirectional).
- **PR detach:** `DELETE /repos/{prefix}/issues/{key}/pull-requests` with `{"url"}` or `?url=`.
- **Documents:** link/unlink at `POST/DELETE /documents/{filename}/links`; rename at `POST /documents/{filename}/rename`.
- **State / assignee:** `PUT /issues/{key}/state`, `PUT/DELETE /issues/{key}/assignee`.

### Headers, query params, dry-run

- **Auth.** When `--token` / `MK_API_TOKEN` is set, every request except `GET /healthz` needs `Authorization: Bearer <token>` (constant-time compare). The loopback default with no token is the trust boundary.
- **Actor.** `X-Actor: <agent-name>` stamps the audit log. Absent → falls back to the literal `"api"` (NOT the OS user). **Required** on `POST /repos/{prefix}/features/{slug}/next` — claiming work demands a real assignee.
- **Dry-run.** `?dry_run=true` (or `=1`) or `X-Dry-Run: 1`. Response status matches a real call, body is the projected entity, response carries `X-Dry-Run: applied`. No row written, no audit row recorded. Server-time fields (`id`, `created_at`, `updated_at`) come back zero. `DELETE` returns a `*DeletePreview` with cascade counts.
- **Lean lists.** Issue/feature lists drop `description`; doc list drops `content`. Inflate with `?with_description=true` or `?with_content=true`. For a single doc, `?with_content=false` strips the body the other way.
- **Brief opt-outs.** `?no_feature_docs=1`, `?no_comments=1`, `?no_doc_content=1` on `GET /issues/{key}/brief`.
- **History filters.** `?limit`, `?offset`, `?op`, `?kind`, `?actor` (alias `?user_filter`), `?since`, `?from`, `?to`, `?oldest_first` on `GET /history` and `GET /repos/{prefix}/history`. `since` and `from` are mutually exclusive.

### Errors

```json
{ "error": "title is required", "code": "invalid_input", "details": {"field": "title"} }
```

| Status | Code | When |
|---|---|---|
| 400 | `invalid_input` | malformed JSON, unknown fields, validator failure, missing required `X-Actor` on claim |
| 401 | `unauthorized` | token configured and bearer is missing/wrong |
| 404 | `not_found` | path resolves no such entity |
| 409 | `conflict` | duplicate slug/prefix/PR URL/document filename |
| 413 | `payload_too_large` | body > 4 MiB |
| 500 | `internal` | server-side panic (caught by recovery middleware) |

### API-only quirks

- **`POST /repos`** is the equivalent of `mk init`, but the server can't see your CWD — supply `{"name":"...", "path":"..."}` (plus optional `prefix`) explicitly.
- **`GET /repos/{prefix}/documents/{filename}/download`** is the only non-JSON endpoint. Streams the body as `text/markdown` with `Content-Disposition: attachment`. No audit row, no dry-run, no `with_content`. The API never reads or writes the server filesystem, so callers materialise on disk by piping the response (`curl -O`).
- **CLI verbs with no API equivalent** (touch the local filesystem or terminal): `mk init` (use `POST /repos`), `mk install-skill`, `mk doc add --from-path` / `--content-file` (inline `content` in the body), `mk doc export` (use `/download`), `mk tui`.

For the full design rationale, threat model, and what the API deliberately doesn't do (NDJSON, per-user auth, CORS, cursor pagination, …), see `docs/rest-api-design.md`.

## CLI client mode (`--remote` / `MK_REMOTE`)

`mk` can drive a remote `mk api` server instead of the local DB. Set `--remote http://host:5320` (or `MK_REMOTE=...`) and, if the server enforces auth, `--token` / `MK_API_TOKEN`. Every read and mutating verb behaves identically — same flags, same JSON output, same `--dry-run`, same `--user`. The client translates each verb into the matching HTTP route; audit rows are written by the server.

```bash
MK_REMOTE=http://team-mk:5320 MK_API_TOKEN=$T mk issue list -o json
mk --remote http://team-mk:5320 issue add "Login broken" --feature auth
```

Verbs that touch the local filesystem or terminal error clearly in remote mode and stay local-direct: `mk init`, `mk install-skill`, `mk doc add --from-path` / `--content-file` (use `--content` inline instead), `mk doc export` (use `mk doc download <filename>` — writes to stdout or `--to <path>`), `mk tui`, `mk schema *`, `mk status`.

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
