---
title: Viewing Container Logs
description: How to view and use the container log viewer in Mini Infra.
category: Containers
order: 4
tags:
  - containers
  - docker
  - monitoring
---

# Viewing Container Logs

Mini Infra provides an embedded log viewer on each container's detail page. The log viewer streams the container's standard output and standard error in real time.

## Accessing logs

1. Go to [/containers](/containers).
2. Click the container name to open its detail page.
3. Scroll to the bottom of the page — the log viewer is embedded there.

The log viewer is 600px tall and displays the most recent log output from the container.

## What the log viewer shows

The log viewer displays the combined `stdout` and `stderr` streams from the container, the same output you would see running `docker logs <container-name>` from a terminal.

Output is displayed in a monospace font. Timestamps are included if the container was started with timestamped logging.

## What to watch out for

- Logs are **read-only** — you cannot clear, filter, or search within the log viewer.
- For containers that produce a very high volume of log output, the viewer shows the most recent lines.
- If the container is stopped or exited, the log viewer shows its last recorded output.
- For structured log analysis or log retention, consider exporting logs via the Docker CLI (`docker logs --since`, `docker logs -f`) or a dedicated log aggregation tool.
