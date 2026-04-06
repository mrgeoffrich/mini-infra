---
title: Searching Container Logs
description: How to search, filter, and stream centralized container logs in Mini Infra.
tags:
  - monitoring
  - logs
  - docker
  - loki
---

# Searching Container Logs

The **Container Logs** page provides a centralized, searchable view of logs from all Docker containers on the host. Logs are collected by the monitoring stack and stored in Loki, giving you a unified terminal-style interface for browsing, filtering, and streaming output.

## Prerequisites

The monitoring stack must be running for logs to appear. If it is not deployed, the page displays a message directing you to the **Host** page to deploy it. See [Host Infrastructure Stacks](/help/applications/host-stacks) for details.

## Navigating to logs

Go to **Container Logs** in the sidebar under **Monitoring**. The page shows a control toolbar at the top and a log stream below with a dark terminal-style background.

## Filtering logs

### Service filter

Use the **service dropdown** (defaults to "All Services") to show logs from a single container or all containers. The list is populated from the `compose_service` labels attached to each log entry.

### Time range

Select a preset time window: **5m**, **15m**, **1h**, **6h**, or **24h**. The default is **5 minutes**. Only logs within the selected window are displayed.

### Text search

Type a search term in the **search box** to filter log lines using a case-insensitive regex pattern. Results update after a short delay (500ms debounce). Matched terms are highlighted in yellow in the log output. Click the **X** button to clear the search.

### Sort direction

Toggle between **Newest first** (default) and **Oldest first** using the direction button.

### Results limit

Use the **limit dropdown** to control how many log lines are returned: **500**, **1,000** (default), or **5,000**.

## Reading log entries

Each log line shows:

- **Timestamp** — formatted as `HH:MM:SS.mmm`
- **Container name** — shown in cyan, derived from the service or container label
- **Log text** — the full log line

### Log level indicators

A colored left border indicates the detected log level:

| Border color | Detected level |
|-------------|----------------|
| Red | Error, Fatal, Panic |
| Yellow | Warn, Warning |
| Gray | Debug, Trace |
| None | Info or undetected |

Error and warning lines also use colored text (red and yellow respectively). Debug lines appear in gray.

### Expanding a log entry

Click any log line to expand it and see all attached metadata labels as badges — including `compose_service`, `container`, `pod`, and the full ISO-8601 timestamp. The full log text is shown in a preformatted block.

## Live tailing

Click the **Tail** button to enable continuous log streaming. When active:

- A green pulse indicator appears on the button
- Logs automatically refresh every 2 seconds
- The view auto-scrolls to show the newest entries

Click **Tail** again to stop streaming.

## Toolbar actions

| Button | Action |
|--------|--------|
| **Copy** | Copies all displayed logs to the clipboard in `TIMESTAMP [CONTAINER] LINE` format |
| **Download** | Downloads logs as a `.txt` file named `container-logs-YYYY-MM-DDTHH:MM:SS.txt` |
| **Refresh** | Manually refreshes the log query |
| **Maximize** | Opens the fullscreen view in a new browser tab |

## Fullscreen mode

Click the **Maximize** button (or navigate directly to `/logs/fullscreen`) to open a fullscreen log view that fills the entire browser window. All the same filters and controls are available. Click the **Minimize** button to close the fullscreen tab.

## What to watch out for

- Logs are only available while the monitoring stack is running. If you stop or remove the monitoring stack from the Host page, the logs page will show a "not running" message.
- Loki retains logs for 7 days by default. Older logs are automatically purged.
- Very broad queries (all services, 24h range, 5,000 limit) may take longer to return. Narrow the service filter or time range if responses are slow.
- The search field uses regex syntax. Special characters like `.`, `*`, `(`, `)` are interpreted as regex operators. Escape them with a backslash if you need a literal match.
