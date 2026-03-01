# Help Page UI Design Options

## The Problem

Help article pages have **three simultaneous navigation columns**: the main app sidebar (256px), the help doc sidebar (208px), and the TOC sidebar (192px). This leaves as little as ~560px for content at the `lg` breakpoint — cramped compared to every other page in the app, which uses a single sidebar.

Additionally, there's no way to get to relevant help from the page you're actually on.

---

## Option A: Expand Help Into the Main Sidebar

**Concept**: When navigating to `/help/*` routes, the main sidebar transforms to show help navigation instead of the app navigation. The separate HelpDocSidebar is removed entirely.

### Layout

```
┌──────────────────────────────────────────────────────┐
│  [≡]  Documentation > Backup Overview           [?]  │  ← Site header (unchanged)
├────────────┬─────────────────────────────┬───────────┤
│            │                             │           │
│  GETTING   │  Backup Overview            │  On this  │
│  STARTED   │                             │  page     │
│  · Overview│  How the backup system      │           │
│  · Manage  │  works end-to-end...        │  · How it │
│            │                             │    works  │
│  BACKUPS   │  ## How It Works            │  · Config │
│  ·Overview │  PostgreSQL backups run     │  · Azure  │
│  · Config  │  on a cron schedule...      │           │
│  · Restore │                             │           │
│  · Trouble │                             │           │
│            │                             │           │
│  DEPLOYS   │                             │           │
│  · Overview│                             │           │
│  ...       │                             │           │
│            │                             │           │
│ ← Back to  │                             │           │
│   app      │                             │           │
└────────────┴─────────────────────────────┴───────────┘
  Main sidebar         Content area            TOC
  (256px, reused)      (full flex-1)          (192px)
```

### What Changes

- **Main sidebar content swaps** when route is `/help/*` — show doc categories and articles instead of app navigation sections.
- **"Back to app" link** at the bottom of the sidebar returns to normal navigation.
- **HelpDocSidebar component removed** — its job is absorbed by the main sidebar.
- **TOC sidebar stays** on the right (hidden below `xl` as today).
- Content area gains ~208px of width.

### Trade-offs

| Pro | Con |
|-----|-----|
| Familiar sidebar pattern, no layout shift | Sidebar content swap can feel disorienting |
| Content gets full available width | Need to manage sidebar state when entering/leaving help |
| Reuses existing sidebar infrastructure | Main sidebar loses app navigation context while in help |
| Mobile behavior stays the same (offcanvas) | More complex routing logic in AppSidebar |

### Implementation Sketch

- `AppSidebar` checks if current route starts with `/help`.
- If yes, render help navigation tree (categories + articles) instead of the standard nav sections.
- Add a "Back to Dashboard" or "Back to App" footer link.
- Remove `HelpDocSidebar` from the help article page.
- Help article page becomes a two-column layout (content + TOC) like a normal page.

---

## Option B: Full-Width Help With Auto-Collapsed Sidebar

**Concept**: When entering `/help/*`, the main sidebar auto-collapses to icon-only mode (or fully hides). Help gets the full viewport. The help doc sidebar becomes the primary navigation.

### Layout

```
┌──────────────────────────────────────────────────────────┐
│  [≡]  Documentation > Backup Overview               [?] │
├───┬────────────┬─────────────────────────────┬───────────┤
│   │            │                             │           │
│ ☐ │  GETTING   │  Backup Overview            │  On this  │
│ ☐ │  STARTED   │                             │  page     │
│ ☐ │  · Overview│  How the backup system      │           │
│ ☐ │  · Manage  │  works end-to-end...        │  · How it │
│ ☐ │            │                             │    works  │
│ ☐ │  BACKUPS   │  ## How It Works            │  · Config │
│ ☐ │  ·Overview │  PostgreSQL backups run     │  · Azure  │
│   │  · Config  │  on a cron schedule...      │           │
│   │  · Restore │                             │           │
│   │  · Trouble │                             │           │
│   │            │                             │           │
│   │  DEPLOYS   │                             │           │
│   │  · Overview│                             │           │
│   │  ...       │                             │           │
│   │            │                             │           │
└───┴────────────┴─────────────────────────────┴───────────┘
 Icons  Help nav        Content area              TOC
 (48px) (208px)         (full flex-1)            (192px)
```

### What Changes

- **Main sidebar collapses** to icon mode (48px) when entering help routes, expands back when leaving.
- **HelpDocSidebar stays** as its own component, becomes the primary doc navigation.
- **Content area gains ~208px** from the collapsed main sidebar.
- App navigation remains accessible via the icon sidebar — user can still click an icon to go to containers, etc.
- Sidebar collapse state is restored when leaving help.

### Trade-offs

| Pro | Con |
|-----|-----|
| Help feels like a dedicated documentation experience | Auto-collapsing sidebar is a behaviour change users didn't trigger |
| App navigation still accessible via icons | Two different sidebar components side by side (icon + help nav) |
| Clean separation: app sidebar is for app, help sidebar is for docs | Requires the main sidebar to support `collapsible: "icon"` mode (currently set to `offcanvas`) |
| Maximum content width for reading | Sidebar state management across route changes |

### Implementation Sketch

