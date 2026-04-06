---
title: Connected Services Troubleshooting
description: Common issues with external service connections and how to resolve them.
tags:
  - connectivity
  - troubleshooting
  - docker
  - azure
  - cloudflare
  - github
---

# Connected Services Troubleshooting

---

## Docker validation fails with "connection refused"

**Symptom:** Clicking **Validate & Save** on the Docker configuration page returns a connection refused error.

**Likely cause:** The Docker Host URL is incorrect, or the Docker daemon is not running.

**What to check:** Verify the Docker daemon is running on the host. For socket-based connections, ensure the socket file exists and is accessible.

**Fix:** Use `unix:///var/run/docker.sock` for a local socket connection. If Mini Infra is running inside Docker, ensure the socket is mounted with `-v /var/run/docker.sock:/var/run/docker.sock`.

---

## Docker Host IP Address is required but shows an error

**Symptom:** Saving Docker settings fails with a validation error about the IP address.

**Likely cause:** The Docker Host IP Address field is empty or contains an invalid IPv4 address.

**What to check:** The field must contain a valid IPv4 address. It is used to create DNS A records when deployments set up hostnames.

**Fix:** Enter the public or private IPv4 address of the machine running Docker (e.g., `192.168.1.100`).

---

## Azure validation fails with "authentication error"

**Symptom:** Azure validation returns an authentication or authorization error.

**Likely cause:** The connection string is incorrect, the storage account key has been rotated, or the connection string is from a different storage account.

**What to check:** In the Azure portal, go to **Storage Account → Access Keys** and copy the full connection string (not just the key).

**Fix:** Paste the complete connection string including `DefaultEndpointsProtocol`, `AccountName`, `AccountKey`, and `EndpointSuffix`.

---

## Cloudflare validation succeeds but no tunnels appear

**Symptom:** The Cloudflare connection validates successfully but the Tunnels page shows no tunnels.

**Likely cause:** The Account ID is for a different Cloudflare account than where the tunnels are configured, or no tunnels have been created yet.

**What to check:** Confirm the Account ID matches the account where your tunnels are set up. Check the Cloudflare dashboard directly to verify tunnels exist.

**Fix:** Update the Account ID to match the correct Cloudflare account.

---

## GitHub App setup fails or returns to a broken state

**Symptom:** After clicking **Connect to GitHub** and approving on GitHub, the setup page shows an error or a loading spinner that never completes.

**Likely cause:** The OAuth callback failed, the code expired, or the network request timed out.

**What to check:** Look at the error message on the GitHub connectivity page. Check if the Mini Infra application logs show any errors.

**Fix:** Click **Remove App** (if shown) to clear the partial state, then try **Connect to GitHub** again. Ensure you complete the GitHub approval quickly — the OAuth code expires after a few minutes.

---

## Package Access Token shows "Not Configured" after saving

**Symptom:** You entered a GitHub Personal Access Token for package access but it still shows "Not Configured".

**Likely cause:** The token may have been entered incorrectly, or the save operation failed silently.

**What to check:** Re-enter the token in the input field and click **Save**. Ensure the token starts with `ghp_` or `github_pat_` and has the `read:packages` scope.

**Fix:** Generate a new token in GitHub settings with `read:packages` scope and paste it into the field.

---
