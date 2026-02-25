---
title: Navigating the Dashboard
description: How the dashboard layout, sidebar, and header controls work.
category: Getting Started
order: 3
tags:
  - dashboard
  - navigation
  - sidebar
  - theme
  - timezone
---

# Navigating the Dashboard

This page covers the layout of Mini Infra: sidebar navigation, header controls, and personalisation options like dark mode and timezone settings.

## Sidebar

The sidebar on the left is your primary navigation. It groups features into collapsible sections:

- **Applications** — Containers, Deployments, Environments
- **Databases** — PostgreSQL Servers, PostgreSQL Backups
- **Networking** — Cloudflare Tunnels, Load Balancer (with Frontends and Backends sub-pages), TLS Certificates
- **Monitoring** — Events
- **Connected Services** — Docker, Cloudflare, Azure Storage, GitHub
- **Administration** — System Settings, Security Settings, Registry Credentials, Self-Backup, TLS Settings, GitHub Settings

Click the hamburger menu icon at the top-left to collapse the sidebar on smaller screens. The sidebar slides away as an offcanvas panel and reappears when you open it again.

When you navigate to the **Documentation** section, the sidebar switches to show help article navigation instead of the app menu. A **Back to app** button at the top returns you to normal navigation.

## Header

The header bar across the top shows:

- **Breadcrumbs** — The current page path. On the dashboard itself, the page title is shown instead.
- **Connectivity indicators** — Small coloured dots for Docker, Cloudflare, Azure, and GitHub. Green means connected and healthy. Red means the service check failed. Click any indicator to go to that service's connectivity page for details.
- **Backup health indicator** — Shows the status of your most recent backup operations.
- **Help button** — The **?** icon links to the help article most relevant to the current page. If the page doesn't have a specific help article, it links to the general documentation index.
- **User menu** — Your profile picture or initial. Click to access User Settings or log out.

## Dashboard cards

The main dashboard page shows a container health overview:

- **Total** — The number of containers Docker knows about (running, stopped, and paused combined).
- **Running** — Containers currently in the `running` state (green).
- **Stopped** — Containers in the `exited` state (red).
- **Paused** — Containers in the `paused` state (yellow).

Below the summary cards, a **Recently Died** section lists containers that exited in the last 24 hours (up to 3 shown). This helps you spot containers that crashed or stopped unexpectedly.

## Dark mode and light mode

Click the theme toggle in the sidebar footer to switch between dark and light mode. Your preference is saved in the browser and persists across sessions.

## Timezone settings

By default, timestamps throughout Mini Infra display in your browser's local timezone. To change this:

1. Click your user avatar in the header and select **User Settings**.
2. Use the timezone selector to search for and choose your preferred timezone.
3. Click **Save**.

All timestamps across the app — container uptimes, backup times, event logs — will display in your chosen timezone after saving.

## What to watch out for

- The connectivity indicators in the header only reflect the most recent health check. If a service was briefly unreachable but recovered, the dot turns green again on the next check cycle.
- Timezone changes affect display only. Cron schedules for backups are configured independently with their own timezone setting.
