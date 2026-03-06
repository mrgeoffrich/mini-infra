# Plan: HAProxy Instances Page

## Route & Navigation

- **Path**: `/haproxy/instances`
- **Nav**: Add as a `showInNav: true` child of `/haproxy` in `route-config.ts`, alongside Frontends and Backends. Sidebar will show "Instances" under Load Balancer.
- `routes.tsx`: add route + import

---

## Data Sources

| Data | API | Hook |
|---|---|---|
| All environments | `GET /api/environments` | `useEnvironments` (existing) |
| Per-instance HAProxy status | `GET /api/environments/:id/haproxy-status` | `useHAProxyStatus` (existing) |
| Trigger remediation | `POST /api/environments/:id/remediate-haproxy` | `useRemediateHAProxy` (existing) |

Filter environments client-side: only show rows where `environment.services` contains a service with `serviceName === 'haproxy'`.

---

## Table Columns

| Column | Data | Notes |
|---|---|---|
| **Environment** | `environment.name` | Links to `/environments/:id` |
| **Type** | `environment.type` | Badge: production (red) / staging (blue) |
| **Env Status** | `environment.status` | Reuse existing environment status badge |
| **HAProxy Health** | `haproxy-status.needsRemediation` | "Healthy" (green) / "Needs Remediation" (yellow) / "Unavailable" (red) — loaded per-row |
| **Frontends** | `haproxy-status.sharedFrontendsCount` | Numeric, skeleton while loading |
| **Routes** | `haproxy-status.totalRoutesCount` | Numeric, skeleton while loading |
| **Actions** | — | "Remediate" button |

---

## Component Architecture

```
HAProxyInstancesPage
├── page header (icon, title, description, refresh button)
└── Table
    └── HAProxyInstanceRow (one per environment with haproxy service)
        ├── calls useHAProxyStatus(env.id) internally
        ├── renders status cells with inline loading skeletons
        └── "Remediate" button → opens RemediateHAProxyDialog (existing, reused as-is)
```

The per-row sub-component is the key pattern: each row independently fetches and displays its own HAProxy status. This avoids loading all statuses in the parent and keeps the table responsive — rows with fast responses appear immediately while slower ones show skeletons inline.

---

## Empty / Edge States

- **No environments with HAProxy**: empty state with icon + message + link to Environments
- **Environment has HAProxy but status fetch fails**: show "Unavailable" badge in health column, still show Remediate button
- **Environment is stopped**: health column shows "—" (HAProxy not reachable), remediate button disabled

---

## Files to Change

| File | Change |
|---|---|
| `client/src/app/haproxy/instances/page.tsx` | **Create** — new page |
| `client/src/lib/route-config.ts` | Add `instances` to `/haproxy` children |
| `client/src/lib/routes.tsx` | Import + register route |

No new hooks, no new API endpoints, no backend changes needed — everything reuses existing infrastructure.
