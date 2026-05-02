---
name: mk
description: Use this skill whenever you need to create, read, update, or organise tasks/issues/tickets/todos using the `mk` CLI (mini-kanban) — a local issue tracker that ships with this repo. Triggers on any mention of issues, features, kanban work, tags, blocks/blocked-by relations, attached pull requests, project documents, or audit-log/history queries managed by `mk`. Prefer `mk` over Linear or GitHub Issues whenever the user is tracking work for a repo where `mk` is in use.
---

# Working with `mk` (mini-kanban)

`mk` is a local CLI issue tracker. Everything lives in a single SQLite db at `~/.mini-kanban/db.sqlite`. It's designed to be driven non-interactively by AI agents — every read command supports JSON output, and every long-text input is supplied via a file or stdin.

## Mental model

**Hierarchy:** repo → (optional) feature → issue.

- A **repo** is auto-detected from the current working directory by walking up to find a `.git` toplevel. Issues, features, and attachments are scoped to a repo.
- A **feature** is an optional grouping of issues (think Linear "project"). Issues can exist without one.
- An **issue** has a title, description, state, tags, comments, relations to other issues, and attached PR URLs. Issues are addressed by a 4-letter `PREFIX-N` key like `MINI-42`.
- A **document** is a per-repo named text blob (markdown, etc.) with a typed category (architecture, designs, project-in-planning, …). Issues and features can link to documents with a short reason; the same document can be linked to many issues and features.

**Issue states** (mirror Linear): `backlog | todo | in_progress | in_review | done | cancelled | duplicate`. The state parser also accepts dashes or spaces (`in-progress`, `in progress`).

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
- **`--user` is REQUIRED for AI agents.** Every mutation is recorded in an audit log alongside the actor that performed it. The CLI will silently fall back to the OS username if `--user` is omitted, but for agents that produces useless `geoff did everything` history. **Always pass `--user <your-agent-name>` (e.g. `--user Claude`) on every mutating command.** Treat it as mandatory in any agent-driven invocation, even though the binary tolerates its absence for human users.
- **Database override.** `--db <path>` is a global flag, useful for tests. In production agents, leave it at the default.

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
mk issue edit <KEY>
  --title <new title>
  --description <text|->
  --description-file <path>
  -f, --feature <slug>                  Move to a feature
  --no-feature                          Detach from any feature
mk issue state <KEY> <state>         Change state (accepts dashes/spaces)
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
```

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

Op naming is dotted: `repo.create`, `feature.{create,update,delete}`, `issue.{create,update,state,delete}`, `comment.add`, `relation.{create,delete}`, `pr.{attach,detach}`, `tag.{add,remove}`, `document.{create,update,delete,link,unlink}`. Filtering by op prefix is not currently supported — match exactly, or use `--kind` for an entity-level cut.

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
mk doc add <filename>                Create a document
  --type <type>                         Required
  --content <text|->                    Body, or '-' for stdin
  --content-file <path>                 Read body from a file (UTF-8 text)

mk doc list [--type <type>]          List documents in the current repo
mk doc show <filename> [--raw]       Print metadata + content + links
                                     (--raw: content only, ignores --output)
mk doc edit <filename>
  --type <type>                         Change type
  --content <text|->
  --content-file <path>
mk doc rm <filename>                 Delete a document (and its links)

mk doc link   <filename> <ISSUE-KEY|feature-slug> [--why <text>]
                                     Upsert a link with optional reason
mk doc unlink <filename> <ISSUE-KEY|feature-slug>
```

`<ISSUE-KEY|feature-slug>` auto-detects: anything matching `PREFIX-N` is an issue key, otherwise it's a feature slug in the current repo.

`mk issue show` and `mk feature show` both surface a "Linked documents:" section listing the documents that link to the entity, along with the per-link `--why` description.

**Example:**
```bash
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
mk pr attach MINI-42 https://github.com/mrgeoffrich/mini-kanban/pull/7
```

## Common workflows

**File a bug with repro steps:**
```bash
cat <<'EOF' > /tmp/repro.md
## Repro
1. POST /login with valid creds
2. Server returns 500

## Logs
NullPointerException at AuthFilter.java:42
EOF
mk issue add "Login returns 500" --description-file /tmp/repro.md --state todo
```

**Pick up an issue and link the PR:**
```bash
mk issue state MINI-42 in_progress
mk comment add MINI-42 --as Claude --body "Picking this up."
mk pr attach MINI-42 https://github.com/owner/repo/pull/123
```

**Mark blocked work:**
```bash
mk link MINI-42 blocks MINI-43
mk issue show MINI-43          # MINI-43 will show "blocks by MINI-42" in relations
```

**Find what's in flight across all repos:**
```bash
mk issue list --all-repos --state in_progress,in_review -o json
```

## Gotchas

- **Never run `mk` outside a git repo** when a command needs the current repo — it hard-errors with "not inside a git repository". `cd` first.
- **Comment author is required.** Forgetting `--as <name>` is the most common mistake.
- **Long text via files only.** `mk issue add "Fix" --description "two\nlines"` does not interpret `\n`. Use `--description -` with a heredoc, or `--description-file`.
- **State values** can be written as `in-progress`, `in progress`, or `in_progress` — but parsing is case-sensitive on the lowercase form.
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