- Change `AppSidebar` collapsible type from `"offcanvas"` to `"icon"` (or make it route-dependent).
- Use a layout effect on `/help/*` routes to programmatically toggle `sidebar.setOpen(false)` or use a minimal icon-rail mode.
- Store the pre-help sidebar state to restore it on exit.
- HelpDocSidebar remains as-is with minor width adjustments.

---

## Option C: Help as a Slide-Over Panel

**Concept**: Help doesn't navigate away from the current page. Instead, it opens as a drawer/panel from the right side, with the help content layered over the current view. Contextual links open the panel to the relevant article.

### Layout (panel open)

```
┌──────────────────────────────────────────────────────────┐
│  [≡]  Containers                                    [?] │
├────────────┬─────────────────────┬───────────────────────┤
│            │                     │ ╔═════════════════╗   │
│  APPS      │  Container List     │ ║  Help          ×║   │
│  · Contain │  ┌────┬────┬────┐  │ ║                 ║   │
│  · Deploy  │  │name│stat│... │  │ ║  BACKUPS        ║   │
│            │  ├────┼────┼────┤  │ ║  ─────────      ║   │
│  DATABASES │  │web │ ▲  │    │  │ ║  · Overview     ║   │
│  · Postgre │  │api │ ▲  │    │  │ ║  ·[Config]      ║   │
│            │  │db  │ ▲  │    │  │ ║  · Restore      ║   │
│  NETWORK   │  └────┴────┴────┘  │ ║                 ║   │
│  · Tunnels │                     │ ║  How backups    ║   │
│  · Deploy  │                     │ ║  work...        ║   │
│            │                     │ ║                 ║   │
│  HELP      │                     │ ║                 ║   │
│  · Docs    │                     │ ╚═════════════════╝   │
└────────────┴─────────────────────┴───────────────────────┘
  Main sidebar      Current page         Help drawer
  (unchanged)       (dimmed/pushed)       (~480px)
```

### What Changes

- **Help opens as a Sheet/Drawer** from the right edge, overlaying the current page.
- **Current page stays visible** (dimmed or pushed left depending on variant).
- **Contextual links** on each page open the drawer to the relevant article.
- **Full help page** (`/help`) still exists as a dedicated route for browsing all docs.
- The drawer contains a simplified layout: category nav at top, article content below, no TOC.

### Trade-offs

| Pro | Con |
|-----|-----|
| User never loses context of what they're working on | Narrow reading width (~480px) limits content layout |
| Contextual help links feel natural and instant | No room for TOC sidebar — need a different heading navigation approach |
| No layout changes to the main app at all | Tables and code blocks may be cramped |
| Works well for quick reference lookups | Full documentation browsing is better on a dedicated page |
| Uses existing Sheet/Drawer from shadcn/ui | Two ways to access help (drawer + full page) adds complexity |

### Implementation Sketch

- Create a `HelpDrawer` component using shadcn's Sheet (already in the project).
- Global help context/store holds `{ isOpen, currentArticle }`.
- Clicking a contextual `[?]` button on any page opens the drawer to that article.
- Clicking "Help > Documentation" in the main sidebar navigates to the full `/help` route as today.
- Drawer has its own category navigation (compact, horizontal tabs or dropdown).

---

## Contextual Help Links (Applies to All Options)

Regardless of which layout option is chosen, every feature page should link to its relevant help article. Two complementary approaches:

### 1. Header Help Button

Add a `[?]` icon button to `SiteHeader` that links to the help article for the current page.

```
┌───────────────────────────────────────────────────────┐
│  [≡]  PostgreSQL Backups                    [?] [👤]  │
└───────────────────────────────────────────────────────┘
                                               ↑
                                    Links to /help/postgres-backups/backup-overview
```

**Implementation**: Each route in `route-config.ts` gets an optional `helpDoc` property:

```typescript
{
  title: "PostgreSQL",
  path: "/postgres",
  icon: IconDatabase,
  helpDoc: "postgres-backups/backup-overview",  // ← new property
}
```

The `SiteHeader` reads the current route config and renders the `[?]` button if `helpDoc` is defined. For Option C, this button opens the drawer. For Options A/B, it navigates to the help page.

### 2. Inline Help Links

For specific UI sections that map to a sub-topic (e.g., the backup schedule config area), add small help links next to section headings:

```
Backup Schedule                          [?]
┌─────────────────────────────────────────┐
│  Cron expression: 0 2 * * *            │
│  Retention: 30 days                     │
└─────────────────────────────────────────┘
```

These would be a reusable `<HelpLink doc="postgres-backups/configuring-backups" />` component.

---

## Recommendation

**Option A** is the strongest starting point.

- It solves the width problem completely by removing the redundant sidebar.
- It's the least amount of new UI behaviour to introduce — users already understand sidebars that show different content.
- The main sidebar infrastructure (scrollable, collapsible, grouped sections) already supports the help navigation structure perfectly.
- It keeps help as a normal page route, which means deep linking, browser back/forward, and bookmarking all work.
- The contextual `[?]` header button works cleanly with it — just a navigation link.

**Option C (drawer)** is worth adding later as a complement to Option A — quick-reference help from any page without navigating away. But it's more complex and works best after the content is written and we know which articles are "quick lookup" vs "deep read."

**Option B** is workable but the auto-collapse behaviour feels like it's fighting the user's sidebar preference rather than working with it.
