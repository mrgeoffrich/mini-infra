---
title: Navigating the Dashboard
description: A guide to finding your way around the Mini Infra interface.
category: Getting Started
order: 2
tags:
  - getting-started
  - navigation
  - dashboard
  - ui
---

# Navigating the Dashboard

Mini Infra's interface is organized around a persistent sidebar navigation and a main content area. Every major feature is one click away from the sidebar.

## The sidebar

The sidebar groups features into sections:

| Section | Pages |
|---------|-------|
| **Dashboard** | Overview of containers and deployments |
| **Applications** | Containers, Deployments, Environments |
| **Databases** | Postgres Servers, Postgres Backups |
| **Networking** | Cloudflare Tunnels, Load Balancer (HAProxy), TLS Certificates |
| **Monitoring** | Events |
| **Connected Services** | Docker, Cloudflare, Azure Storage, GitHub |
| **Administration** | API Keys, System Settings, Security Settings, Registry Credentials, TLS Settings, Self-Backup Settings, Bug Report Settings |
| **User** | User Settings |

## The Dashboard page

The **Dashboard** at `/dashboard` is the home screen. It shows:

- **Container summary cards** — Running, Stopped, and Paused container counts, plus a total. A **Recently Died Containers** alert appears if any containers exited in the last 24 hours.
- **Deployment summary cards** — counts of active configurations, currently running deployments, and failed deployments that need attention.
- **Recent Deployments card** — the last few deployments with status badges and timestamps. Click any row to go to that deployment's detail page.

The container data refreshes automatically. If Docker is not connected, the container section shows a prompt to configure the Docker connection.

## Contextual help

Most pages show a help icon or link to a relevant help article. Click it to open the article in a side panel without leaving the current page.

## Breadcrumbs and back navigation

Detail pages (e.g., a single container, deployment, or certificate) show a **back button** in the top-left that returns you to the parent list page. Some pages also show a breadcrumb trail (e.g., PostgreSQL → server name → database name).

## Status badges

Status badges appear throughout the interface. Their color conveys meaning at a glance:

| Color | Meaning |
|-------|---------|
| Green | Healthy, Running, Completed, Active |
| Yellow | Paused, Pending, Degraded, Scheduled |
| Blue | In progress, Deploying, Restarting |
| Red | Exited, Failed, Unhealthy, Error |
| Gray | Stopped, Inactive, Removed, Unknown |
| Orange | Rolling back |

## What to watch out for

- The sidebar navigation is always visible on desktop. On smaller screens it may collapse — use the menu icon to open it.
- The **Dashboard** page does not auto-navigate elsewhere on errors; check the **Connected Services** section if data is not loading.
