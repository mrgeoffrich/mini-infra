# Addon authoring UI

**Status:** planned, not implemented. Phased rollout — each phase ships as a separate PR. Phases land strictly in order.
**Builds on:** the Service Addons framework and the `tailscale-ssh` / `tailscale-web` / `claude-shell` addons shipped through Phases 1–5 of [service-addons-plan.md](./service-addons-plan.md) (#364, #379, #383, #394, #396). Reuses the lossless-republish pattern (`client/src/lib/application-draft.ts`) established by the Connected Networks card.
**Excludes:** the Service Addons framework's deferred Phase 6 (pool-service integration) — pool addon *authoring* rides with that work, not this plan.

---

## 1. Background

The Service Addons framework and its three addons (`tailscale-ssh`, `tailscale-web`, `claude-shell`) let a stack service opt into a capability by adding an `addons:` block to its definition, which a render pass expands into synthetic sidecars or injected env at apply time. The framework, the addons, endpoint discovery (`GET /api/stacks/:id/addon-endpoints`), and read-only display (the Overview **Connect** card, the violet `AddonBadge` on synthetic rows) all shipped. What never shipped is an **authoring** surface: the only ways to attach an addon today are the raw API or the one hardcoded Claude Shell preset page. There is no generic way for an operator to add `tailscale-ssh` or `tailscale-web` to an ordinary application, and no endpoint that even lists the registered addons for a picker to consume. This plan adds a registry-driven authoring UI — primary surface an "Add-ons" card on the application Overview tab, sitting next to the Connect card that reads out what addons produce — built on the same lossless single-field republish pattern the Connected Networks card already uses.

*Rubric waivers: none.*

## 2. Goals

1. Operators can attach, configure, and remove Service Addons on an application from the UI, without editing JSON or calling the API.
2. The addon picker is driven by the live registry — a newly registered addon appears automatically with its config fields, applicability, and prerequisites, with no client-side change.
3. The UI prevents invalid attachments — an addon whose service type is unsupported, or whose required connected service is unconfigured, is surfaced as unavailable with the reason and a path to fix it.
4. Editing an application's configuration never silently drops its attached addons.
5. Addon authoring generalises from single-service applications to a chosen service on multi-service stacks.

## 3. Non-goals

- **New addon types or capabilities.** This is UI for the existing framework and its three shipped addons only — no new addon behaviour.
- **Live addon status / health.** The Connect card already renders tailnet device status; this plan adds authoring, not a richer status surface.
- **Pool-service addon authoring.** Rides with the framework's deferred Phase 6 pool integration; `claude-shell` also excludes Pool by construction. Attaching addons to `Pool`-type services is out of scope here.
- **Replacing the Claude Shell preset page.** The bespoke `/applications/new/claude-shell` wizard stays — the generic card complements it for arbitrary apps.
- **Changing the addon render / expansion pipeline.** The work is purely additive: one read endpoint plus client surfaces. `expand-addons.ts` and the reconciler are untouched.

## 4. Shared concepts

### 4.1 The addon catalog contract

The registry (`productionAddonRegistry`) holds each addon's manifest, its zod `configSchema`, and its definition. The zod schema cannot cross into `@mini-infra/types` (the lib package is zero-runtime-deps, per `lib/CLAUDE.md`), so the catalog endpoint projects each addon into a serialisable shape the client can render a form from. Two new types in `@mini-infra/types`, referenced by Phases 2, 3, and 4:

```ts
interface AddonConfigFieldDescriptor {
  name: string;                               // config key, e.g. "port"
  label: string;                              // human label for the form
  type: "string" | "number" | "boolean" | "string[]";
  required: boolean;
  placeholder?: string;
  help?: string;
  // Advisory validation hints mirrored from the zod schema (server re-validates authoritatively).
  pattern?: string;
  min?: number;
  max?: number;
}

interface AddonCatalogEntry {
  id: string;                                 // registry id, e.g. "tailscale-ssh"
  description: string;
  kind?: string;                              // merge-group label
  mode: "sidecar" | "env-injection";
  appliesTo: StackServiceType[];              // service types the addon supports
  requiresConnectedService?: string;          // connected-service prerequisite (e.g. "tailscale")
  configFields: AddonConfigFieldDescriptor[]; // drives the per-addon config form
}
```

Each production addon authors its `configFields` alongside its existing zod `configSchema`. The descriptor list is the source of truth for form rendering; the zod schema stays the source of truth for validation.

### 4.2 The lossless-republish pattern

Any surface that mutates a single field on an existing application must rebuild the full draft via `buildDraftFromVersion()` (`client/src/lib/application-draft.ts`) and overlay only the field it edits — otherwise it silently drops everything the form doesn't model (`addons`, `vault`, `nats`, `resourceInputs`, …). The Connected Networks card already follows this; Phases 1 and 3 both depend on it.

### 4.3 The shared "attach add-on" component

A single client component renders the catalog-driven picker, the per-addon config form, and the unavailable/disabled states with reasons. It is built in Phase 3 (mounted from the Overview card) and reused verbatim in Phase 4 (mounted from a Services-tab row). Applicability gating (by `appliesTo` and by connected-service connectivity via the existing `useServiceConnectivity` hook) lives in this component so both surfaces gate identically.

## 5. Phased rollout

Four phases, strictly sequential. Phase 1 is a safety fix that removes a data-loss footgun before the feature makes addons easy to attach; Phase 2 lands the backend catalog; Phase 3 is the primary operator-facing outcome; Phase 4 generalises addon authoring to a chosen service on multi-service stack templates (and carries a sibling data-loss fix in the template editor).

### Phase 1 — Config-tab addon-safety fix

**Goal:** editing an application's configuration never drops its attached addons.

Deliverables:
- The application Configuration tab's save path rebuilds the draft losslessly (via the existing `buildDraftFromVersion` helper) and overlays only the form-edited fields, instead of constructing a fresh single-service array that omits `addons` / `vault` / `nats` / `requires` / `resourceInputs`.
- A regression test (supertest against the draft route, per the server test conventions) that attaches an addon to an application, simulates a Configuration-tab save, and asserts the `addons` block survives on the resulting draft version.

Reversibility: safe — revert the PR and the save returns to its current behaviour.

UI changes:
- none (behaviour-only; the Configuration form is visually unchanged).

Schema changes:
- none.

Done when: saving an application that carries an `addons` block from the Configuration tab preserves that block (and `vault` / `nats`) on the resulting draft version.

Verify in prod: a Claude Shell app still exposes its Tailscale SSH endpoint on the Connect card after an operator edits its configuration.

### Phase 2 — Addon catalog endpoint + manifest metadata

**Goal:** a registry-driven catalog endpoint exposes every registered addon plus enough metadata to render a picker and a per-addon config form.

Deliverables:
- `GET /api/addons` returning, per registered addon, an `AddonCatalogEntry` (§4.1): `id`, `description`, `kind`, `mode`, `appliesTo`, `requiresConnectedService`, and a serialisable `configFields` list.
- `AddonCatalogEntry` and `AddonConfigFieldDescriptor` types in `@mini-infra/types`, plus the `ApiRoute` registry entry and the TanStack query key.
- A `configFields` descriptor authored on each of the three production addons (`tailscale-ssh`, `tailscale-web`, `claude-shell`), covering the keys their zod `configSchema` accepts.
- The endpoint gated by an existing read permission (the `Stacks`/`StacksRead` scope used by the sibling `addon-endpoints` route).

Reversibility: safe — an additive read-only endpoint plus new types; nothing consumes it until Phase 3.

UI changes:
- none.

Schema changes:
- none.

Done when: `GET /api/addons` returns the three registered addons with their `configFields`, `appliesTo`, `requiresConnectedService`, and `mode`, verified by an integration test that also asserts each addon's `configFields` covers its zod schema's keys.

Verify in prod: n/a — internal only (no operator-visible surface until Phase 3).

### Phase 3 — "Add-ons" card on the application Overview tab

**Goal:** operators can attach, configure, and remove addons on an application from the Overview tab.

Deliverables:
- An "Add-ons" card on the application Overview tab that lists the app's currently-attached addons and offers an attach action. Renders whenever the application has a template version — including before its first deploy (unlike the Connect card, which needs an applied snapshot).
- The shared "attach add-on" component (§4.3): a catalog-driven picker that gates each addon by `appliesTo` (against the app's service type) and `requiresConnectedService` (against live connectivity), plus a per-addon config form rendered from `configFields`.
- Attach and remove write the `services[].addons` block through the lossless republish path (§4.2), mirroring the Connected Networks card — no new mutation endpoint.
- Unavailable-state treatment: an addon that doesn't apply, or whose connected service is unconfigured, is shown disabled with the reason and a link to the relevant settings (e.g. Tailscale connectivity).

Reversibility: safe — an additive client surface; revertable as a unit.

UI changes:
- New "Add-ons" card on the application Overview tab showing attached addons with add/remove controls, paired beneath the Connect card. [design needed]
- An attach-add-on dialog: registry-driven picker, per-addon config fields, and disabled/unavailable rows with reasons and a fix link. [design needed]

Schema changes:
- none.

Done when: an operator can attach `tailscale-ssh` (or `tailscale-web` with a port) to an application from the Overview card and the addon persists on the template's service-definition draft.

Verify in prod: an operator attaches an addon via the card and, after deploy, the resulting SSH/HTTPS endpoint appears on that app's Connect card.

### Phase 4 — Per-service addon authoring in the stack-templates editor

**Goal:** addon authoring generalises to any chosen service on a multi-service stack template.

Re-homing note (from implementation-time exploration): applications are single-service, so Phase 3's Overview card already covers them — the applications Services tab (this phase's originally-proposed home) would be redundant. The genuine multi-service authoring surface is the stack-templates **draft editor** (`client/src/app/stack-templates/[templateId]/page.tsx` → `TemplateServicesSection` / `ServiceEditDrawer`), where `handleServicesChange` already round-trips the whole services list. Phase 4 targets that surface.

Deliverables:
- A per-service "Add-ons" affordance in the stack-templates draft editor that mounts the shared attach-add-on component (§4.3) against the selected service, editable only while viewing the draft (`readOnly` respected). Attach/remove writes that service's `addons` and saves via the existing `onServicesChange` → draft-save path.
- A prerequisite lossless-mapping fix: the editor's two service round-trips — `buildDraftInput` (page) and `toServiceDefinition` (`TemplateServicesSection`) — currently drop per-service `addons` (and `poolConfig`/`jobPoolConfig`/`vault*`/`nats*`), so editing or deleting ANY service strips those from every service. Reuse the canonical `mapServiceInfoToDefinition` (`client/src/lib/application-draft.ts`) in both places so every per-service field survives an edit. Confirm the `ServiceEditDrawer`'s save preserves fields it doesn't model.

Reversibility: safe — an additive client surface plus a data-loss fix.

UI changes:
- Each service in the stack-templates draft editor gains an add/remove-addon affordance. [design needed]

Schema changes:
- none.

Done when: an operator can attach an addon to a chosen service on a multi-service stack template from the draft editor, it persists on that service's definition, and editing a sibling service no longer strips it.

Verify in prod: a multi-service stack template shows an addon attached to a chosen (non-first) service, surviving edits to sibling services.

## 6. Risks & open questions

- **Attach writes the draft; apply is separate.** Attaching an addon updates the template draft but requires a re-deploy/apply to materialise. The card must signal the "needs deploy" state clearly — confirm the exact UX at design time against how the Connected Networks card handles pending applies.
- **Descriptor / schema drift.** `configFields` is hand-authored alongside each zod `configSchema` and can drift from it. Phase 2's test asserting coverage of the schema's keys mitigates this; consider whether the check should mirror the `assertPermissionCatalogInSync()` pattern in `lib/types/permissions.ts`.
- **Removal cleanup.** Removing an attached addon from a deployed app relies on the render pipeline dropping the synthetic sidecar / injected env on next apply. Confirm the addon `cleanup()` hooks fire on removal (authkey revocation, tailnet device teardown) rather than orphaning tailnet devices.
- **`claude-shell` presentation.** It is env-injection mode and excludes Pool; the picker's mode/`appliesTo` gating must present it correctly and never offer it on unsupported service types.
- **Two editors for one app.** For apps created via the Claude Shell preset page, decide whether the generic card also surfaces/manages the `claude-shell` addon, or defers to the preset flow, to avoid two competing editors for the same app.

## 7. Phase tracking

Manual checklist — check a box when that phase's PR merges. Phases are strictly sequential.

- [ ] Phase 1: Config-tab addon-safety fix
- [ ] Phase 2: Addon catalog endpoint + manifest metadata
- [ ] Phase 3: Add-ons card on application Overview tab
- [ ] Phase 4: Per-service addon authoring in the stack-templates editor
