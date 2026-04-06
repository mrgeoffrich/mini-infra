---
title: Cloudflare Tunnel Troubleshooting
description: Common issues with Cloudflare tunnel monitoring and how to resolve them.
tags:
  - tunnels
  - cloudflare
  - troubleshooting
---

# Cloudflare Tunnel Troubleshooting

---

## No tunnels appear on the Tunnels page

**Symptom:** The Tunnels page is empty or shows a configuration prompt.

**Likely cause:** Cloudflare has not been configured in Mini Infra, or the API token does not have the correct permissions.

**What to check:** Go to [Connected Services → Cloudflare](/connectivity-cloudflare). Check whether the connection is validated and healthy.

**Fix:** Enter a valid Cloudflare API token with `Zone:Read` and `Tunnel:Read` permissions, plus your Account ID. Click **Validate & Save**.

---

## A tunnel shows status "down" or "inactive"

**Symptom:** A tunnel appears in the list but shows `down` (red) or `inactive` (gray) status.

**Likely cause:** The `cloudflared` daemon that maintains the tunnel is not running on the server that should be connecting the tunnel.

**What to check:** Log into the server running `cloudflared` and check if the process is running. Review `cloudflared` logs for connection errors.

**Fix:** Start or restart `cloudflared` on the tunnel server. The tunnel status in Mini Infra will update when you click **Refresh**.

---

## A hostname routing rule was added but traffic is not reaching the backend

**Symptom:** You added a hostname in the tunnel configuration but requests to that hostname return errors or do not reach the backend service.

**Likely cause:** The backend service URL is incorrect, the backend is not running, or DNS propagation has not completed.

**What to check:**
1. Verify the backend service is running and accessible at the URL you configured.
2. Check the DNS record for the hostname — it should point to the Cloudflare tunnel.
3. Try accessing the backend service directly from the tunnel server.

**Fix:** Correct the backend service URL in the hostname configuration. Ensure the backend service is running and listening on the configured port.

---

## "Validate & Save" on the Cloudflare settings page returns an error

**Symptom:** Attempting to validate Cloudflare credentials returns "Validation failed".

**Likely cause:** The API token is invalid, expired, or missing required permissions. The Account ID may also be incorrect.

**What to check:** In the error message on the connectivity page, look for specific details about which permission is missing.

**Fix:** Generate a new API token in the Cloudflare dashboard with `Zone:Read` and `Tunnel:Read` permissions. Verify your Account ID from the Cloudflare URL: `https://dash.cloudflare.com/[account-id]/home`.

---
