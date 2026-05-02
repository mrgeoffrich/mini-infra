# Design: Phase 2 Tailscale settings form (ALT-68)

**Linear:** https://linear.app/altitude-devops/issue/ALT-68/design-phase-2-tailscale-connected-service
**Goal (from ticket):** lay out the new "Tailscale" admin form on the connected-services Settings page — OAuth `client_id` / `client_secret`, default tags, and a click-to-copy ACL bootstrap snippet block.
**Done when (from ticket):** Figma frames signed off and any new design tokens merged into the design system. (Impl ticket ALT-57 unblocks once this lands.)

> **Decision: Option A** (one card, sections in dependency order: tags → ACL snippet → credentials). Picked 2026-05-03. Option B retained below for context.
> Open question still pending designer call: whether the Phase-2 snippet includes the Phase-3 `ssh` stanza.

## Context

Phase 2 of the Service Addons Framework wires Tailscale up as a fifth connected service (alongside Docker / Azure / Cloudflare / GitHub). The connected-services *card* on `/connectivity` is no-design — it slots into the established card pattern. The thing that needs design is the deeper-link **Settings → Tailscale** form, because it has two pieces no other settings form has today:

1. **A default-tag list editor** — a list of `tag:foo` strings the operator pre-applies to every Tailscale device the addons mint. There is no existing tag-input component anywhere in `client/src/components/ui/` or in `client/src/app/settings/**`; whichever option we pick, the multi-value input is new ground.
2. **A click-to-copy ACL bootstrap snippet** — a 20–40-line HuJSON/JSON block the operator pastes into their tailnet's policy file. Today's only inline copy-block (`client/src/components/postgres-server/connection-string-modal.tsx:62-77`) is a one-line connection string in a dialog; the Tailscale snippet is far chunkier and sits inline on a settings page, not in a modal.

Everything else on the form (OAuth `client_id`/`client_secret` with show/hide, "Validate & Save", encrypted-storage indicator, "How to create an OAuth client" help card) maps cleanly onto the existing `client/src/app/connectivity/cloudflare/page.tsx` and `client/src/app/settings/github/page.tsx` shape.

### Critical sequencing (from `docs/vendors/tailscale-auth.md`)

The vendor doc inverts the obvious form ordering. The operator's real-world setup flow is:

1. **Pick a tag name** for Mini-Infra-managed devices (e.g. `tag:mini-infra-managed`).
2. **Paste the ACL snippet** into `https://login.tailscale.com/admin/acls/file` — the snippet declares `tagOwners` and `grants` for that tag, plus an `ssh` stanza for Phase 3. Without this, step 3 fails.
3. **Create an OAuth client** at `https://login.tailscale.com/admin/settings/oauth` with the scopes `auth_keys:write` + `devices:core:write`, and *assign that same tag* to the client. The tag assignment is rejected by Tailscale unless `tagOwners` already exists from step 2.
4. **Paste `client_id` + `client_secret`** into Mini Infra and Validate & Save.

