---
title: GitHub Repository Integration
description: How to view repositories, monitor GitHub Actions, and configure bug reporting with GitHub.
tags:
  - github
  - configuration
  - monitoring
---

# GitHub Repository Integration

Mini Infra's GitHub integration lets you browse repositories and monitor GitHub Actions workflow runs. A separate bug reporting integration lets Mini Infra create GitHub Issues automatically.

## Viewing repositories

Navigate to [Connected Services → GitHub](/connectivity-github) and click the **Repositories** tab.

The repositories table shows:

| Column | Description |
|--------|-------------|
| **Name** | Repository name with a link to GitHub |
| **Description** | Repository description (truncated) |
| **Language** | Primary programming language |
| **Visibility** | `Private` (with lock icon) or `Public` |
| **Default Branch** | Default branch name |
| **Updated** | When the repository was last updated |

Click the link icon to open a repository on GitHub.

## Monitoring GitHub Actions

Click the **Actions** tab on the GitHub connectivity page to view workflow runs.

1. Select a **repository** from the dropdown at the top of the tab.
2. The table shows recent workflow runs for that repository.

### Workflow run table

| Column | Description |
|--------|-------------|
| **Workflow** | Workflow name |
| **Status** | Run conclusion (see status values below) |
| **Branch** | Branch the workflow ran on |
| **Run #** | Workflow run number |
| **Event** | Trigger event (push, pull_request, etc.) |
| **Created** | When the run started |

### Workflow run status values

| Status | Color | Meaning |
|--------|-------|---------|
| `Success` | Green | Workflow completed successfully |
| `Failure` | Red | Workflow failed |
| `Cancelled` | Gray | Workflow was cancelled |
| `Skipped` | Gray | Workflow was skipped |
| `Timed Out` | Orange | Workflow exceeded its time limit |
| `In Progress` | Yellow | Workflow is currently running |
| `Queued` | Blue | Workflow is waiting to start |
| `Waiting` | Purple | Workflow is waiting for approval |

Click the link icon on a run to open it on GitHub.

## Bug Report Settings

Mini Infra includes a bug reporting feature that creates GitHub Issues. This is configured separately from the GitHub App at [Settings → Bug Report Settings](/bug-report-settings).

### Configuration

| Field | Description |
|-------|-------------|
| **Personal Access Token** | GitHub PAT with `repo` scope (starts with `ghp_`) |
| **Repository Owner** | GitHub username or organization that owns the target repository |
| **Repository Name** | Repository where bug reports will be created as Issues |

#### How to get a Personal Access Token

1. Go to **GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)**
2. Click **Generate new token (classic)**
3. Name it (e.g., "Mini Infra Bug Reporter")
4. Select the `repo` scope (Full control of private repositories)
5. Click **Generate token**
6. Copy the token (starts with `ghp_`) and paste it into Mini Infra

After saving, the settings page shows a confirmation: "GitHub is configured and ready for bug reporting to `owner/repo`".

Click **Test Connection** to verify the token and repository are accessible.

## What to watch out for

- The bug reporting PAT is stored encrypted but grants full repository access (`repo` scope). Use a dedicated GitHub account or a fine-grained token limited to the specific repository if possible.
- The GitHub App must be installed on the account or organization that owns the repositories you want to view. Repositories owned by other accounts will not appear.
- Workflow run history requires the GitHub App to have access to the selected repository. If a repository is not visible in the repository dropdown, the app may not be installed on that organization.
