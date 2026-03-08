---
title: Deployment Troubleshooting
description: Common deployment issues and how to resolve them in Mini Infra.
category: Deployments
order: 8
tags:
  - deployments
  - troubleshooting
  - haproxy
  - blue-green
  - health-checks
---

# Deployment Troubleshooting

---

## Deployment fails at the Pull Docker Image step

**Symptom:** The deployment fails during the **Pull Docker Image** step with an authentication error or "image not found" message.

**Likely cause:** The Docker image name or tag is incorrect, or registry authentication is missing.

**What to check:** Review the Docker image, tag, and registry fields on the deployment configuration. If using a private registry, check [Registry Credentials](/settings/system-settings) to ensure credentials are configured.

**Fix:** Edit the deployment configuration to correct the image name. If the registry requires authentication, add credentials at [Settings → Registry Credentials](/settings-registry-credentials).

---

## Deployment fails at the Health Check step

**Symptom:** The deployment reaches the **Health Check** step but fails after retrying, then rolls back.

**Likely cause:** The container is starting but the health check endpoint is not returning a successful response within the configured timeout.

**What to check:**
1. Open the deployment detail page and expand the **Health Check** step to see the error message.
2. Check the container's logs to see if the application started successfully.
3. Verify the **Health Check Endpoint** path and port match what your application actually exposes.
4. Check the **Timeout**, **Retries**, and **Interval** settings — they may be too aggressive for a slow-starting application.

**Fix:** Edit the deployment configuration: increase the timeout, add more retries, or fix the health check endpoint path. If the application takes more than 30 seconds to start, increase the **Max Wait Time** in the Rollback tab.

---

## Deployment shows "completed" but traffic is not routed to the new container

**Symptom:** The deployment completes successfully but the application is not reachable at its hostname.

**Likely cause:** HAProxy is not configured, or the frontend was not created.

**What to check:** Open the deployment detail page and look at the **HAProxy Frontend** section. If it shows "No HAProxy frontend configured", the environment does not have a running HAProxy service or no hostname was set.

**Fix:** Ensure the environment has a running HAProxy service. If no hostname was configured, edit the deployment configuration and add one, then redeploy.

---

## Cannot trigger a new deployment — Deploy button is disabled

**Symptom:** The **Deploy** button on a deployment configuration is grayed out.

**Likely cause:** Another deployment is already in progress, or the configuration is set to Inactive.

**What to check:** Look at the **Last Deployment** column. If the status is blue (in-progress), wait for it to complete. If the configuration shows **Inactive**, activate it.

**Fix:** Wait for the in-progress deployment to complete or fail. If the configuration is inactive, edit it and set it to active.

---

## Deployment rolled back unexpectedly

**Symptom:** A deployment that previously worked now rolls back automatically.

**Likely cause:** The new image version has a longer startup time, a new dependency that is not available, or a misconfigured health check.

**What to check:** Open the deployment detail page, expand the **Health Check** step, and review the error. Check the container's log output (visible in the deployment progress log stream) for errors during startup.

**Fix:** Fix the underlying application issue. If startup time increased, raise the **Timeout** or **Max Wait Time** in the deployment configuration.

---

## Frontend shows status "failed"

**Symptom:** A frontend in the HAProxy frontends list shows a red `failed` badge.

**Likely cause:** HAProxy could not apply the frontend configuration — possibly a conflict with another frontend using the same hostname, or a certificate issue.

**What to check:** Open the frontend detail page and look at the error message in the **Overview** card.

**Fix:** Resolve the error shown in the overview card. Common fixes: remove a conflicting frontend using the same hostname, or issue a valid TLS certificate if SSL is enabled.

---
