---
title: Container Logs
description: How real-time log streaming works and what the log viewer controls do.
category: Containers
order: 4
tags:
  - containers
  - docker
  - logs
  - streaming
  - sse
---

# Container Logs

The log viewer on the container detail page streams output from a container's stdout and stderr in real time. It connects using server-sent events (SSE), so new log lines appear as they're written without polling.

## How it works

When you open a container's detail page, the log viewer establishes an SSE connection to the backend. The backend in turn attaches to the Docker container's log stream and forwards each line to your browser.

This means you're seeing live output — the same content you'd get from running `docker logs --follow` on the command line. These are Docker-captured logs (stdout and stderr), not application log files written to disk inside the container.

## Log viewer controls

The toolbar above the log output provides several controls:

| Control | What it does |
|---------|-------------|
| **Connection status** | Shows **Connected** (green), **Disconnected** (red), or **Connecting** (yellow). Indicates whether the SSE stream is active. |
| **Line count** | Displays how many log lines are currently loaded. |
| **Tail lines** | Choose how many historical lines to load when connecting: 50, 100, or 500. New lines continue to stream in after the initial load. |
| **Search** | Text filter that highlights matching lines in yellow. Filters in the browser only — the backend still streams all lines. |
| **Timestamps** | Toggle to show or hide a `[HH:MM:SS]` prefix on each line. |
| **Auto-scroll** | When enabled (the default), the viewer scrolls to the bottom as new lines arrive. Disable it to freeze your scroll position while reading older output. |
| **Clear** | Removes all lines from the viewer. New lines continue to arrive from the stream. |
| **Reconnect** | Drops the current SSE connection and establishes a new one. Useful if the stream stalled. |
| **Download** | Downloads the currently loaded log lines as a text file. |

## ANSI colour support

The log viewer renders ANSI colour codes. If your application outputs coloured text (common with many logging frameworks), you'll see those colours preserved in the viewer. Stderr output is styled differently from stdout to help distinguish error output.

## What to watch out for

- Logs are streamed from Docker, not stored by Mini Infra. If a container is removed, its logs are gone. Download them first if you need to keep them.
- The tail setting (50/100/500) only affects the initial load. Once connected, every new line is streamed regardless of this setting.
- Search filters what's displayed in the browser. It doesn't reduce the data coming from the stream. Very high-volume containers still consume bandwidth even when you're filtering.
- If the connection status shows **Disconnected**, the container may have stopped, or the SSE connection may have been interrupted. Click **Reconnect** to re-establish the stream.
- Containers that write logs at extremely high volume can slow the browser tab. If you're seeing performance issues, reduce the tail lines setting and use the search filter to focus on what you need.
