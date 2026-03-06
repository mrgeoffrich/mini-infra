# Plan: HAProxy Access Logs Viewer

## Overview

Add an access logs viewer page under the Load Balancer section (`/haproxy/access-logs`) that lets you stream and inspect live HTTP access logs from any HAProxy instance running across environments.

HAProxy is already configured to emit structured HTTP access logs to stdout (`log stdout local0`, `option httplog` in `haproxy.cfg`). Docker captures these via the `json-file` logging driver. This feature surfaces those logs in the UI with filtering, parsing, and live streaming.

---

## Architecture

```
Docker json-file log store
    |
    v
GET /api/haproxy/:environmentId/access-logs/stream   (SSE)
    |  - looks up environment -> finds ${env.name}-haproxy container
    |  - streams container logs via Dockerode (same pattern as /containers/:id/logs/stream)
    |  - parses HAProxy httplog format line-by-line
    |  - emits parsed log entries as SSE events
    v
Frontend: /haproxy/access-logs
    - environment selector
    - live streaming log table (parsed, structured)
    - raw log toggle
    - filter controls
```

### HAProxy Log Format

With `option httplog`, each access log line looks like:

```
Feb 28 12:34:56 haproxy[1]: 192.168.1.100:54321 [28/Feb/2026:12:34:56.123] http-in~ env-prod-backend/server1 0/0/1/45/46 200 1847 - - ---- 3/3/0/0/0 0/0 "GET /api/health HTTP/1.1"
```

Parsed fields:
| Field | Example | Description |
|---|---|---|
| `timestamp` | `28/Feb/2026:12:34:56.123` | Request accept time |
| `clientIp` | `192.168.1.100` | Client IP address |
| `clientPort` | `54321` | Client source port |
| `frontend` | `http-in~` | Frontend name (~ = SSL) |
| `backend` | `env-prod-backend` | Backend name |
| `server` | `server1` | Upstream server |
| `timings` | `0/0/1/45/46` | Tq/Tw/Tc/Tr/Ta ms |
| `statusCode` | `200` | HTTP status code |
| `bytesRead` | `1847` | Response bytes |
| `terminationState` | `----` | HAProxy termination flags |
| `method` | `GET` | HTTP method |
| `path` | `/api/health` | Request path |
| `httpVersion` | `HTTP/1.1` | Protocol version |

---

## Implementation Plan

### Phase 1: Backend — Log Streaming API

**New route file:** `server/src/routes/haproxy-access-logs.ts`

#### Endpoints

```
GET /api/haproxy/:environmentId/access-logs/stream
```

- **Auth:** `requirePermission('haproxy:read')`
- **Response:** `text/event-stream` (SSE)
- **Query params:**
  - `tail` (number, default 200) — how many historical lines to send on connect
  - `follow` (boolean, default true) — whether to stream new lines after history
  - `since` (ISO timestamp, optional) — only return logs since this time

**Implementation steps:**
1. Look up the environment by `environmentId` in the database (using Prisma)
2. Find the running HAProxy container for that environment — name pattern is `${environment.name}-haproxy` (same logic as `findHAProxyContainer` in `HAProxyService`)
3. Stream container logs via Dockerode using the same multiplexed-stream approach as `captureContainerLogs` in `container-monitor.ts` and the SSE streaming in `containers.ts:855`
4. Parse each stdout line through a `parseHAProxyLogLine(line: string)` function
5. Emit SSE events in two formats:
   - `event: log` with `data: { parsed: ParsedLogEntry, raw: string }`
   - `event: error` for parse failures or container not found
   - `event: connected` on initial connection with container metadata

**Log line parser:** `server/src/services/haproxy/haproxy-log-parser.ts`

```typescript
export interface ParsedLogEntry {
  timestamp: string;          // ISO 8601
  clientIp: string;
  clientPort: number;
  frontend: string;
  backend: string;
  server: string;
  timings: {
    tq: number;               // Time to get full request headers (ms)
    tw: number;               // Time in queue (ms)
    tc: number;               // Connect to server (ms)
    tr: number;               // Server response time (ms)
    ta: number;               // Total active time (ms)
  };
  statusCode: number;
  bytesRead: number;
  terminationState: string;   // e.g. "----", "cD", "sH"
  method: string;
  path: string;
  httpVersion: string;
  raw: string;                // Original unparsed line
}
```

The parser uses a regex against the standard HAProxy httplog format. Lines that don't match (e.g., startup messages, DataPlane API logs) are emitted as `{ raw, parsed: null }` so the UI can choose to show or hide them.

**Register route:** Add to `server/src/app.ts` (or wherever routes are registered) under the haproxy routes group.

---

### Phase 2: Shared Types

**Add to `lib/types/`** (new file `haproxy-logs.ts` or extend existing haproxy types):

```typescript
export interface HAProxyLogEntry {
  id: string;                 // client-side uuid for React key
  timestamp: string;          // ISO 8601
  clientIp: string;
  clientPort: number;
  frontend: string;
  backend: string;
  server: string;
  timings: { tq: number; tw: number; tc: number; tr: number; ta: number };
  statusCode: number;
  bytesRead: number;
  terminationState: string;
  method: string;
  path: string;
  httpVersion: string;
  raw: string;
  parseError?: boolean;       // true if line could not be parsed
}

export interface HAProxyLogStreamEvent {
  type: 'connected' | 'log' | 'error';
  data: HAProxyLogEntry | { message: string; containerId?: string };
}
```

---

### Phase 3: Frontend Hook

**New file:** `client/src/hooks/use-haproxy-access-logs.ts`

```typescript
useHAProxyAccessLogs(environmentId: string | null, options: {
  tail?: number;
  follow?: boolean;
  maxEntries?: number;     // cap in-memory entries (default 500) to avoid unbounded growth
  enabled?: boolean;
})
```

