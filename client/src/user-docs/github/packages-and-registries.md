---
title: GitHub Packages and Container Registries
description: How to browse GitHub Container Registry packages connected through the GitHub App.
tags:
  - github
  - docker
  - containers
  - configuration
---

# GitHub Packages and Container Registries

Once the GitHub App is connected and a **Package Access Token** is configured, Mini Infra can display your GitHub Container Registry (GHCR) packages on the [GitHub connectivity page](/connectivity-github).

## Viewing packages

Navigate to [Connected Services → GitHub](/connectivity-github) and click the **Packages** tab.

The packages table shows:

| Column | Description |
|--------|-------------|
| **Name** | Package name with a link to GitHub |
| **Type** | Package type (e.g., container) |
| **Visibility** | `Private` (with lock icon) or `Public` |
| **Owner** | GitHub user or organization that owns the package |
| **Updated** | When the package was last updated (relative time) |

Click the link icon on any package to open it on GitHub in a new tab.

## Prerequisites

Browsing packages requires a **Package Access Token** (personal access token with `read:packages` scope) to be configured. Without it, the Packages tab will be empty or show an error.

See [Setting Up the GitHub App](/github/github-app-setup) for instructions on adding the Package Access Token.

## Using GHCR images in deployments

Container images hosted on GHCR (`ghcr.io`) can be used in deployment configurations. To authenticate pulls from private GHCR repositories:

1. Go to [Settings → Registry Credentials](/settings-registry-credentials).
2. Add a credential with:
   - **Registry URL**: `ghcr.io`
   - **Username**: your GitHub username
   - **Password**: a GitHub Personal Access Token with `read:packages` scope

Once the credential is saved and active, Mini Infra will automatically use it when pulling images from `ghcr.io` during deployments.

## What to watch out for

- The Packages tab only shows packages accessible to the configured GitHub App and Package Access Token. Private packages owned by organizations the token does not have access to will not appear.
- The Package Access Token is separate from the GitHub App — it must be configured independently even if the GitHub App is connected.
- GHCR registry credentials for deployment pulls are configured under **Registry Credentials**, not on the GitHub connectivity page.
