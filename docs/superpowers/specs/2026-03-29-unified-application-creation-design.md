# Unified Application Creation UX

## Summary

Merge the application template creation and environment selection into a single screen. Each application becomes a 1:1 pairing of definition + environment. The form uses progressive reveal with smart routing defaults based on service type and environment network type.

## Current State

- Application creation at `/applications/new` has no environment selection
- Deployment to an environment happens via a separate dialog after creation
- Templates and stacks are loosely coupled — one template can deploy to multiple environments

## Design

### Form Structure (Progressive Reveal)

The form at `/applications/new` reveals sections as the user fills in earlier fields.

**Always visible:**
- Display Name (text input)
- Description (optional textarea)
- Service Type (toggle: Stateless Web / Stateful)
- Environment (dropdown of all environments)

**Revealed once type + environment are both selected:**
- Service Name (auto-generated from display name, editable)
- Docker Image + Tag
- Restart Policy (default: `unless-stopped`)
- Port Mappings
- Environment Variables
- Volumes

**Revealed only for Stateless Web (contents depend on environment networkType):**
- Routing section:
  - `local` environment: Hostname (required), TLS toggle (default: on), Listening Port, Health Check Endpoint
  - `internet` environment: Hostname (required), Cloudflare Tunnel toggle (default: on), Listening Port, Health Check Endpoint
  - TLS toggle is hidden for `internet` environments (Cloudflare handles edge TLS)
  - Cloudflare Tunnel toggle is hidden for `local` environments
  - All defaults are overridable by the user

**Always at bottom (once form is revealed):**
- "Deploy immediately" checkbox (default: checked)
- Submit button: label changes between "Create Application" and "Create & Deploy" based on checkbox

### Smart Defaults Logic

**When user changes environment after defaults were applied:**
- Reset routing toggle defaults (TLS/tunnel) to match the new environment's networkType
- Preserve user-edited values (hostname, listening port)

**When user changes service type:**
- Switching to Stateful: hide routing section
- Switching to Stateless: show routing section with defaults for the currently selected environment

### Edit Page (`/applications/:id`)

Same form as creation, but the environment dropdown is **read-only**. Changing environment on a deployed app is a destructive operation outside the scope of an edit.

### Application List Page Changes

- Always show the environment name badge on each card (it's part of the application's identity)
- **Deploy** button: visible when application exists but isn't deployed. Uses the bound environment directly — no environment picker dialog needed.
- **Update** button: same as today (pull latest image, redeploy)
- **Stop** button: same as today (destroy running stack)
- Remove `deploy-application-dialog.tsx` for user applications (environment is already known)

### Import Deployment Changes

When importing a deployment config via `POST /api/stack-templates/import-deployment/:configId`:
- Read the `environmentId` from the deployment config
- Set it on the newly created StackTemplate automatically
- No frontend dialog changes needed — the binding happens automatically

### Data Model Changes

**StackTemplate schema addition:**
```prisma
model StackTemplate {
  // ... existing fields ...
  environmentId    String?
  environment      Environment?  @relation(fields: [environmentId], references: [id])

  @@index([environmentId])
}
```

- Optional because system templates and host-scoped templates don't have an environment
- For user-created applications (source: `user`, scope: `environment`), this is always set
- The `scope` field is set to `environment` automatically when `environmentId` is provided — no longer user-facing for applications

### API Changes

**Create application** (`POST /api/stack-templates`):
- Accept `environmentId` in the request body
- Accept `deployImmediately` boolean in the request body
- Set `scope: 'environment'` automatically when `environmentId` is provided
- If `deployImmediately: true`: after creating + publishing the template, instantiate the stack into the bound environment and apply it

**Update application:**
- `environmentId` is not updatable after creation (enforced server-side)

**Type changes** (`lib/types/stack-templates.ts`):
- Add `environmentId?: string` to `CreateStackTemplateRequest`
- Add `deployImmediately?: boolean` to `CreateStackTemplateRequest`
- Add `environmentId` to response types

### What Is NOT Changing

- Stack templates advanced page (`/stack-templates`) — untouched
- Environment management — no changes
- Stack model — no schema changes
- Deploy/apply/update/destroy orchestration — unchanged
- System templates — unaffected, they don't use `environmentId` on the template
- `networkTypeDefaults` on template versions — still exists but not used by the simplified form (UI applies defaults directly)
