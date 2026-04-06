---
title: Event Log
description: How to view and manage the system event log in Mini Infra.
tags:
  - monitoring
  - events
  - deployments
  - backup
---

# Event Log

The **Events** page at [/events](/events) tracks long-running system operations such as deployments, backups, certificate renewals, and restore operations. Each event records progress, logs, and the final outcome.

## Events list

The events list shows a summary of each event. Use the **Filters** sidebar on the left to narrow the list.

Pagination controls at the bottom show "Showing X to Y of Z events" and let you navigate between pages.

## Event status values

Events use the same status model as the operations they track:

| Status | Meaning |
|--------|---------|
| `running` | Operation is currently in progress |
| `pending` | Operation is queued |
| `completed` | Operation finished successfully |
| `failed` | Operation encountered an error |

## Event detail page

Click an event to open its detail page at `/events/:id`. The detail page shows:

- **Progress bar** — for running or pending events, shows live progress
- **Error card** — for failed events, shows the error message
- **Metadata card** — timestamps, duration, and event type
- **Logs viewer** — full log output from the operation

### Action buttons

| Button | Description |
|--------|-------------|
| **Refresh** | Reload the event data |
| **Delete** | Permanently delete this event record |

## Deleting events

Click **Delete** on the event detail page or in the events list to delete an event record. A confirmation dialog appears before deletion.

Event records are also automatically deleted after the retention period configured in [Settings → System Settings](/settings-system) (default: 30 days). Cleanup runs daily at 2 AM UTC.

## What to watch out for

- Deleting an event record is **permanent** — the event logs and history are lost.
- Events are created automatically by Mini Infra when operations start. You cannot create events manually.
- If you need to monitor a deployment in real time, use the deployment detail page at `/deployments/:id` — it shows live progress and logs while the event record provides a permanent history after completion.
- The event retention period affects how long historical records are kept. If you need longer retention for audit purposes, increase the retention period in System Settings before old events are deleted.
