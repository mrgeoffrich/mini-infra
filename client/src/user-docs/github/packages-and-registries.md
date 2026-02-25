---
title: Packages and Registries
description: Using GitHub Container Registry with Mini Infra for deployment image discovery and pulling.
category: GitHub
order: 2
tags:
  - github
  - packages
  - ghcr
  - container-registry
  - docker
  - deployments
---

# Packages and Registries

Mini Infra can browse packages from GitHub Container Registry (ghcr.io) and use them as Docker images for deployments.

## How it works

When the GitHub integration is fully configured (including the Package Access Token), Mini Infra queries GHCR for packages associated with your GitHub account. These packages — typically Docker images — appear in the Packages tab on the GitHub connectivity page and can be referenced in deployment configurations.

The Package Access Token is also used to create a Docker registry credential for `ghcr.io` automatically. This means deployments can pull private images from GHCR without additional credential setup.

## Viewing packages

Navigate to **GitHub** under Connected Services and select the **Packages** tab. The table shows:

| Column | What it shows |
|--------|--------------|
| **Name** | The package name as it appears in GHCR |
| **Type** | Package type — usually `docker` for container images, but can also be `npm` or others |
| **Visibility** | Whether the package is public or private |
| **Owner** | The GitHub user or organisation that owns the package |
| **Updated** | When the package was last updated |

Each row has an external link icon that opens the package page on GitHub.

## Using GHCR images in deployments

When creating or editing a deployment configuration:

1. Set the **Docker Registry** to `ghcr.io`.
2. Set the **Docker Image** to the package name (e.g. `myorg/myapp`).
3. Set the **Docker Tag** to the desired version tag.

The registry credential for GHCR was created automatically during GitHub setup, so private images are pulled without extra configuration. You can verify the credential exists on the **Registry Credentials** page under Administration.

## Registry credentials

Mini Infra supports credentials for any Docker-compatible registry, not just GHCR. The **Registry Credentials** page under Administration lets you manage credentials for Docker Hub, AWS ECR, Azure Container Registry, or any private registry.

When a deployment configuration specifies a registry, Mini Infra matches it against stored credentials and uses the appropriate one for image pulls.

## What to watch out for

- The GHCR registry credential is created from your Package Access Token. If you revoke or regenerate the PAT on the GitHub connectivity page, the credential is updated automatically.
- Package visibility (public/private) is determined by the GitHub repository's settings. Making a repository public makes its packages public too.
- The Packages tab shows all package types, not just Docker images. Only Docker-type packages can be used in deployments.
- If the Package Access Token isn't configured, the Packages tab still shows public packages but private ones won't appear, and deployments can't pull private images.
