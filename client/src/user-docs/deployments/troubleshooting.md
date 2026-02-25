---
title: Deployment Troubleshooting
description: Common deployment issues and how to diagnose them.
category: Deployments
order: 4
tags:
  - deployments
  - troubleshooting
  - errors
  - health-checks
  - haproxy
  - rollback
---

# Deployment Troubleshooting

Common issues with deployments in Mini Infra and how to investigate them.

---

## Deployment fails at image pull

**Symptom:** The deployment fails in the first step with an error about pulling the Docker image.

**Likely cause:** The image doesn't exist, the tag is wrong, or registry credentials are missing or invalid.

**What to check:**

- Verify the image name and tag in the deployment configuration. Check for typos.
- If using a private registry (like `ghcr.io`), go to **Registry Credentials** under Administration and verify the credentials are active and the connection test passes.
- Check the Docker connectivity indicator. If Docker is unreachable, no images can be pulled.

**Fix:** Correct the image name or tag, or update the registry credentials. Then trigger a new deployment.

---

## Health check fails

**Symptom:** The deployment progresses through image pull and container start, then fails at the health check step and rolls back.

**Likely cause:** The application inside the container isn't responding at the configured health endpoint, or it's returning an unexpected status code.

**What to check:**

- Look at the deployment logs on the detail page. The health check error usually shows the HTTP status received vs. expected.
- Check the container logs for application startup errors. The container may be crashing or taking longer to start than the health check timeout allows.
- Verify the health check endpoint path is correct (e.g. `/health`, not `/api/health`).
- Confirm the listening port in the deployment configuration matches the port your application actually listens on.

**Fix:** Correct the health check configuration (endpoint, port, timeout, retries). If the application needs more startup time, increase the timeout and retry count.

---

## HAProxy not switching traffic

**Symptom:** The deployment appears to complete, but requests still go to the old container or return errors.

**Likely cause:** HAProxy configuration is out of sync, or the frontend routing rule doesn't match the incoming requests.

**What to check:**

- Open the deployment detail page and look at the **HAProxy Frontend Configuration** section.
- Click **Sync Configuration** to reconcile the stored configuration with the actual HAProxy state.
- Verify the hostname in the frontend matches what clients are requesting.

**Fix:** Use the Sync Configuration button to repair the state. If that doesn't resolve it, check the HAProxy frontends and backends pages under Networking for more detail.

---

## Deployment stuck in progress

**Symptom:** The deployment shows as "deploying" or "health checking" for an unusually long time.

**Likely cause:** The container is taking a long time to start, or the health check is failing silently (timing out rather than returning an error).

**What to check:**

- Check the deployment step list on the detail page. Identify which step is currently running.
- If stuck at health checking, the container may be starting slowly. Look at the container's logs for startup messages.
- Check whether the host has sufficient resources (memory, CPU, disk) for the new container.

**Fix:** If the deployment is genuinely stuck, use the **Rollback** button to abort and revert. Then investigate the container's startup behaviour before trying again.

---

## Deploy succeeds but application returns errors

**Symptom:** The deployment completes and health checks pass, but the application returns errors to real users.

**Likely cause:** The health check endpoint is too simple — it confirms the server is running but doesn't verify that the application is fully functional (e.g. database connections, external APIs).

**What to check:**

- Look at the application logs in the container detail page.
- Verify environment variables are set correctly in the deployment configuration.
- Check if the container can reach external dependencies (databases, APIs) from within the Docker network.

**Fix:** Improve the health check endpoint so it validates critical dependencies, not just HTTP liveness. Update the deployment configuration's health check settings and redeploy.

---

## Environment not available for deployment

**Symptom:** When creating a deployment configuration, the environment dropdown is empty or your environment doesn't appear.

**Likely cause:** The environment isn't running, or it doesn't have an HAProxy service.

**What to check:**

- Go to **Environments** in the sidebar. Verify the environment exists and its status is "Running".
- Check that the environment has an HAProxy service listed in its services tab.
- If the environment shows as "Degraded" or "Failed", the HAProxy service may be unhealthy.

**Fix:** Start the environment if it's stopped. If HAProxy is unhealthy, use the **Remediate HAProxy** button on the environment detail page to repair its configuration.

---

## DNS records not created

**Symptom:** The deployment completes and traffic works by IP, but the configured hostname doesn't resolve.

**Likely cause:** Cloudflare isn't connected, or the DNS record creation failed.

**What to check:**

- Go to **Cloudflare** under Connected Services and verify the connection is green.
- On the deployment detail page, check the DNS Configuration section for error messages.
- Click **Sync DNS** to force a refresh.

**Fix:** Ensure Cloudflare is configured with a valid API token and account ID. The token needs DNS edit permissions. After fixing the connection, sync DNS from the deployment detail page.

---

## Containers left behind after failed deployment

**Symptom:** After a failed or rolled-back deployment, orphaned containers remain on the host.

**Likely cause:** The cleanup step didn't complete, or the deployment failed between creating the container and the rollback catching it.

**What to check:**

- Go to **Containers** in the sidebar and look for containers named after your application.
- On the deployment detail page, check if a **Remove Deployment** button is available.

**Fix:** Click **Remove Deployment** on the deployment detail page to clean up all associated containers, HAProxy configuration, and DNS records. If that doesn't cover everything, you can stop and remove orphaned containers from the Containers page.
