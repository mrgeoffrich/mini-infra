---
title: Repository Integration
description: What repository and Actions data Mini Infra pulls from GitHub and how it's displayed.
category: GitHub
order: 3
tags:
  - github
  - repositories
  - actions
  - workflows
  - ci-cd
---

# Repository Integration

Mini Infra provides read-only visibility into your GitHub repositories and their Actions workflow runs.

## Repositories tab

Navigate to **GitHub** under Connected Services and select the **Repositories** tab. The table lists all repositories accessible to the installed GitHub App:

| Column | What it shows |
|--------|--------------|
| **Name** | Repository name |
| **Description** | The repository's description, if set |
| **Language** | Primary programming language |
| **Visibility** | Public or private |
| **Default Branch** | The default branch (e.g. `main`) |
| **Updated** | Last update timestamp |

Each row links to the repository on GitHub.

Which repositories appear depends on how you installed the GitHub App. If you chose "All repositories", every repo in the account is listed. If you chose specific repositories, only those appear. To change this, update the app's installation settings on GitHub.

## Actions tab

Select the **Actions** tab to monitor GitHub Actions workflow runs. A dropdown at the top lets you select which repository to view runs for.

The table shows recent workflow runs:

| Column | What it shows |
|--------|--------------|
| **Workflow Name** | The name of the workflow (from the YAML file) |
| **Status** | Colour-coded badge: green (success), red (failure), grey (cancelled), yellow (in progress), orange (timed out), blue (queued), purple (waiting) |
| **Branch** | Which branch the workflow ran on |
| **Run #** | The sequential run number |
| **Event** | What triggered the run (push, pull_request, schedule, workflow_dispatch, etc.) |
| **Created** | When the run started |

Each row links to the workflow run on GitHub for full details and logs.

## How the data is used

Repository and Actions data in Mini Infra is informational. It gives you visibility into your CI/CD pipeline alongside your infrastructure without switching to GitHub. There's no automation triggered from this data — deployments are still triggered manually from the Deployments page.

The integration is useful for:

- Checking whether a CI build passed before triggering a deployment.
- Seeing which repositories are active and recently updated.
- Monitoring workflow failures without leaving Mini Infra.

## What to watch out for

- Mini Infra reads data from GitHub but doesn't trigger or modify workflows.
- The Actions tab shows runs from the selected repository only. Switch the dropdown to view runs from a different repo.
- Workflow runs update frequently. The page polls for updates, but there may be a brief delay between a run completing on GitHub and the status updating in Mini Infra.
- If a repository doesn't appear in the list, check whether the GitHub App installation has access to it. You may need to update the installation settings on GitHub to include additional repositories.
