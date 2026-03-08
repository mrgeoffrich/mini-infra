---
title: Container Metrics
description: How to monitor CPU, memory, and network usage across Docker containers in Mini Infra.
category: Monitoring
order: 3
tags:
  - monitoring
  - metrics
  - docker
  - prometheus
---

# Container Metrics

The **Container Metrics** page displays real-time CPU, memory, and network usage charts for all running Docker containers. Metrics are collected by Telegraf, stored in Prometheus, and visualized as interactive area charts with automatic refresh.

## Prerequisites

The monitoring stack must be running for metrics to appear. If it is not deployed, the page displays a message directing you to the **Host** page to deploy it. See [Host Infrastructure Stacks](/help/applications/host-stacks) for details.

## Navigating to metrics

Go to **Container Metrics** in the sidebar under **Monitoring**. The page shows a time range selector at the top, followed by metric charts and a summary table.

## Time range

Select a time window from the dropdown in the top-right corner:

| Option | Sampling interval |
|--------|------------------|
| **Last 15 minutes** | 15-second data points |
| **Last 1 hour** (default) | 60-second data points |
| **Last 6 hours** | 5-minute data points |
| **Last 24 hours** | 10-minute data points |

Shorter ranges provide more granular data. Longer ranges use wider sampling intervals to keep chart performance smooth.

## Metric charts

Four area charts are displayed in a responsive grid (two columns on wide screens, one column on smaller screens):

### CPU Usage

Shows the CPU usage rate per container as a percentage. Values below 1% are displayed in millicores (e.g. `5m`). Data is calculated as a 5-minute rate of the total CPU time consumed.

### Memory Usage

Shows the working set memory for each container, formatted in bytes (B, KB, MB, GB). This reflects the actual memory the container is actively using.

### Network Receive

Shows inbound network traffic rate per container in bytes per second (B/s, KB/s, MB/s). Calculated as a 5-minute rate of received bytes.

### Network Transmit

Shows outbound network traffic rate per container in bytes per second. Uses the same calculation as Network Receive but for transmitted data.

### Reading the charts

- Each container appears as a separate colored area in the chart
- Hover over any point to see the exact timestamp and per-container values in a tooltip
- The X-axis shows time in `HH:MM` format
- The Y-axis auto-scales to fit the data with formatted units
- Charts display "No data available" when there are no metrics for the selected range

## Container metrics table

Below the charts, a summary table shows the **current instantaneous** metrics for each container:

| Column | Description |
|--------|-------------|
| **Container** | Container name (from Docker Compose service label or container name) |
| **CPU Usage** | Current CPU usage as a percentage or millicores |
| **Memory** | Current memory usage in human-readable units |

The table is sorted by CPU usage (highest first) and updates every 15 seconds. When no data is available, the table shows "Waiting for metrics data from Prometheus..."

## Auto-refresh behavior

The page refreshes automatically in the background:

- **Charts** refresh every 30 seconds
- **Table** refreshes every 15 seconds
- **Monitoring status** checks every 15 seconds

No manual refresh is needed — data stays current while the page is open.

## What to watch out for

- Metrics only appear for containers that have been running long enough for Telegraf to collect data (at least 10 seconds after container start).
- If you stop the monitoring stack from the Host page, charts will stop updating and the page will show a "not running" message.
- Prometheus retains metric data for 30 days. Historical data beyond that window is not available.
- Short-lived containers may not appear in the charts if they exit before the next collection interval.
- Network metrics are per-container totals across all network interfaces. If a container has multiple networks, the values reflect combined traffic.
