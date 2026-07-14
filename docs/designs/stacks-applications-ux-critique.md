# Stacks, Stack Templates & Applications — UX and Completeness Critique

*Review date: 2026-07-14. Covers the server stacks domain, stack templates (server + authoring UI), the client surfaces where stacks appear, and the Applications feature — with specific focus on the missing "all stacks" view, the application Update button dead-ends, and the general confusion around the stack UI.*

---

## Executive summary

Mini Infra's backend already implements most of the right model: a **StackTemplate** is a versioned blueprint (draft → publish), and a **Stack** is a single installed instance of it, carrying provenance (`templateId`, `templateVersion`), its own definition revision counter, a last-applied snapshot, and plan/apply reconciliation. That is exactly the "installed instance you upgrade with new definitions" model we want (think Helm's chart → release).

The problems are that the model is **half-finished on the server and almost invisible in the UI**:

1. **Stacks have no home.** There is no `/stacks` route, no nav entry, no stack detail page, and no deep link to any stack. Stacks surface only as inline expandable panels scattered across `/environments`, `/environments/:id`, `/applications`, and `/network-access`.
2. **The upgrade story is display-only.** The server computes `templateUpdateAvailable` on every stack, but *no endpoint consumes it and no client code reads it*. Publishing a new version of a user template does nothing for existing stacks; only system stacks get upgraded, automatically, at boot. Applications inherit this: every config edit publishes a new template version that **never reaches the deployed stack**.
3. **The Update button genuinely wedges.** A stack stuck in `pending` disables the button with no explanation and no recovery action; several failure paths orphan stacks in `pending` because they never write `error`. The redeploy path rejects every status except `synced`, and the applications UI has no Apply button to satisfy its own "Apply the stack first" error message.
4. **One concept has three names.** The same template is an "Application", an "Infrastructure Stack", and a "Stack Template" depending on the page; the same stack object gets three different status badge implementations. Server errors say "stack" in an "application" UI.
5. **Destructive actions are mislabeled.** The application "Stop" button destroys the stack (deletes the DB row — data loss for Stateful services), and the template list's "Archive" menu item hard-deletes the template *and all its linked stacks*.

Sections below give the evidence with file references, then a prioritized set of recommendations.

---

## 1. The model as actually implemented

Worth stating plainly, because no page in the UI does:

- **StackTemplate** (`server/prisma/schema.prisma:1595`) — versioned blueprint. Draft (version 0) → publish (sequential versions, `currentVersionId` moves). Source `system|user`, scope `host|environment|any`.
- **Stack** (`schema.prisma:1059`) — a single installed instance. At instantiate time the template version's services are **copied** onto the stack; provenance is kept as `templateId` + `templateVersion` (an `Int`, not an FK — `schema.prisma:1071-1073`).
- **An "Application" does not exist on the server.** It is a client-side skin: list = `GET /stack-templates?source=user`, deploy = `instantiate` + `apply`, edit = new template draft + publish (`client/src/hooks/use-applications.ts`).
- **Three version counters coexist per stack**, none explained in the UI:
  - `Stack.version` — bumped on every definition edit (`stacks-crud-routes.ts:337`, `stacks-service-routes.ts:85`)
  - `Stack.lastAppliedVersion` — the revision that last reached containers (`stack-reconciler.ts:447`)
  - `Stack.templateVersion` — the template version the stack was born from / last upgraded to
- **Reconciliation** — `GET /:id/plan` diffs desired service hashes against running container labels (`stack-plan-computer.ts:33`); `POST /:id/apply` runs the Vault → NATS → services pipeline in the background (`stacks-apply-route.ts:198`); `POST /:id/update` is a pull-latest-and-recreate.

The bones are good. Everything below is about the missing joints.

---

## 2. Stacks have no home

