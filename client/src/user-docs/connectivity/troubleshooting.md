---
title: Connectivity Troubleshooting
description: Common connectivity issues with external services and how to resolve them.
category: Connectivity
order: 2
tags:
  - connectivity
  - troubleshooting
  - docker
  - azure
  - cloudflare
  - github
  - errors
---

# Connectivity Troubleshooting

Common issues with external service connections and how to investigate them.

---

## Docker shows as unreachable

**Symptom:** The Docker status dot in the header is red, and the Docker connectivity page shows "Unreachable".

**Likely cause:** The Docker daemon isn't running, or Mini Infra can't access the Docker socket.

**What to check:**

- Verify the Docker daemon is running on the host: `systemctl status docker` or `docker info`.
- If Mini Infra runs inside a container, confirm the Docker socket is mounted: `-v /var/run/docker.sock:/var/run/docker.sock`.
- Check the Docker Host URL on the Docker connectivity page. For local setups, it should be `unix:///var/run/docker.sock`.

**Fix:** Start the Docker daemon or fix the socket mount. Then click **Validate & Save** on the Docker connectivity page.

---

## Azure shows as failed

**Symptom:** The Azure status shows "Failed" or "Not Connected", and backups are failing.

**Likely cause:** The connection string is invalid, expired, or the storage account access keys were rotated.

**What to check:**

- Go to the **Azure** connectivity page and look at the error message.
- In the Azure Portal, go to your Storage Account > Access Keys and compare the connection string.
- Verify the storage account still exists and isn't disabled.

**Fix:** Copy a fresh connection string from the Azure Portal and paste it into the Azure connectivity page. Click **Validate & Save**.

---

## Cloudflare shows as failed

**Symptom:** The Cloudflare status is red, and the tunnels page shows no data.

**Likely cause:** The API token is invalid, expired, or lacks the required permissions.

**What to check:**

- Go to the **Cloudflare** connectivity page and look at the error message.
- In the Cloudflare dashboard, verify the API token is still active and has the correct permissions (Account-level Tunnel Read, Zone-level DNS Edit if using DNS features).
- Confirm the Account ID is correct.

**Fix:** Generate a new API token in Cloudflare with the required permissions and update it on the connectivity page.

---

## GitHub shows as not connected

**Symptom:** The GitHub connectivity page shows a "Connect to GitHub" prompt, or shows that the app needs installation.

**Likely cause:** The GitHub App setup wasn't completed, or the app was uninstalled from GitHub.

**What to check:**

- If you see "Connect to GitHub", the app hasn't been created yet. Start the setup flow.
- If you see "Needs Installation", the app was created but not installed on a GitHub account. Click **Install on GitHub**.
- If you see "Connected" but tests fail, the app's permissions may have been changed on GitHub.

**Fix:** Follow the setup prompts to complete the GitHub App installation. If the app was removed from GitHub, you may need to disconnect and reconnect from scratch.

---

## Service showing as connected but operations fail

**Symptom:** The connectivity status is green, but specific operations (backups, deployments, tunnel management) return errors.

**Likely cause:** The connectivity check only tests basic API access. The operation may need additional permissions or access to a specific resource.

**What to check:**

- Read the error message from the failing operation — it usually identifies the permission or resource issue.
- For Azure: the storage account may be connected, but the specific container might not exist or might have restricted access.
- For Cloudflare: the token may have tunnel read access but not DNS edit access.
- For GitHub: the app may be installed but the Package Access Token might not be configured.

**Fix:** Address the specific permission or configuration gap. Each service's connectivity page has settings for the commonly needed credentials and access levels.

---

## Intermittent connectivity

**Symptom:** A service alternates between connected and failed status, or operations succeed sometimes and fail other times.

**Likely cause:** Network instability between Mini Infra and the external service, or the service is rate-limiting requests.

**What to check:**

- Look at the response time shown on the connectivity page. High or variable response times suggest network issues.
- Check if the issue correlates with high load or specific times of day.
- For API-based services (Cloudflare, GitHub), check whether you're hitting rate limits.

**Fix:** For network issues, check the host's connectivity and DNS resolution. For rate limiting, reduce the frequency of operations or check the service's rate limit documentation.
