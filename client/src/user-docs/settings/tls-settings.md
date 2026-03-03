---
title: TLS Settings
description: How to configure certificate storage, ACME provider, and renewal scheduling for TLS certificates.
category: Settings
order: 5
tags:
  - settings
  - tls
  - ssl
  - certificates
  - azure
  - configuration
---

# TLS Settings

The **TLS Settings** page at [/settings-tls](/settings-tls) configures where certificates are stored, which ACME provider issues them, and when renewal checks run.

## Certificate Storage

Certificates issued by Mini Infra are stored in Azure Blob Storage.

| Field | Description |
|-------|-------------|
| **Certificate Container** | Azure Blob Storage container to use for certificate files. Select from the dropdown or click **Refresh** to reload available containers. |

Click **Test Connection** to verify that Mini Infra can access the selected container, then **Save Settings** to apply.

Azure Blob Storage must be connected at [Connected Services → Azure Storage](/connectivity-azure) for this section to work.

## ACME Provider

ACME (Automatic Certificate Management Environment) is the protocol used by Let's Encrypt to issue certificates.

| Field | Options | Description |
|-------|---------|-------------|
| **Provider** | Let's Encrypt (Production), Let's Encrypt (Staging) | Which Let's Encrypt endpoint to use |
| **Email Address** | — | Email for ACME account registration and renewal notifications |

### Production vs Staging

| Provider | Use case | Rate limits |
|----------|----------|------------|
| **Production** | Real certificates trusted by browsers | Strict rate limits — up to 50 certificates per domain per week |
| **Staging** | Testing the certificate workflow | Relaxed limits — certificates are not trusted by browsers |

Use **Staging** when testing your setup to avoid hitting production rate limits.

## Renewal Scheduler

Mini Infra automatically checks for and renews expiring certificates on a schedule.

| Field | Default | Description |
|-------|---------|-------------|
| **Check Schedule (Cron)** | `0 2 * * *` | When to run the renewal check (daily at 2 AM by default) |
| **Renew Days Before Expiry** | — | Number of days before expiry to trigger renewal (1–60) |

For example, with **Renew Days Before Expiry** set to 14, certificates are renewed 14 days before they expire.

## What to watch out for

- Switching from **Staging** to **Production** after testing does not automatically re-issue existing staging certificates. You must revoke and re-issue them using the Production provider.
- The **Email Address** is required for ACME account registration. Let's Encrypt uses it to send expiry warnings if automatic renewal fails.
- Certificates require **Cloudflare** to be connected for DNS-01 challenge validation. If Cloudflare is not connected, certificate issuance will fail.
- Certificate storage requires **Azure Blob Storage** to be connected. If Azure is unavailable, renewal will fail.