**There is no `/stacks` route** (`client/src/lib/routes.tsx`) and no "Stacks" entry in the sidebar (`client/src/lib/route-config.ts:592-611`). `useStacks()` is never called without a scope filter anywhere in the client — no global list query exists at all.

To enumerate every stack on the box, an operator must visit:

| Surface | What it shows | File |
|---|---|---|
| `/environments` (the *list* page) | Host-scoped infra stacks, under a card titled "Infrastructure Stacks" whose rows are actually *templates* with an embedded linked-stack badge | `client/src/components/host/host-templates-list.tsx` |
| `/environments/:id` | Env-scoped infra stacks (`StacksList`) plus a separate "Applications" card | `client/src/app/environments/[id]/page.tsx:235-252, 314` |
| `/applications` | User stacks, dressed as applications | `client/src/app/applications/page.tsx` |
| `/network-access` | The Tailscale ingress stack, with its own bespoke apply flow | `client/src/app/network-access/page.tsx:206-445` |

Additional problems compounding this:

- **No stack detail page or dialog.** The entire inspect/plan/apply experience is an inline expandable panel (`StackPlanView`, mounted at `stacks-list.tsx:248` and `host-templates-list.tsx:193`). Nothing is linkable or bookmarkable. `PrerequisitesBanner` has to deep-link to `/?template=…` as a documented "best effort" *because there is no canonical URL for a stack* (`PrerequisitesBanner.tsx:83-89`).
- **Host infrastructure lives on the environments list page** — a surprising location with no `/host` route to move it to.
- **Key actions are hidden.** "Sync Anyway", "Redeploy Containers", and "Uninstall" only exist inside the expanded in-sync panel (`StackPlanView.tsx:404-490`); collapsed rows give no hint a plan view is inside; undeployed host rows can't be expanded at all (`host-templates-list.tsx:135-137`).
- **The server list endpoint has a surprising contract.** Bare `GET /api/stacks` does return everything, but adding `environmentId` or `scope=host` silently restricts results to system-or-templateless stacks unless `source=user` is also passed (`stacks-crud-routes.ts:109-114`). "List this environment's stacks" hides application stacks by default.

---

## 3. The upgrade story is display-only

This is the biggest conceptual gap relative to "stacks are single installed instances that users upgrade with new definitions."

**What exists:**
- `templateUpdateAvailable` is computed on every serialized stack and every plan (`server/src/services/stacks/utils.ts:113,125`; `stack-plan-computer.ts:291-295`) and carried in the shared types (`lib/types/stacks.ts:531,865`).
- A real upgrade routine exists — `upgradeStackFromTemplate` re-materializes services from a newer template version, merges input values (`mergeForUpgrade`), bumps `templateVersion`, and sets `pending` (`builtin-stack-sync.ts:103-251`).

**What's missing:**
- **No endpoint consumes `templateUpdateAvailable`.** There is no `POST /api/stacks/:id/upgrade`. The only caller of the upgrade routine is boot-time sync, gated to `builtinVersion != null` — i.e. **system stacks only** (`builtin-stack-sync.ts:108-109`).
- **No client code reads `templateUpdateAvailable`.** Zero hits in `client/src`. Even the signal the backend already produces is invisible.
- **Applications are built on top of this hole.** Editing an application's Configuration tab publishes a **new template version** (`use-applications.ts:294-326`) — and then navigates away with a success toast. The deployed stack keeps running the old definition indefinitely. Even "Redeploy" won't pick the edit up: `POST /:id/update` reconciles the stack's *stored* definition, not the template's latest. The only way config edits reach a running stack today is **Stop (destroy!) + Deploy (re-instantiate)** — which loses volumes state for Stateful services. Only the Addons and Networks cards even hint at this ("Stop, then Deploy" — `addons-card.tsx:154`, `connected-networks-card.tsx:347`); the Configuration tab itself is silent.
- **Two divergent write paths that never reconcile.** The list card's Update writes the docker tag directly onto the *stack* service (`PUT /stacks/:id/services/:name` → apply), while the Configuration tab writes to the *template*. Stack definition and template drift apart with nothing to converge them.
- **The publish dialog copy is misleading.** "All future deployments will use this version" (`stack-templates/[templateId]/page.tsx:507`) — true, but it implies existing deployments follow, which they never do.
- **The provenance link is fragile.** `Stack.templateVersion` is a loose integer matched by `(templateId, version)` lookups (e.g. `stacks-crud-routes.ts:388-396`), not an FK to `StackTemplateVersion`. It works, but nothing enforces integrity.

