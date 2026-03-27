# Stack Template Management UI

Admin pages for creating, editing, versioning, and publishing stack templates.

## Decisions

- **Audience:** Admin-only, lives under Admin tab in left nav
- **Editing UX:** Form-based with dialogs for complex sub-components (services)
- **Page structure:** List page + detail page (two routes)
- **Versioning UX:** Version-focused detail page — draft editing with version history sidebar

## Routes & Navigation

| Route | Page | navSection | showInNav |
|-------|------|------------|-----------|
| `/stack-templates` | Template list | `administration` | `true` |
| `/stack-templates/:templateId` | Template detail/editor | `administration` | `false` |

- List page gets a sidebar entry with `IconTemplate` or `IconStack2` icon
- Detail page accessed by clicking a row, or via "Create Template" button (`/stack-templates/new` — same component, empty state)
- No new API routes needed — existing `/api/stack-templates` endpoints cover all operations

## List Page

**File:** `client/src/app/stack-templates/page.tsx`

### Layout

- **Header:** icon badge, "Stack Templates" title, description, "Create Template" button
- **Filter bar:** source (system/user/all), scope (host/environment/all), show archived toggle
- **Table:** `<Table>` components with columns:
  - Template (name + description)
  - Source badge (system/user)
  - Scope badge (host/environment)
  - Version (latest published, e.g. "v3")
  - Status: Published | Has Draft | Draft Only | Archived
  - Actions dropdown (Edit, Archive/Unarchive, Delete with confirmation)
- **Row click** navigates to `/stack-templates/:id`
- **Empty state:** centered message with "Create your first template" CTA

### Data Fetching

- `useQuery(['stack-templates', filters])` calling `GET /api/stack-templates` with query params
- No Socket.IO needed — templates don't change in real-time

## Detail Page

**File:** `client/src/app/stack-templates/[templateId]/page.tsx`

### Layout

Two-column: main editor (~75%) + version sidebar (~25%)

### Top Bar

- Back link to `/stack-templates`
- Template name + status badges (published version, draft indicator)
- Action buttons: "Save Draft", "Discard Draft", "Publish Draft"

### Main Editor Sections

All sections edit the draft version.

#### 1. Template Metadata Card

Form fields: display name, description, category, source, scope. Inline-editable.

#### 2. Services Section

Card list showing each service with summary:
- Image, ports, volumes, env vars count
- Color-coded left border by type (Stateful = blue, StatelessWeb = green)
- Service type badge, order number, dependency info
- Edit button opens service edit dialog
- "Add Service" button
- Drag to reorder (using @dnd-kit)

#### 3. Parameters Section

Table with columns: name, type, required, default value. "Add Parameter" button. Edit button per row opens parameter edit dialog.

#### 4. Networks & Volumes

Compact side-by-side grids. Each shows name and driver. Add/edit/delete with inline controls.

### Version History Sidebar

- **Draft entry** — highlighted border, shows modified time and author
- **Published versions** — version number, notes, publish date. Click to view read-only in main area.
- **Archived versions** — collapsed by default
- **"Stacks Using This"** — list of stacks referencing this template with their version

### New Template Flow

`/stack-templates/new` uses the same detail page component:
- Detects no `templateId` param → shows empty form
- Required fields: name, displayName, source, scope
- "Create" button calls `POST /api/stack-templates`, then redirects to `/stack-templates/:newId`

## Service Edit Dialog

The most complex sub-component. A dialog with sections/tabs:

| Section | Fields |
|---------|--------|
| **Basic** | Service name, type (Stateful/StatelessWeb), image, tag, order |
| **Container Config** | Port mappings, environment variables (supports `{{param}}` references), labels, restart policy, command override |
| **Config Files** | File content + target path (mounted into container) |
| **Init Commands** | Ordered list of commands for first deploy |
| **Dependencies** | Multi-select of other services in this template |
| **Routing** (StatelessWeb only) | Domain, port, path prefix, health check path |

Each section uses form fields with Zod validation matching the existing `StackContainerConfig`, `StackConfigFile`, `StackInitCommand`, and `StackServiceRouting` types from `@mini-infra/types`.

## Data Flow & State Management

| Concern | Approach |
|---------|----------|
| List data | `useQuery(['stack-templates', filters])` → `GET /api/stack-templates` |
| Detail data | `useQuery(['stack-templates', templateId])` → `GET /api/stack-templates/:id` |
| Save draft | `useMutation` → `POST /api/stack-templates/:id/draft` |
| Publish | `useMutation` → `POST /api/stack-templates/:id/draft/publish` |
| Create template | `useMutation` → `POST /api/stack-templates` |
| Update metadata | `useMutation` → `PATCH /api/stack-templates/:id` |
| Form state | `react-hook-form` + Zod schemas, explicit "Save Draft" (no auto-save) |
| Version viewing | Click version in sidebar → load read-only view; editing switches back to draft |
| Optimistic updates | Not used — save/publish are explicit with loading states |

## Error Handling & Edge Cases

- **No draft exists:** Show "Create Draft" button. If published version exists, pre-populate draft from it.
- **Template in use:** Warn before archiving/deleting if stacks reference it.
- **Validation:** Zod schemas enforce required fields, valid image formats, unique service names within a template, no circular dependencies in service `dependsOn`.
- **Concurrent edits:** Not a concern — admin-only, single-user flow.

## Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `client/src/app/stack-templates/page.tsx` | List page |
| `client/src/app/stack-templates/[templateId]/page.tsx` | Detail/editor page |
| `client/src/hooks/use-stack-templates.ts` | TanStack Query hooks for template CRUD |
| `client/src/components/stack-templates/template-table.tsx` | Table component for list page |
| `client/src/components/stack-templates/template-metadata-card.tsx` | Metadata form card |
| `client/src/components/stack-templates/template-services-section.tsx` | Services card list |
| `client/src/components/stack-templates/service-edit-dialog.tsx` | Service editor dialog |
| `client/src/components/stack-templates/template-parameters-section.tsx` | Parameters table |
| `client/src/components/stack-templates/template-networks-volumes.tsx` | Networks & volumes grids |
| `client/src/components/stack-templates/version-sidebar.tsx` | Version history sidebar |

### Modified Files

| File | Change |
|------|--------|
| `client/src/lib/route-config.ts` | Add `/stack-templates` and `/stack-templates/:templateId` route configs |
| `client/src/lib/routes.tsx` | Add React Router routes for both pages |
