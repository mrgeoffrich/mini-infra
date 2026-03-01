---
title: Container Troubleshooting
description: Common container issues and how to resolve them in Mini Infra.
category: Containers
order: 6
tags:
  - containers
  - docker
  - troubleshooting
---

# Container Troubleshooting

---

## Containers page shows "Configure Docker" instead of containers

**Symptom:** The Containers page shows a prompt to configure Docker rather than any container data.

**Likely cause:** Mini Infra has not been connected to a Docker daemon, or the connection settings are incorrect.

**What to check:** Go to [Connected Services → Docker](/connectivity-docker) and review the Docker Host URL and API version settings.

**Fix:** Enter a valid Docker Host URL (e.g., `unix:///var/run/docker.sock` for a local socket or `tcp://host:2376` for a remote daemon) and click **Validate & Save**. Return to the Containers page once the connection is confirmed.

---

## A container is stuck in the Restarting state

**Symptom:** A container shows status `Restarting` for an extended period.

**Likely cause:** The container's process is crashing on startup and Docker's restart policy is repeatedly restarting it.

**What to check:** Open the container detail page and view the logs. Look for error messages at the end of the log output that indicate why the process is exiting.

**Fix:** Fix the underlying crash (missing environment variable, missing dependency, misconfiguration). If you need to stop the restart loop without fixing it immediately, use the **Stop** action on the container detail page.

---

## Cannot delete a container — Delete button is disabled

**Symptom:** The **Delete** button is grayed out or not visible on the container detail page.

**Likely cause:** The container is still running. Docker requires containers to be stopped before they can be removed.

**What to check:** Check the status badge at the top of the container detail page.

**Fix:** Click **Stop** to stop the container first, then click **Delete**.

---

## A container shows status Exited with a non-zero exit code

**Symptom:** A container is in the `Exited` state and the dashboard shows it in the "Recently Died Containers" alert.

**Likely cause:** The container's process crashed or was terminated abnormally.

**What to check:** Open the container detail page and view the logs. The last lines of output usually contain the crash reason or error message.

**Fix:** Resolve the underlying error in the container's application, then use **Start** to restart it.

---

## Volume delete button is disabled

**Symptom:** The **Delete** button for a volume is grayed out.

**Likely cause:** At least one container — running or stopped — is using the volume.

**What to check:** In the volumes list, check the **In Use** column. If it shows a container count, that container must be removed before the volume can be deleted.

**Fix:** Find and remove all containers using the volume, then retry the deletion.

---

## Container name or image is truncated and hard to read

**Symptom:** Container names or image names appear cut off in the table.

**Likely cause:** The name is longer than the column width.

**What to check:** Hover over the truncated text — a tooltip shows the full value. For images, the full name including tag is visible on the container detail page.

**Fix:** No fix required; use the detail page for complete information.

---