---

## 4. The Update button dead-ends (Applications)

The complaint "applications can get into a state where the update button doesn't work" is reproducible from the code in at least five ways.

**How the button works.** The list card's Update trigger is disabled when `effectivelyBusy = isBusy || deployUpdate.isPending || taskExecuting` (`application-card.tsx:119,286`), where `isBusy` includes *any of the app's stacks having status `pending`* (`applications/page.tsx:274`). The confirm button then either: tag changed → `PUT /stacks/:id/services/:name` + `POST /apply`; tag unchanged → `POST /stacks/:id/update` (`use-applications.ts:407-436`).

**Wedge #1 — orphaned `pending` permanently disables Update (the headline bug).**
The tag-change path *first* writes `status: 'pending'`, `version+1` (`stacks-service-routes.ts:81-87` — an endpoint with **no operation lock and no status guard**), then calls apply. If apply fails early — synchronous 4xx (params not configured `stacks-apply-route.ts:107`, prerequisites 409/422 at `:135-141`) or a background pre-reconciler failure (Vault phase `:281-287`, JobPool dry-run `:317`, plan/init catch `:494-518`) — **no `error` status is ever written**: `emitStackApplyFailed` is a pure socket emit (`stack-socket-emitter.ts:59`), and the reconciler only writes `error` at its own end, which is never reached. The stack sits in `pending` forever → `isBusy` → Update disabled, with no tooltip, no explanation, and no recovery action anywhere in the applications UI.

**Wedge #2 — "Redeploy" always errors for non-synced stacks.**
`POST /:id/update` rejects any status other than `synced|drifted` with 400 `STACK_NOT_DEPLOYED`: *"Apply the stack first, then retry the update"* (`stacks-update-route.ts:48`). But the applications UI **has no Apply button** — the detail header offers only Deploy (hidden once stacks exist, `layout.tsx:263`), Stop, and Delete. So for a stack in `error`/`undeployed`, Update appears enabled but every unchanged-tag click just toasts an error whose remedy the UI cannot perform. (The undocumented escape hatch: *change the tag*, which routes through apply instead — nobody would guess that.)

**Wedge #3 — the `drifted` allowance is dead code.**
Nothing in the repo ever writes `status: 'drifted'` to a stack, so the `/update` guard effectively requires exactly `synced` (see §5).

**Wedge #4 — a hung apply bricks the stack until server restart.**
`stackOperationLock` is an in-memory set with no timeout and no force-release (`operation-lock.ts`). If an apply hangs (e.g. a Docker pull that never resolves), `finally` never runs, and apply, update, *and destroy* all 409 (`STACK_OPERATION_IN_PROGRESS`) until the process restarts.

**Wedge #5 — a missed terminal socket event latches `taskExecuting`.**
The card also disables on tracked-task phase `executing` (`application-card.tsx:118`); a missed `STACK_APPLY_COMPLETED`/failed event during a disconnect keeps the button dead independent of DB status.

