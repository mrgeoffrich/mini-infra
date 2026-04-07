---
name: update-tour-manifest
description: |
  Scans the frontend codebase for data-tour attributes and regenerates the UI element manifest used by the agent sidecar's highlight_element tool. Also analyzes pages that lack data-tour attributes and suggests additions so the agent can guide users to specific UI elements on every page. Use this skill when: "update tour manifest", "refresh data-tour", "update ui elements", "add data-tour attributes", "agent can't highlight", "update highlight IDs", "manifest is stale", or after adding new pages or form fields that the agent should be able to point users to.
---

# Update Tour Manifest

Regenerate the UI element manifest and identify pages that need new `data-tour` attributes.

The manifest at `client/src/user-docs/ui-elements/manifest.json` is consumed by the agent sidecar's `highlight_element` MCP tool — it tells the AI assistant which UI elements it can spotlight when guiding users. Gaps in the manifest mean the agent can't visually point to things on those pages.

## Phase 1: Regenerate the manifest

Run the generator script from the project root:

```bash
node scripts/generate-ui-manifest.mjs
```

This script automatically:
- Walks `client/src/` for all `data-tour` attributes
- Maps each to its route by parsing `client/src/lib/routes.tsx` imports and route definitions
- Classifies elements under `client/src/components/` as global
- Extracts the JSX tag name, derives a human-readable label, and records the source file
- Writes the result to `client/src/user-docs/ui-elements/manifest.json`

Review the output (route count, element count) and read the generated manifest to confirm it looks right.

## Phase 2: Identify coverage gaps and suggest additions

This is the most valuable part. Compare the manifest against all page files under `client/src/app/` to find pages with **no or few** `data-tour` attributes.

For each under-covered page:

1. Read the page component to understand its structure
2. Identify key interactive elements that the agent would want to highlight when guiding a user — focus on:
   - **Form inputs** (text fields, selects, toggles) — the agent needs to say "paste your API token here"
   - **Primary action buttons** (Save, Create, Deploy, Validate) — the agent needs to say "click this to save"
   - **Important cards or sections** — the agent needs to direct attention to a specific area
   - **Status indicators** — connection status, health badges
   - **Tables and lists** — main data displays
3. Suggest a `data-tour` ID for each element following the naming convention:
   - Format: `{page-slug}-{element-purpose}` using kebab-case
   - Examples: `cloudflare-api-token-input`, `azure-save-button`, `docker-connection-status`, `tls-container-select`
   - Keep IDs descriptive but concise

### Priority pages for coverage

1. **Connectivity pages** (`/connectivity-docker`, `/connectivity-cloudflare`, `/connectivity-azure`, `/connectivity-github`) — the agent walks users through connecting external services
2. **Settings pages** (`/settings-tls`, `/settings-self-backup`, `/settings-system`) — the agent helps configure features
3. **Core workflow pages** (`/applications/new`, `/environments`, `/certificates`) — the agent guides complex multi-step tasks

### Output format for suggestions

Present suggestions grouped by page:

```
### /connectivity-cloudflare (client/src/app/connectivity/cloudflare/page.tsx)

Currently: 0 data-tour attributes

Suggested additions:
- `cloudflare-api-token-input` → the API token input field (FormField for apiToken)
- `cloudflare-account-id-input` → the Account ID input field (FormField for accountId)
- `cloudflare-validate-button` → the Validate & Save button
```

## Phase 3: Apply the suggested additions

After presenting the suggestions, ask the user which pages to update. Then for each approved page:

1. Add `data-tour="<id>"` attributes to the identified elements
2. Place the attribute on the most specific wrapper that makes sense for highlighting:
   - For form fields: put it on the `FormItem` or the wrapping div, not the raw `<input>` (so the label + input highlight together)
   - For buttons: put it directly on the `<Button>`
   - For cards/sections: put it on the `<Card>` or section wrapper
   - For status indicators: put it on the containing element that shows the full status
3. Re-run the generator script to regenerate the manifest with the new IDs:
   ```bash
   node scripts/generate-ui-manifest.mjs
   ```

## Important notes

- The manifest file is copied into the agent sidecar container at build time (`/app/docs/ui-elements/manifest.json`). After updating, the sidecar image needs to be rebuilt to pick up changes.
- Don't add `data-tour` to elements that are conditionally rendered and may not be in the DOM when the agent tries to highlight them (like content inside closed dialogs or collapsed sections). The spotlight overlay retries for 2 seconds, but if the element requires user interaction to appear, it won't work.
- Dynamic pages with route params (e.g. `/containers/:id`) should use the parameterized route as the key in the manifest.
- Skip infrastructure pages (login, error boundaries, help article viewer) — these don't need agent highlighting.
- If the script picks up false positives (template literals like `data-tour="${variable}"`), add the filename to the `SKIP_PATTERNS` array in `scripts/generate-ui-manifest.mjs`.
