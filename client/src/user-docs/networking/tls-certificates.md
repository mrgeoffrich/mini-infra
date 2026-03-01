---
title: TLS Certificate Management
description: How to issue, renew, and manage SSL/TLS certificates in Mini Infra.
category: Networking
order: 1
tags:
  - ssl
  - tls
  - certificates
  - networking
  - azure
  - haproxy
---

# TLS Certificate Management

Mini Infra can issue and automatically renew SSL/TLS certificates using Let's Encrypt. Certificates are stored in Azure Blob Storage and used by HAProxy frontends to serve HTTPS traffic.

## Prerequisites

Before issuing certificates you need:

1. **Azure Blob Storage** — connected at [Connected Services → Azure Storage](/connectivity-azure)
2. **TLS Settings** — configured at [Settings → TLS Settings](/settings-tls) with an Azure container for certificate storage and an ACME email address
3. **Cloudflare** — connected at [Connected Services → Cloudflare](/connectivity-cloudflare) for DNS-01 challenge validation

## The Certificates page

Go to [/certificates](/certificates) to view all managed certificates.

If any certificate expires within 14 days, a warning alert appears at the top of the page showing how many certificates need attention.

## Certificate list

The certificates list shows:

- Certificate primary domain
- Status badge
- Expiry date
- Auto-renewal status

### Certificate status values

| Status | Meaning |
|--------|---------|
| `active` | Certificate is valid and in use |
| `pending` | Certificate issuance is in progress |
| `failed` | Certificate issuance or renewal failed |
| `expired` | Certificate has expired |
| `revoked` | Certificate was revoked |

## Issuing a certificate

Click **Issue Certificate** (plus icon) on the Certificates page. Enter the domain name(s) you want to cover. Mini Infra uses the ACME DNS-01 challenge via Cloudflare to verify domain ownership and issue the certificate.

## Certificate detail page

Click a certificate to open its detail page at `/certificates/:id`. The page shows:

### Certificate Status card

| Field | Description |
|-------|-------------|
| **Status** | Current certificate status badge |
| **Expires** | Expiry date and days remaining |
| **Issued** | Date the certificate was issued |
| **Auto-Renewal** | Whether automatic renewal is enabled |

### Azure Storage card

| Field | Description |
|-------|-------------|
| **Container Name** | Azure container where the certificate is stored |
| **Blob Name** | File name within the container |
| **Provider** | ACME provider (Let's Encrypt) |
| **Issuer** | Certificate authority |

### Covered Domains

Lists all Subject Alternative Names (SANs) the certificate covers.

### Renewal History

A table of past renewal attempts showing status, date, and any error messages.

## Manual renewal

On the certificate detail page, click **Renew Now** to trigger an immediate renewal, bypassing the renewal schedule.

## Revoking a certificate

On the certificate detail page, click **Revoke** to revoke the certificate. This is irreversible — the certificate will no longer be trusted by browsers.

## Automatic renewal

Mini Infra automatically renews certificates before they expire based on the **Renew Days Before Expiry** setting in [Settings → TLS Settings](/settings-tls). The renewal scheduler runs on the cron schedule configured in TLS Settings (default: daily at 2 AM).

## Using certificates in HAProxy

When creating or editing a manual HAProxy frontend, enable **SSL/TLS** and select an active certificate from the **TLS Certificate** dropdown. See [Managing HAProxy Frontends](/deployments/haproxy-frontends) for details.

## What to watch out for

- **Let's Encrypt rate limits apply.** The production endpoint has limits on certificates per domain per week. Use the **Staging** provider in TLS Settings for testing.
- Revoking a certificate is **irreversible**. Do not revoke a certificate unless you are certain it has been compromised.
- Certificates are stored in Azure Blob Storage. If the Azure connection is lost, certificate renewal will fail.
- A certificate covering a wildcard domain (`*.example.com`) requires DNS-01 challenge validation through Cloudflare.