The implication for our form: **the ACL snippet must be visible before the credentials section**, not after. This rules out any layout where the snippet lives below "Validate & Save", because the operator can't successfully validate until they've already copied the snippet to their tailnet ACL. It also means the snippet is a function of `tags` only — *not* of the validated tailnet domain (the policy file uses tag literals throughout; the domain doesn't appear). That collapses one of the open questions from the first design pass.

Two design alternatives below differ along two reinforcing axes:

- **Form shape** — flat, one-card linear scroll (in dependency order: tags → ACL snippet → credentials) vs. a two-step wizard that gates step 2 on the operator confirming "ACL pasted into tailnet" in step 1.
- **Reuse vs. greenfield** — extend the existing single-card settings pattern with one-off additions vs. introduce a new wizard pattern (reusable for future connected services with multi-step setup) plus pull a `CodeSnippetBlock` and `TagListInput` into `components/ui/`.

The plan doc explicitly defers operator-feedback polish ("no copy-to-clipboard affordances, no Test connection button per addon"), so we should resist over-engineering — both options have to ship in Phase 2, not Phase 5.

---

## Option A — One card, sections in dependency order

**Differs from Option B on:** form shape (single scroll, no gating) and reuse posture (extend the cloudflare/github pattern in-place, no new shared abstractions).

### Idea in one paragraph

Mirror the existing Cloudflare/GitHub settings page, but stack the sections in the order the operator must execute them in real life. A single `<Card>` titled "Tailscale OAuth" holds three sections top-to-bottom: **1. Default tags** (chip-list input, with a sensible default of `tag:mini-infra-managed`), **2. ACL bootstrap** (a pre-rendered HuJSON snippet — `tagOwners` + `grants` + `ssh` stanza — that interpolates the tags from section 1, with a copy button in the snippet's header and a one-line link to `https://login.tailscale.com/admin/acls/file`), **3. Credentials** (`client_id`, `client_secret` with show/hide, plus a one-line note "Create the OAuth client at admin/settings/oauth with `auth_keys:write` and `devices:core:write` and assign your tag"). One "Validate & Save" button at the bottom runs the prober and writes both the credentials and the tags. The ACL snippet block updates live as the operator edits tags — no save required to preview it. A second card below (the "Help" card) repeats the existing pattern: numbered steps walking through the four-stage setup (pick tag → paste ACL → create OAuth client → paste credentials here), paralleling the GitHub page's `How to Get a Personal Access Token` section.

### Key abstractions

- **`TailscaleSettingsPage`** — single-route page component, parallel to `CloudflareSettingsPage`. Owns the form, validation, save, and the live-snippet derivation.
- **`TagListInput`** (inline in the page, not extracted) — controlled component that renders existing chips as `<Badge>`s with an X, plus a free-text input. Enter or comma adds a tag, backspace at empty deletes the last. Validates the `tag:foo` shape with zod.
- **Inline ACL-snippet block** — a `<div className="rounded-md bg-muted font-mono p-4">` wrapping `<pre>{snippet}</pre>`, with a small copy button absolutely positioned top-right. Snippet is computed by a pure `buildAclSnippet(tags: string[])` helper.

No new components extracted to `components/ui/`. The chip input and the snippet block live in the page file (or a single sibling file under `client/src/app/settings/tailscale/`) since neither has a second consumer in Phase 2.

### File / component sketch

```
client/src/app/settings/tailscale/page.tsx            (new)        — TailscaleSettingsPage; the whole form
client/src/app/settings/tailscale/tag-list-input.tsx  (new)        — chip-list input, inline tag validation
client/src/app/settings/tailscale/acl-snippet.ts      (new)        — buildAclSnippet(tags) → string
client/src/hooks/use-tailscale-settings.ts            (new)        — TanStack Query hooks: load + save + validate
client/src/app/sidebar/sidebar-data.ts                (changed)    — add Settings → Tailscale entry
lib/types/tailscale.ts                                (new — server-side ticket already lists this) — TailscaleOAuthSettings shape
```

### Implementation outline

1. Stand up `useTailscaleSettings` (load), `useUpdateTailscaleSettings` (save), `useValidateTailscaleConnection` (Validate & Save) — copy the GitHub hook pair line-for-line, swapping the routes for `/api/settings/tailscale` and `/api/connectivity/tailscale`.
2. Build `TailscaleSettingsPage` skeleton from the Cloudflare page: header strip with brand icon, single `<Card>`, `<Form>` + zod schema, "Validate & Save" button.
3. Drop a `TagListInput` field into the form as the **first** field. Default value is `["tag:mini-infra-managed"]`; the chip can be removed but we seed something so the snippet preview is meaningful on initial render.
4. Implement `buildAclSnippet` as a pure function over `tags` that emits the canonical HuJSON template — `tagOwners` keyed by each tag, the catch-all `grants` block, and the Phase-3-ready `ssh` stanza (per `docs/vendors/tailscale-auth.md`). Wire it to `form.watch("tags")` so the snippet block re-renders as tags change.
5. Render the ACL-snippet block beneath the tag input as section 2. Header row inside the block: title "Tailscale ACL bootstrap", a small "Open tailnet ACL editor →" link to `https://login.tailscale.com/admin/acls/file`, and the copy button. Use the `IconCopy` / `IconCheck` toggle from the postgres-server modal verbatim. Cap height with `max-h-96 overflow-auto`.
6. Render the credentials section beneath the snippet. Description text explicitly notes the prerequisite ("paste the snippet above into your tailnet's ACL first; then create an OAuth client with `auth_keys:write` + `devices:core:write` and assign one of the tags above"). Show/hide toggle on `client_secret` mirroring Cloudflare's `apiToken` field.
7. Add the "How to set up Tailscale" help card below — four numbered steps mirroring the vendor doc's flow, links straight to `https://login.tailscale.com/admin/acls/file` and `https://login.tailscale.com/admin/settings/oauth`.
8. Register `data-tour` IDs on each major control (`tailscale-tags-input`, `tailscale-acl-copy-button`, `tailscale-client-id-input`, `tailscale-validate-button`) so the agent's `highlight_element` tool can point at them — same convention `cloudflare/page.tsx` uses.

### Pros

- Slots into the existing settings-form mental model. Operators who configured Cloudflare or GitHub already know what to do.
- Ships in one page file, one hook file, two sibling files. Smallest blast radius of the two options.
- Live snippet preview is cheap because it's a pure function of `tags` — no server round-trip.
- Re-edit case is trivial: every section is always visible and editable; there's no wizard-vs-summary mode toggle.
- Section ordering (tags → ACL → credentials) matches the real-world setup flow, so an operator scrolling top-to-bottom is doing the right things in the right order.

### Cons

- All three sections live on the same screen at once, so credentials, tags, and a 30-line snippet compete for the operator's attention. A first-time user might paste credentials before noticing the snippet they need to copy.
- Single linear card gets long — credentials + tag chips + ~30-line snippet + buttons + help card is a lot of vertical real estate.
- The tag-input and snippet-block components are duplicated work-in-waiting if/when Phase 4 (`tailscale-web` Connect panel) wants the same building blocks.

### Prior art it leans on

- [`client/src/app/connectivity/cloudflare/page.tsx`](client/src/app/connectivity/cloudflare/page.tsx) — single-card "Validate & Save" with show/hide secret. Closest existing analogue; Tailscale's credential half is structurally identical.
- [`client/src/app/settings/github/page.tsx`](client/src/app/settings/github/page.tsx) — the help-card-below-form pattern (numbered steps, external link). Tailscale OAuth-client setup needs the same shape.
- [`client/src/components/postgres-server/connection-string-modal.tsx`](client/src/components/postgres-server/connection-string-modal.tsx) — the only existing copy-to-clipboard implementation in the codebase. Reuse the `IconCopy`/`IconCheck` + 2-second timeout pattern verbatim.

---

## Option B — Two-step setup wizard, with shared `CodeSnippetBlock` + `TagListInput`

**Differs from Option A on:** form shape (gated wizard with a separate "configured" summary view) and reuse posture (extracts two reusable components into `components/ui/` so Phase 4's Connect panel and any future connected-service settings page can lean on them).

### Idea in one paragraph

Treat first-time Tailscale setup as a guided two-step flow that mirrors the vendor doc's prerequisite chain. **Step 1 — Bootstrap your tailnet**: tag chip-list (default `tag:mini-infra-managed`) + the live ACL snippet rendered from those tags + a "Copy snippet" button + a deep-link to `https://login.tailscale.com/admin/acls/file` + an "I've pasted the snippet, continue →" button that gates Step 2. (No server call yet — Step 1 is operator-confirmation-only; the only persistence is the tag list, written when Step 2 succeeds.) **Step 2 — Connect your OAuth client**: instructions to create the OAuth client (with the same tags + scopes), `client_id` + `client_secret` inputs, and a "Validate & finish" button that runs the prober and persists tags + credentials atomically on success. Once configured, the page renders a **summary view** instead of the wizard: three labelled rows (Default tags / ACL snippet / Credentials) each with an inline "Edit" pencil that flips just that section into edit mode. The summary's snippet row is always visible (operators frequently come back to re-copy after editing tags); the credentials row hides the secret behind a `••••••••` mask. A "Re-validate credentials" button in the summary header re-enters the wizard at Step 2 (Step 1 is skipped on re-edit since the ACL is already in place). Both novel building blocks ship as shared `client/src/components/ui/` components: `<CodeSnippetBlock>` (multi-line, syntax class, copy button, optional header row with title + side-link) and `<TagListInput>` (chip-list with validation).

### Key abstractions

- **`TailscaleSettingsPage`** — orchestrator. Picks `WizardView` vs `SummaryView` by reading the `isConfigured` flag from `useTailscaleSettings`.
- **`TailscaleWizardView`** — owns step state (`"credentials" | "bootstrap"`), the discovered-domain stash, and the gated transition.
- **`TailscaleSummaryView`** — owns per-section edit toggles. Renders three `<Card>`-less rows, each switching between read-only and an in-line `<Form>` for that one field group.
- **`CodeSnippetBlock`** (new in `components/ui/`) — props `{ code: string; language?: string; title?: string; maxHeight?: string }`. Owns the copy-button + 2s success state; presentation matches `connection-string-modal`'s look promoted into a multi-line variant.
- **`TagListInput`** (new in `components/ui/`) — controlled `{ value: string[]; onChange; pattern?: RegExp; placeholder?: string }`. Validation lives in the consumer's zod schema; the component itself is presentation only.

### File / component sketch

```
client/src/app/settings/tailscale/page.tsx                (new)     — orchestrator, picks wizard vs summary
client/src/app/settings/tailscale/wizard-view.tsx         (new)     — step-1/step-2 state machine
client/src/app/settings/tailscale/summary-view.tsx        (new)     — read-mostly view + per-section edit
client/src/app/settings/tailscale/acl-snippet.ts          (new)     — buildAclSnippet({ tags, tailnetDomain })
client/src/components/ui/code-snippet-block.tsx           (new)     — shared multi-line copy block
client/src/components/ui/tag-list-input.tsx               (new)     — shared chip-list input
client/src/hooks/use-tailscale-settings.ts                (new)     — load + save + validate hooks
client/src/app/sidebar/sidebar-data.ts                    (changed) — add Settings → Tailscale entry
lib/types/tailscale.ts                                    (new)     — TailscaleOAuthSettings + ValidationResult
```

### Implementation outline

1. Extract `CodeSnippetBlock` from the postgres-server modal's inline copy-block, generalised to multi-line + optional header row (title + right-aligned side-link slot + copy button). Land it first in `components/ui/`; refactor the postgres-server modal to use it (small drive-by — bounded, useful, doesn't bloat the ticket).
2. Build `TagListInput` as a presentation-only component: chip rows + free-text input + Enter/comma to add, backspace-on-empty to delete. Pattern-match prop validates the `tag:foo` shape if supplied.
3. Stand up `useTailscaleSettings` / `useUpdateTailscaleSettings` / `useValidateTailscaleConnection`. The validate hook posts credentials *and* tags together so the server can persist atomically on success; no partial-state on the client.
4. Implement `WizardView` with step state in `useState`. **Step 1**: tags + ACL snippet preview + "I've pasted the snippet, continue →" button (purely client-side advance; no save yet). **Step 2**: OAuth-client instructions + credential inputs + "Validate & finish" — calls the validate hook with the step-1 tags and the step-2 credentials; on success the page flips to summary view.
5. Implement `SummaryView`: three rows (Default tags / ACL snippet / Credentials). Tags row uses `TagListInput` with a save-on-blur pattern (debounced PUT). ACL snippet row uses `CodeSnippetBlock`, always-visible, regenerates from the persisted tag list. Credentials row is read-only with a masked secret and a "Re-validate credentials" button that re-enters the wizard *at Step 2* (Step 1 is skipped because the ACL is presumed already in place — the snippet row in the summary is the operator's path back to it if they need to re-paste).
6. `TailscaleSettingsPage` reads `isConfigured` from the load hook to pick which view to render. First-load flicker is hidden behind a `<Skeleton>` (same pattern as the Cloudflare page).
7. Wire `data-tour` IDs on the wizard's primary controls (`tailscale-wizard-tags`, `tailscale-wizard-acl-copy`, `tailscale-wizard-continue`, `tailscale-wizard-validate`) and on the summary's edit/re-validate buttons so the agent can highlight either path.

### Pros

- Sequencing matches the vendor doc's prerequisite chain exactly. The wizard *enforces* "paste the ACL before you create the OAuth client" instead of leaving it to the operator to read the help card and infer.
- The post-setup summary view is the right state for the page 99% of the time it's visited — small, scannable, no "is this saved?" ambiguity.
- The two new shared components (`CodeSnippetBlock`, `TagListInput`) are obvious wins for Phase 4's Connect panel (`tailscale-web` URLs are exactly the same shape — short string + click-to-copy) and for any future connected-service settings page.
- Step 2's "Validate & finish" is the only place credentials touch the server, and it always validates before persisting. No half-saved state.

### Cons

- More moving parts. Wizard state machine + summary view + two shared components is several times the LoC of Option A.
- The per-section edit pattern in `SummaryView` is a small UX innovation — it doesn't exist elsewhere in `settings/*` and adds a state machine of its own (which row is editing? cancel discards? auto-save on blur?).
- Step 1's "I've pasted the snippet, continue" is operator-honour-system — there's no real way for us to verify the ACL is in place before Step 2. The Step-2 validate call will fail informatively (Tailscale rejects OAuth clients with un-`tagOwner`-ed tags), so the wizard's gating is more *guidance* than *enforcement*. Worth being honest in the design that the wizard is largely a UX scaffold over a flow Option A covers with a single Validate button.
- Heavier than the plan doc's posture ("no copy-to-clipboard affordances" was scoped *out* of v1 polish — extracting reusable components leans the other way).

### Prior art it leans on

- [`client/src/components/postgres-server/quick-setup-wizard.tsx`](client/src/components/postgres-server/quick-setup-wizard.tsx) — the only existing wizard pattern in the codebase. Borrow its step-state shape and "Back" / "Next" affordances; do not borrow its dialog shell (Tailscale settings is page-level, not modal).
- [`client/src/components/postgres-server/connection-string-modal.tsx:62-77`](client/src/components/postgres-server/connection-string-modal.tsx) — the inline copy-block to generalise into `CodeSnippetBlock`.
- [`client/src/app/connectivity/cloudflare/page.tsx`](client/src/app/connectivity/cloudflare/page.tsx) — the validate-first-then-save flow at lines 135-209. Wizard step 1 is structurally the same, just split out into its own subview.
- [`client/src/app/settings/github/page.tsx`](client/src/app/settings/github/page.tsx) — `isConfigured` branching pattern (lines 185, 205-217); summary-view-vs-wizard reuses the same flag, just on a coarser view boundary.

---

## Recommendation

**Lean Option A.** The vendor-doc reading clarified that the ACL snippet is purely tag-driven — it doesn't need a validated tailnet domain — which removes the strongest reason Option B existed in the first design pass (a wizard that gates the snippet on validation). With sections sequenced top-to-bottom in dependency order (tags → ACL snippet → credentials) and a help card reinforcing the four-step setup flow, Option A walks the operator through the same sequence Option B's wizard does, in roughly half the code, without the wizard/summary state-machine duality. The "Step 1 confirmation" in Option B is also more honour-system than enforcement (we can't verify the operator actually pasted the snippet before they hit "continue"), so the safety win is smaller than it first looks.

The plan doc's scope-out of "copy-to-clipboard affordances" as v1 polish is also a tell: the team's posture is "ship the simplest thing that does the job, then iterate." Option A is the simplest thing.

That said, **flip to Option B if** the team is committed to building the Phase 4 Connect panel close behind Phase 2 and wants the `CodeSnippetBlock` extraction as a deliberate down-payment on it — Phase 4's per-endpoint URL rows are the same copy-block shape, and doing the extraction once is cheaper than doing it twice.

## Open questions

- **Will Phase 4's Connect panel reuse a tag input?** The Connect panel is read-only per the plan doc — it lists URLs and ssh actions, not editable tags. So `TagListInput` may have only one consumer through Phase 5. `CodeSnippetBlock` is the more credible reuse target (Phase 4's `https://<host>.<tailnet>.ts.net` row is exactly a copy-block).
- **Does the operator-confirmation pattern in Option B's Step 1 read as scaffolding or as helpful guidance?** A user-test with someone who has *not* configured Tailscale before would settle this faster than further design discussion.
- **Should the ACL snippet's `ssh` stanza ship in Phase 2 or Phase 3?** The vendor doc shows a Phase-3-relevant `ssh` block (`autogroup:member` → `tag:mini-infra-managed`, users `["root", "ubuntu"]`). Including it in Phase 2's snippet means operators paste the SSH ACL once, before Phase 3's `tailscale-ssh` addon ships, and don't have to revisit the policy file later. Excluding it keeps Phase 2's snippet minimal but creates a "go re-paste this larger snippet" task in Phase 3. Recommendation: include it — the snippet is a forward-compatible bootstrap, not a per-phase delta.

(Resolved by `docs/vendors/tailscale-auth.md`, no longer open: the prober does *not* need to return the tailnet domain for the snippet to render; the snippet is purely tag-templated.)

## Out of scope

- **Test-tailscale-connection button separate from "Validate & Save".** Both ALT-57's deliverables and the plan doc deliberately defer "Test connection" affordances to post-v1 polish; we should match Cloudflare's "Validate & Save in one button" choice.
- **Auto-applying the ACL.** Plan doc §3 explicitly defers calling the Tailscale ACL API. Snippet stays copy-paste only.
- **Multi-tailnet support.** Plan doc §3 again — v1 is one tailnet per Mini Infra. The form shape doesn't need to plan for a tailnet picker.
- **Per-environment default tags.** Phase 3 hard-codes `tag:env-<env>` into the addon's tag list separately from the "default tags" the operator types here. The settings form's tags are the *prefix* tags; per-stack/per-env tags are addon territory.
- **"Sign in with Tailscale" / browser OAuth flow.** The vendor doc confirms Tailscale doesn't offer end-user OAuth login for self-hosted apps; client-credentials paste is the supported pattern. No "Connect with Tailscale" button to design.
- **Auth-key-based setup as an alternative to OAuth.** The vendor doc lists user-pasted auth keys as a viable Option-1, but the plan doc commits to OAuth for production (longer-lived, mints keys on demand). The form should not surface an auth-key path.
- **A "Disconnect Tailscale" button.** The vendor doc recommends one; deletion of credentials is already covered by the connected-services delete flow on `/connectivity` and doesn't need a duplicate affordance on the settings page.
