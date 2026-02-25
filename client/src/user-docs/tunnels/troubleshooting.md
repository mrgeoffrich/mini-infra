---
title: Tunnel Troubleshooting
description: Common Cloudflare tunnel issues and how to diagnose them.
category: Tunnels
order: 2
tags:
  - cloudflare
  - tunnels
  - troubleshooting
  - errors
  - networking
---

# Tunnel Troubleshooting

Common issues with Cloudflare tunnels in Mini Infra and how to investigate them.

---

## No tunnels appear on the page

**Symptom:** The tunnels page is empty or shows a prompt to configure Cloudflare.

**Likely cause:** Cloudflare credentials aren't configured, or the API token doesn't have permission to read tunnel data.

**What to check:**

- Go to **Cloudflare** under Connected Services. Verify the status shows as connected.
- If not configured, enter your API Token and Account ID and validate the connection.
- Ensure the API token has the `Account:Cloudflare Tunnel:Read` permission.

**Fix:** Configure or update Cloudflare credentials with a token that has tunnel read access.

---

## Tunnel shows as "down" or "inactive"

**Symptom:** A tunnel's status indicator is red (down) or grey (inactive), and active connections show zero.

**Likely cause:** The `cloudflared` connector process on your server isn't running, or it's unable to reach Cloudflare's edge.

**What to check:**

- SSH into the host and verify the `cloudflared` process is running: `systemctl status cloudflared` or `docker ps | grep cloudflared`.
- Check `cloudflared` logs for connection errors.
- Verify the host has outbound internet access on port 443.

**Fix:** Restart the `cloudflared` connector. If it was stopped intentionally, the tunnel will show as inactive until it reconnects.

---

## Tunnel shows as "degraded"

**Symptom:** The tunnel's status is yellow (degraded), and the connection count is lower than expected.

**Likely cause:** Some but not all connector instances have disconnected. This can happen during network hiccups or if one replica of `cloudflared` crashed while another is still running.

**What to check:**

- Expand the tunnel and look at the active connections list. Note which connectors are still connected.
- Check if a `cloudflared` process restarted recently.

**Fix:** Degraded status often resolves itself as `cloudflared` reconnects. If it persists, restart the affected connector instances.

---

## Hostname added but traffic returns 502 or connection refused

**Symptom:** You added a public hostname pointing to a backend service, but visiting the hostname returns a 502 Bad Gateway or connection refused error.

**Likely cause:** The backend service URL is wrong, the backend isn't running, or it's not listening on the expected port.

**What to check:**

- Verify the backend service URL in the hostname configuration. It must be reachable from the machine running `cloudflared`.
- If the backend is `http://localhost:8080`, confirm something is actually listening on port 8080 on the same host as `cloudflared`.
- Check that the backend isn't blocking connections from localhost.

**Fix:** Correct the backend URL or start the backend service. If `cloudflared` runs inside Docker and the backend runs on the host, use the Docker host IP instead of `localhost`.

---

## Changes made in Cloudflare dashboard not showing

**Symptom:** You modified tunnel configuration in the Cloudflare dashboard, but the Mini Infra tunnels page shows the old state.

**Likely cause:** The page hasn't refreshed since the change was made.

**What to check:**

- Click the **Refresh** button on the tunnels page.

**Fix:** Data refreshes when you reload. Mini Infra reads tunnel state from the Cloudflare API each time the page loads or when you click refresh.
