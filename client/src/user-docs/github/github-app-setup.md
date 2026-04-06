---
title: Setting Up the GitHub App
description: How to connect Mini Infra to GitHub using the GitHub App integration.
tags:
  - github
  - authentication
  - configuration
  - getting-started
---

# Setting Up the GitHub App

Mini Infra integrates with GitHub to browse container packages, repositories, and GitHub Actions workflow runs. The integration uses a GitHub App for secure, scoped access.

## Prerequisites

Before setting up the GitHub App, Mini Infra must be accessible at a public or network-reachable URL so GitHub can complete the OAuth callback.

## Connecting to GitHub

1. Go to [Connected Services → GitHub](/connectivity-github).
2. Click **Connect to GitHub**.
3. You are redirected to GitHub, where you can review the permissions the app requests and approve them.
4. After approval, GitHub redirects you back to Mini Infra and the setup completes automatically.

### Permissions requested

The GitHub App requests **read-only** access to:

- Packages (GitHub Container Registry)
- Actions (workflow runs)
- Contents (repository files)
- Metadata (repository info)

## Installing the app on your account

After the app is created on GitHub, you may be prompted to **install** it on your personal account or organization. Click **Install on GitHub** and follow the prompts. Then return to Mini Infra and click **Check Installation** to verify.

## App status indicators

Once connected, the page shows:

| Field | Description |
|-------|-------------|
| **App Name** | Name of the installed GitHub App |
| **Connected Account** | GitHub account or organization the app is installed on |
| **App ID** | Numeric identifier of the GitHub App |
| **Connection status** | Real-time health badge showing connection state |

## Configuring additional access tokens

The GitHub App provides read-only access to repositories and actions. For additional capabilities, you can configure two optional personal access tokens:

### Package Access Token

Required to browse **GitHub Container Registry (GHCR)** packages. GitHub App tokens cannot access GHCR, so a separate personal access token with `read:packages` scope is needed.

1. Click **Generate Token on GitHub** to open GitHub's token creation page with the `read:packages` scope pre-selected.
2. Generate the token, copy it.
3. Paste the token into the input field and click **Save**.

The status changes to **Configured** (green) when saved.

### Assistant Access Token

Optional personal access token for AI agent GitHub integration.

Choose an access level:

| Level | Scopes | Allows |
|-------|--------|--------|
| **Read Only** | `repo:status`, `public_repo`, `read:org` | View repos, PRs, issues, org info |
| **Full Access** | `repo`, `workflow`, `read:org`, `write:org` | Full repo access, workflow dispatch, org writes |

Click **Generate Token on GitHub**, copy the token, paste it, and click **Save**.

## Testing the connection

Click **Test Connection** to verify the GitHub App is working. The button shows the response time in milliseconds if successful.

Click **Refresh GHCR Token** to regenerate the container registry token from the GitHub App.

## Disconnecting

Click **Disconnect** to remove the GitHub App configuration from Mini Infra. A confirmation dialog appears. This removes all stored tokens and app credentials.

## Bug Report Settings

Mini Infra also has a separate **Bug Report** integration at [Settings → Bug Report Settings](/bug-report-settings) that uses a simple Personal Access Token (not the GitHub App) to create GitHub Issues for bug reports. See [GitHub Repository Integration](/github/repository-integration) for details.

## What to watch out for

- The GitHub App OAuth flow must be completed in one session — do not close the browser tab while the GitHub redirect is in progress.
- GitHub App tokens expire periodically. If the GitHub connection stops working, use **Test Connection** to check — you may need to disconnect and reconnect.
- The Package Access Token is separate from the GitHub App and must be created manually with the `read:packages` scope.