**Adjacent problems:**
- "Redeploy" with all images current silently no-ops but still toasts success (`stack-reconciler.ts:551-573`) — no "already up to date" feedback.
- Adopted applications get no Update button at all, with no explanation (`application-card.tsx:281`).
- `synced` can lie: a service that starts then immediately crashes leaves the stack `synced` with dead containers (`stack-container-manager.ts:313-323`).
- **"Stop" is a destroy.** `useStopApplication` → `POST /stacks/:id/destroy` (`use-applications.ts:384`, task type literally `stack-destroy` in `layout.tsx:132`) which tears down *and deletes the stack row* (`stacks-destroy-route.ts:228`). There is no "stop but keep" for user stacks — `stopStack()` exists (`stack-reconciler.ts:1153`) but is only wired to monitoring (`routes/monitoring.ts:99`).

---

## 5. The status model is half-implemented and never explained

- **Six enum values, four ever written.** `StackStatus` declares `synced|drifted|pending|error|undeployed|removed` (`schema.prisma:1024`), but nothing ever writes `drifted` or `removed`. `drifted` is *read* in the `/update` guard (dead branch); `removed`/`removedAt` are only ever cleared or checked in name-conflict guards. Both imply a lifecycle (background drift marking, soft-delete tombstones) that was never built.
- **Drift is plan-time only, and split in two.** Container drift exists only as a transient plan computation; NATS drift is a separate soft signal (`nats-drift-detector.ts`) that can be true while status reads `synced` (acknowledged in its own doc comment, lines 19-23). Two orthogonal "needs attention" signals, no rollup, and the status badge reflects neither.
- **No status is explained anywhere.** `StackStatusBadge` is a bare colored pill with no tooltip (`StackStatusBadge.tsx:47-57`). Nothing tells a user what `pending` means or what to do about it.
- **Three renderings of the same field.** Infra lists use `StackStatusBadge`; the env-detail Applications card renders raw `stack.status` in a plain `<Badge>` (`environments/[id]/page.tsx:242-247`); the application layout maps only `synced→Running` and `error→Error`, leaving `pending`/`undeployed` raw (`layout.tsx:194-203`).
- **No recovery affordances.** `error` has no retry/rollback (re-apply is the implicit answer, but see §4 for where Apply isn't reachable); `pending` has no cancel/reset; `lastFailureReason` is stored and shown but no action consumes it.

---

## 6. Template authoring gaps

The authoring page (`client/src/app/stack-templates/[templateId]/page.tsx`) has a solid draft/publish skeleton with auto-save, but:

**Data-loss and destructive-action bugs (fix first):**
- **The Code view is lossy.** Saving YAML replaces the entire draft via a codec that drops `inputs`, `vault`, `nats`, and `requires` sections entirely, and strips per-service `addons`/`poolConfig`/`natsRole`/`vaultAppRoleRef` (`code-view.tsx:64-74`, `yaml-codec.ts:26-37`). Anyone who opens a template with addons or Vault/NATS config in Code view and hits Save silently destroys those sections. (The graphical service drawer preserves unmodeled fields correctly — `service-edit-drawer.tsx:111`.)
- **"Archive" is a hard delete — of the template *and all its stacks*.** The list row menu item labeled "Archive" ("Archived templates will no longer appear in the default list", `template-table.tsx:170-198`) calls `DELETE /stack-templates/:id`, which `stack.deleteMany`s every linked stack then deletes the template (`stack-template-service.ts:485-509`). Meanwhile the *real* soft-archive (`isArchived` flag, list filter, revival on re-create) is fully plumbed but **no code path ever sets it** — the "Include archived" filter can never show anything.
- **No confirmation on service delete** (`template-services-section.tsx:236`), and auto-save persists it immediately with no undo.

**Completeness gaps:**
- **Vault, NATS, `requires`, and `inputs` have no authoring UI at all** — not graphical, and (per the lossy codec) not even the code view. These are API-only features despite full schema/validation support (`stack-template-schemas.ts:37-271`).
- **No version diff and no rollback.** The sidebar shows one version read-only; nothing compares vN to vN+1, publish shows no changed-fields summary, and rollback means "Create Draft from vN" (clobbering any existing draft) and publishing a brand-new version — `currentVersionId` can't be re-pointed.
- **No usage view.** `listTemplates({includeLinkedStacks})` exists server-side, but neither the templates list nor detail page shows which stacks use a template — so there's no blast-radius view before "Archive" (which, per above, deletes those stacks).
- **System templates present editing affordances that always fail.** No `source === 'system'` guard on the detail page: "Create Draft" renders enabled and errors server-side (`STACK_TEMPLATE_SYSTEM_IMMUTABLE`, `stack-template-service.ts:163-177`).
- **Metadata is over-gated.** Fixing a description requires creating a draft, though `PATCH /:id` is version-independent (`page.tsx:424`).
- **Instantiation is impoverished outside the app wizard.** Host/env lists instantiate with no name and no parameter overrides (`host-templates-list.tsx:45`); the hook never forwards `inputValues` even though the API accepts them (`use-stack-templates.ts:275-299` vs `stack-template-schemas.ts:558`); the create dialog can't produce `any`-scoped templates (`create-template-dialog.tsx:186-188`); there's no instantiate button on the template detail page itself.
- **Minor:** the archived *version* status is equally dead (nothing sets it; the sidebar's archived section is unreachable); publish's ≥1-service rule only surfaces as a post-click toast; the shared addon dialog says "saved to the application… on its next redeploy" even in template-authoring context (`attach-addon-dialog.tsx:152-153`).

---

## 7. Terminology: one concept, three names

- The same **StackTemplate** is presented as an "Application" (`/applications`), an "Infrastructure Stack" row (`host-templates-list.tsx:88`), and a "Stack Template" (`/stack-templates`).
- The same **Stack** is a "Stack" in infra lists and an "Application" in the applications UI — with completely divergent affordances (full plan/diff/selective-apply/uninstall panel vs. Deploy/Stop/Delete and nothing else), so an operator's mental model doesn't transfer.
- The Applications list page's own subtitle says **"Manage your application templates"** — conflating the two concepts on the landing page.
- Server error vocabulary leaks: an "application" user sees *"Stack must be deployed to update"*, `STACK_OPERATION_IN_PROGRESS`, etc.
- Host-scoped stacks appear under a card on the *environments list* page, titled "Infrastructure Stacks", whose rows are templates.

---

## 8. Recommendations

### P0 — stop the bleeding (correctness, data loss, wedged users)

1. **Make every apply failure write `error`.** Any path that can leave a stack `pending` must terminate in a persisted status: the synchronous 4xxs after a `PUT /services` bump, and every background pre-reconciler failure (Vault/NATS/JobPool/plan-init) alongside its `emitStackApplyFailed`. Consider having `PUT /services/:name` participate in `stackOperationLock` and not flip status until apply actually starts.
2. **Give the applications UI a real recovery path.** Add an Apply/Retry action wherever `error`/`pending`/`undeployed` can be seen (detail header and card); route the card's unchanged-tag "Redeploy" through apply when status isn't `synced` instead of letting `/update` 400. Put a tooltip on the disabled Update button saying *why* ("a deployment is in progress / the stack needs to be applied first"), and stop treating a latched `taskExecuting` as authoritative over fresh DB status.
3. **Make "Stop" honest.** Wire `stopStack()` (undeploy-but-keep-definition) to a real endpoint and use it for the application Stop button; rename the current destroy path to "Remove"/"Uninstall" with copy that says data/state is deleted.
4. **Fix or fence the Code view.** Either round-trip every field (`inputs`/`vault`/`nats`/`requires` + per-service addon/pool/binding fields) or refuse to save when the template contains sections the codec can't represent, with an explicit warning.
5. **Relabel "Archive".** It must either genuinely set `isArchived` (the plumbing already exists) or be labeled "Delete template and its stacks" with a blast-radius list (linked stacks) in the confirm dialog.
6. **Add a lock timeout / force-release** for `stackOperationLock` so a hung Docker call can't brick apply/update/destroy until restart.

### P1 — complete the "installed instance you upgrade" model

7. **`POST /api/stacks/:id/upgrade`.** Re-materialize services from `template.currentVersion`, merging parameter/input values — the logic already exists in `builtin-stack-sync.upgradeStackFromTemplate`; extract it from the boot path and expose it for user stacks. Add `templateVersionId` as a real FK while there.
8. **Surface `templateUpdateAvailable`.** "Update available → Upgrade" badge + CTA on the application card, application detail header, and stack rows. This one field is the linchpin of the whole mental model and today literally nobody can see it.
9. **Close the config-edit loop.** The Configuration tab's Save should offer "Save & deploy" (publish + upgrade + apply as one tracked task) — or at minimum banner the app with "Deployed stack is running an older version" after save instead of toasting success and navigating away. Reconcile the two write paths: the card's tag update should ideally go through the template too, so stack and template stop diverging.
10. **Build the Stacks page.** A top-level `/stacks` route + nav entry listing every stack across scopes (host / per-environment / application) with status, installed template version vs latest, drift, and last-applied time; plus a **stack detail page** (`/stacks/:id`) hosting the existing `StackPlanView`, deployment history, and actions — giving every stack a canonical, linkable URL (which also fixes `PrerequisitesBanner`'s guess-the-page links). Fix the `GET /api/stacks` filter asymmetry (scoped queries silently excluding user stacks) at the same time.
11. **Finish the status model.** Either implement `drifted`/`removed` (periodic or post-plan drift marking; soft-delete tombstones) or delete them from the enum. Add tooltips to `StackStatusBadge` explaining each status and its next action, use that one badge everywhere a stack status renders, and roll NATS drift + container drift into a single "needs attention" indicator.

### P2 — polish and coherence

12. **Terminology pass.** Decide the public vocabulary (suggestion: keep "Application" as the friendly skin, but say "This application is installed as a stack" in one place, and translate stack-vocabulary server errors at the boundary). Fix the Applications subtitle ("Manage your application templates"). Rename the environments-list card so template rows and stack rows aren't mixed.
13. **Template version UX.** Version-to-version diff, publish-time "what changed" summary, one-click rollback (re-point `currentVersionId`), and a "used by N stacks" panel on template list + detail.
14. **Authoring completeness.** Graphical (or at least non-destructive code) editing for `inputs`/`requires`; system templates rendered explicitly read-only; metadata editable without a draft; an instantiate dialog (name + parameters + input values) reachable from the template detail page; `any` scope in the create dialog; confirm-on-service-delete.
15. **Feedback niceties.** "Already up to date" result for no-op redeploys; explain why adopted applications have no Update; `pending` cancel/reset action.

---

## Appendix: key files

| Area | Files |
|---|---|
| Stack lifecycle (server) | `server/src/services/stacks/stack-reconciler.ts`, `stack-plan-computer.ts`, `builtin-stack-sync.ts`, `operation-lock.ts`, `server/src/routes/stacks/*` |
| Templates (server) | `server/src/services/stacks/stack-template-service.ts`, `stack-template-schemas.ts`, `server/src/routes/stack-templates.ts` |
| Stacks UI | `client/src/components/stacks/*` (esp. `StackPlanView.tsx`, `StackStatusBadge.tsx`), `client/src/components/environments/stacks-list.tsx`, `client/src/components/host/host-templates-list.tsx` |
| Templates UI | `client/src/app/stack-templates/[templateId]/page.tsx`, `client/src/components/stack-templates/*` (esp. `code-view/yaml-codec.ts`, `template-table.tsx`, `version-sidebar.tsx`) |
| Applications | `client/src/hooks/use-applications.ts`, `client/src/app/applications/page.tsx`, `application-card.tsx`, `[id]/layout.tsx`, `[id]/configuration/page.tsx` |
| Schema | `server/prisma/schema.prisma:1024-1148` (Stack/status), `:1594-1749` (templates) |
