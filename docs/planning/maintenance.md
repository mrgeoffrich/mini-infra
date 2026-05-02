# Maintenance

## 1. Background

Catch-all evergreen plan doc for one-off maintenance and follow-up tasks
filed via the `task-to-linear` skill. Each task is a `### Phase N` entry
below. Tasks are independent — they do not block each other and they do
not have to land in numerical order. The "Phase" wording is preserved so
`execute-next-task` matches by phase number; nothing more is implied.

This doc is never archived to `docs/planning/shipped/`. Tasks shipped
long ago stay here as historical record (or are pruned manually when the
list gets unwieldy — that's a human decision).

## 6. Phased rollout

<!-- task-to-linear appends new phases below this comment -->

### Phase 1 — Upgrade @anthropic-ai/claude-agent-sdk in server and agent-sidecar

**Linear:** [ALT-31](https://linear.app/altitude-devops/issue/ALT-31)

**Goal.** Bump `@anthropic-ai/claude-agent-sdk` to the latest stable release across every package that depends on it, aligning both consumers on the same version.

**Deliverables.**
- Bump `@anthropic-ai/claude-agent-sdk` in `server/package.json` (currently `^0.2.123`).
- Bump `@anthropic-ai/claude-agent-sdk` in `agent-sidecar/package.json` (currently `^0.2.107`).
- Consider bumping the related `@mrgeoffrich/claude-agent-sdk-tap` (`^0.1.8`) in `agent-sidecar/` if a compatible newer version exists.
- Update `pnpm-lock.yaml` and `agent-sidecar/package-lock.json` accordingly.
- Resolve any TypeScript / API breakage from the version jump.

**Done when.** Both packages build, lint, and pass their unit test suites against the upgraded SDK with no regressions; both consumers are on the same SDK minor/patch.

**Smoke.** Unit / build / lint only — `pnpm --filter mini-infra-server build|test|lint` from root, plus `cd agent-sidecar && npm install && npm run build && npm test`.

## 8. Linear tracking

Tracked under the **Maintenance** project on the Altitude Devops team.
Issue IDs are recorded inline against each phase above when the skill
appends them.
