---
title: DNS Zones
category: networking
order: 2
description: How to view DNS zones and records from Cloudflare in Mini Infra
tags:
  - dns
  - cloudflare
  - networking
  - zones
---

# DNS Zones

The DNS Zones page displays DNS zones and records pulled from your connected Cloudflare account. Zone data is cached locally and can be refreshed on demand.

## Prerequisites

DNS zone viewing requires a connected Cloudflare account. If Cloudflare is not configured, the page shows a prompt to set it up on the [Cloudflare connectivity](/help/connectivity/health-monitoring) page.

## Viewing Zones

Each DNS zone is displayed as a card showing the zone name and its records. The page shows the timestamp of the last refresh so you know how current the data is.

## Refreshing Data

- **Reload** --- Refreshes the locally cached data without contacting Cloudflare.
- **Refresh from Cloudflare** --- Fetches the latest zones and records from the Cloudflare API and updates the local cache. A success message shows the number of zones and records retrieved.

## Notes

DNS zones are read-only in Mini Infra. To modify DNS records, use the Cloudflare dashboard or API directly. Mini Infra creates DNS records automatically when you enable SSL routing on an application or manual frontend connection.
