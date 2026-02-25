---
title: GitHub App Setup
description: How to install and configure the GitHub App integration for packages, repositories, and actions.
category: GitHub
order: 1
tags:
  - github
  - integration
  - setup
  - authentication
  - app
---

# GitHub App Setup

Mini Infra integrates with GitHub through a GitHub App. This gives access to GitHub Container Registry packages, repository data, and GitHub Actions workflow runs.

## What the integration provides

Once connected, you get:

- **Packages** — Browse Docker images and other packages in GitHub Container Registry (ghcr.io). Link them to deployment configurations for pulling images.
- **Repositories** — View accessible repositories with metadata like language, visibility, and default branch.
- **Actions** — Monitor recent GitHub Actions workflow runs across your repositories, with status and branch information.

## Permissions requested

The GitHub App requests these read-only permissions:

- **Packages** (read) — Access to GitHub Container Registry packages.
- **Actions** (read) — Access to workflow run data.
- **Contents** (read) — Access to repository file contents.
- **Metadata** (read) — Basic repository metadata.

No write permissions are requested. Mini Infra reads data from GitHub but doesn't modify repositories, packages, or workflows.

## Setup process

Navigate to **GitHub** under Connected Services. The setup has three stages:

### Stage 1: Create the GitHub App

Click **Connect to GitHub**. This redirects you to GitHub where a new GitHub App is created using a manifest flow. GitHub asks you to confirm the app creation and approve the permissions. After approval, you're redirected back to Mini Infra.

### Stage 2: Install the app

After the app is created, Mini Infra prompts you to install it on your GitHub account or organisation. Click **Install on GitHub** to open the GitHub installation page. Choose which account to install on and which repositories to grant access to (all repositories or selected ones).

After installing, return to Mini Infra and click **Check Installation** to verify the installation was detected.

### Stage 3: Configure Package Access Token

The GitHub App token provides access to repositories and actions, but accessing GitHub Container Registry packages requires a separate Personal Access Token (PAT).

On the GitHub connectivity page, in the **Package Access** section:

1. Click the link to generate a token on GitHub. The token needs the `read:packages` scope.
2. Copy the generated token.
3. Paste it into the input field and save.

Mini Infra uses this token to create a Docker registry credential for `ghcr.io` automatically, making GHCR images available for deployments.

## After setup

Once fully connected, the GitHub connectivity page shows:

- **App Name** — The name of the created GitHub App.
- **Connected Account** — Which GitHub account or organisation the app is installed on.
- **App ID** — The GitHub App's numeric identifier.
- **Package Access** status — Whether the PAT for GHCR is configured.

Three tabs display the available data:

- **Packages** — Table of GHCR packages with name, type, visibility, owner, and last updated date.
- **Repositories** — Table of accessible repos with name, description, language, visibility, and default branch.
- **Actions** — Dropdown to select a repository, then a table of recent workflow runs with status, branch, run number, event trigger, and creation date.

## Managing the connection

- **Test Connection** — Verifies the GitHub App can still authenticate and access resources.
- **Refresh GHCR Token** — Re-creates the Docker registry credential from the current PAT.
- **Disconnect** — Removes the GitHub App configuration from Mini Infra. The app still exists on GitHub and would need to be uninstalled separately from GitHub's settings.

## What to watch out for

- The GitHub App and the Package Access Token are separate credentials. The app provides repo and actions access; the PAT provides package access. Both are needed for full functionality.
- If you install the app on selected repositories only, Mini Infra only sees those repositories. To add more later, update the installation settings on GitHub.
- The PAT for package access is a classic or fine-grained token — either works as long as it has `read:packages` scope.
- Disconnecting from Mini Infra doesn't uninstall the GitHub App from your account. You should uninstall it from GitHub's settings if you no longer need it.