- Uses `EventSource` (SSE) to connect to the streaming endpoint
- Buffers parsed log entries in state, capped at `maxEntries`
- Exposes: `{ entries, isConnected, isLoading, error, clear, pause, resume }`
- Reconnects automatically on disconnect (with exponential backoff, max 30s)
- Pausing stops processing new entries without closing the SSE connection

---

### Phase 4: Frontend Page

**Route:** `GET /haproxy/access-logs`

**File:** `client/src/app/haproxy/access-logs/page.tsx`

#### Layout

```
[ Header: "Access Logs" icon + title + description ]

[ Environment Selector dropdown ]   [ Status: Connected / Disconnected badge ]
                                    [ Pause / Resume button ]  [ Clear button ]

[ Filter Bar ]
  - Status code filter: All / 2xx / 3xx / 4xx / 5xx
  - Method filter: All / GET / POST / PUT / DELETE / etc.
  - Text search: filters path or client IP (client-side, against buffered entries)
  - Show unparsed lines toggle (off by default)

[ Log Table ]  OR  [ Raw Log View ]   [ toggle switch ]

--- Parsed Table View ---
Columns:
  Time      | Client IP  | Method | Path          | Status | Duration | Bytes | Backend
  12:34:56  | 10.0.0.1   | GET    | /api/health   | 200    | 46ms     | 1.8KB | prod-backend

- Status code colored: green (2xx), yellow (3xx), orange (4xx), red (5xx)
- Duration colored: green (<100ms), yellow (100-500ms), red (>500ms)
- Table virtualised with react-window (already a dependency) for performance
- Clicking a row opens a detail drawer/sheet with all fields including raw line
- Auto-scrolls to bottom when follow mode is active; pauses scroll if user scrolls up

--- Raw Log View ---
- Monospace font, dark terminal-style card
- Colourised by status code (ANSI-style CSS classes)
- Same auto-scroll behaviour
```

#### Empty / Error States

- **No environment selected:** Prompt to select an environment
- **HAProxy not running in environment:** Show warning with link to environment page
- **SSE connection error:** Show error banner with reconnect button
- **No logs yet:** "Waiting for traffic..." with a subtle animated pulse

---

### Phase 5: Route Registration

**`client/src/lib/route-config.ts`** — add under the `/haproxy` children:

```typescript
"access-logs": {
  path: "/haproxy/access-logs",
  title: "Access Logs",
  showInNav: true,
  helpDoc: "deployments/haproxy-access-logs",
},
```

**`client/src/lib/routes.tsx`** — add the route:

```tsx
<Route path="/haproxy/access-logs" element={<AccessLogsPage />} />
```

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Streaming mechanism | SSE (Server-Sent Events) | Already used for container log streaming; simpler than WebSockets for one-way push |
| Log source | Docker container stdout | HAProxy already logs to stdout; no syslog daemon needed |
| Parsing location | Server-side (in SSE route) | Keeps client simple; avoids sending large raw strings when only parsed fields are needed |
| Table virtualisation | react-window | Already a dependency; needed to handle high-volume log streams without DOM bloat |
| Max buffered entries | 500 (configurable) | Balance between useful history and memory usage in the browser |
| Multiple environments | Single environment selector | Each environment has its own HAProxy container; user selects which one to inspect |
| Unparsed lines | Hidden by default, togglable | DataPlane API startup messages and non-HTTP logs pollute the view |

---

## File Changes Summary

### New Files
- `server/src/routes/haproxy-access-logs.ts` — SSE endpoint
- `server/src/services/haproxy/haproxy-log-parser.ts` — httplog format parser + types
- `client/src/app/haproxy/access-logs/page.tsx` — access logs page component
- `client/src/hooks/use-haproxy-access-logs.ts` — SSE hook

### Modified Files
- `server/src/app.ts` — register new route
- `lib/types/` — add `HAProxyLogEntry` and `HAProxyLogStreamEvent` types
- `client/src/lib/route-config.ts` — add `access-logs` child under `/haproxy`
- `client/src/lib/routes.tsx` — add page route
- `API-ROUTES.md` — document new endpoint

### Future / Optional
- `client/src/user-docs/deployments/haproxy-access-logs.md` — help article

---

## Key Implementation Notes

### Finding the HAProxy container for an environment

The HAProxy container naming convention is `${environment.name}-haproxy` (set in `HAProxyService` constructor: `this.mainContainerName = \`${this.projectName}-haproxy\``). The project name is set to `environment.name` when the service is created for an environment (see `environment-manager.ts:1108`).

So given an `environmentId`:
1. Fetch environment from DB to get `environment.name`
2. Call `docker.listContainers()` and find the one whose name includes `${environment.name}-haproxy`
3. Stream its logs via `container.logs({ follow: true, stdout: true, stderr: false, tail, timestamps: true })`

Note: HAProxy logs go to stdout (configured via `log stdout local0`), so `stderr: false` is correct. The DataPlane API may log to stderr — filtering to stdout only gives cleaner access logs.

### SSE Multiplexed Stream Parsing

Docker log streams are multiplexed with an 8-byte header (same as in `container-monitor.ts:107`). The SSE route must demux the stream before parsing individual lines, extracting only stream type 1 (stdout).

### Handling HAProxy Timestamp Format

HAProxy log timestamps use the format `DD/Mon/YYYY:HH:MM:SS.mmm`. The parser should convert this to ISO 8601 for consistency with the rest of the app.

### Parser Robustness

HAProxy emits non-access-log lines (startup, reload notices, DataPlane API). The parser should handle these gracefully:
- Return `{ raw, parsed: null, parseError: true }` for unrecognised lines
- The UI shows these as a dimmed "raw" row when the "Show unparsed" toggle is on
