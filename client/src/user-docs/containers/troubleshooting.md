---
title: Container Troubleshooting
description: Common container issues and how to diagnose them.
category: Containers
order: 5
tags:
  - containers
  - docker
  - troubleshooting
  - errors
  - debugging
---

# Container Troubleshooting

Common issues with Docker containers in Mini Infra and how to investigate them.

---

## Container won't start

**Symptom:** You click Start but the container immediately returns to a stopped state, or never transitions to Running.

**Likely cause:** The container's entrypoint or command is failing on startup. Common reasons include a missing configuration file, a required environment variable that isn't set, or a port conflict with another container.

**What to check:**

- Open the container detail page and look at the **Logs** section. Docker captures output from the failed start attempt — error messages usually appear there.
- Check if another container is already using the same published port. Filter the container list by `running` status and look for port conflicts.
- Verify the Docker image still exists on the host. If the image was removed, Docker can't start the container.

**Fix:** Address the issue shown in the logs. For port conflicts, stop the conflicting container first or change the port mapping by recreating the container.

---

## Container keeps restarting

**Symptom:** The container status cycles between Running and Restarting, or the container runs for a few seconds before exiting and restarting.

**Likely cause:** The application inside the container is crashing. If the container has a restart policy of `always` or `unless-stopped`, Docker keeps restarting it automatically.

**What to check:**

- Check the container logs for crash output. Look for stack traces, out-of-memory errors, or "killed" messages.
- On the container detail page, check the restart count. A high number confirms the restart loop.
- If the logs mention "OOM" or "Killed", the container may be exceeding its memory limit.

**Fix:** Fix the underlying application error. If you need to stop the restart loop to investigate, use **Stop** to halt the container and then read the logs from the last run.

---

## Logs not appearing

**Symptom:** The log viewer shows "Connected" but no log lines appear, or it shows "Disconnected".

**Likely cause:** The container isn't producing output on stdout/stderr, or the container is stopped.

**What to check:**

- Verify the container is in the **Running** state. Stopped containers don't produce new log output.
- Check the **tail lines** setting. If set to 50, and the container hasn't produced 50 lines of recent output, you might see fewer lines than expected.
- Some applications write to log files inside the container instead of stdout. Docker can only capture stdout and stderr — file-based logs won't appear in the viewer.

**Fix:** If the container writes to files, you may be able to access them through a volume mount. Check the **Volumes** section on the container detail page. If the application can be configured to log to stdout instead, that's the more reliable approach for Docker environments.

---

## Stale container status

**Symptom:** The container list shows a status that doesn't match what you expect (e.g. showing as Running when you know it was stopped).

**Likely cause:** The auto-refresh hasn't run since the state changed. The container list refreshes every 30 seconds.

**What to check:**

- Click the **Refresh** button to force an immediate update.
- Check the Docker connectivity indicator in the header. If it's red, Mini Infra can't reach the Docker daemon, and status information is stale.

**Fix:** If a manual refresh updates the status correctly, this was a timing issue. If the Docker connectivity indicator is red, investigate the Docker daemon connection from the **Docker** page under Connected Services.

---

## Container removed but still showing

**Symptom:** A container you removed via `docker rm` on the command line still appears in the Mini Infra list.

**Likely cause:** Same as stale status — the list hasn't refreshed yet.

**What to check:**

- Click **Refresh** in the container list.

**Fix:** The container will disappear on the next refresh. Mini Infra doesn't cache container state — it reads directly from Docker on each request.
