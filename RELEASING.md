# Releasing Mini Infra

This document explains how to create releases and deploy to different environments.

## Environment Strategy

| Environment | Image Tag | Trigger | Purpose |
|-------------|-----------|---------|---------|
| Dev/Test | `:dev` | Push to `main` | Automatic deployment for testing |
| Production | `:production` | GitHub Release | Manual promotion after verification |

## Image Tags

When you push to `main`, the following tags are created:
- `:dev` - Latest development build
- `:main` - Branch name tag
- `:main-abc1234` - SHA-prefixed tag for traceability

When you publish a release (e.g., `v1.2.3`), these tags are created:
- `:production` - Always points to latest release
- `:1.2.3` - Exact version tag
- `:1.2` - Major.minor tag

## Workflow

```
1. Develop on feature branch
2. Merge to main → automatically builds :dev
3. Test on dev environment
4. When ready → create GitHub Release
5. Release builds :production tag
6. Deploy to production
```

## Creating a Release

### Via GitHub UI (Recommended)

1. Go to your repository on GitHub
2. Click **Releases** in the right sidebar (or navigate to `/releases`)
3. Click **Draft a new release**
4. Click **Choose a tag** and type a new version (e.g., `v1.2.3`)
5. Click **Create new tag: v1.2.3 on publish**
6. Set the **Release title** (e.g., `v1.2.3 - Feature description`)
7. Write release notes describing what changed
8. Click **Publish release**

### Via GitHub CLI

```bash
# Create and publish a release
gh release create v1.2.3 --title "v1.2.3 - Feature description" --notes "Release notes here"

# Or create with auto-generated notes from PRs/commits
gh release create v1.2.3 --generate-notes
```

## Versioning

Use [Semantic Versioning](https://semver.org/):

- **MAJOR** (`v2.0.0`): Breaking changes
- **MINOR** (`v1.1.0`): New features, backward compatible
- **PATCH** (`v1.0.1`): Bug fixes, backward compatible

## Deploying

### Dev Environment

Dev deploys automatically when you push to `main`. Your dev server should pull:

```bash
docker pull ghcr.io/mrgeoffrich/mini-infra:dev
```

### Production Environment

After publishing a release, your production server should pull:

```bash
docker pull ghcr.io/mrgeoffrich/mini-infra:production
docker compose up -d
```

Or pull a specific version for more control:

```bash
docker pull ghcr.io/mrgeoffrich/mini-infra:1.2.3
```

## Rolling Back

To rollback production to a previous version:

```bash
# Pull the specific version you want
docker pull ghcr.io/mrgeoffrich/mini-infra:1.2.2

# Update your docker-compose.yml to use that tag, or:
docker tag ghcr.io/mrgeoffrich/mini-infra:1.2.2 ghcr.io/mrgeoffrich/mini-infra:production
docker compose up -d
```

## Checking Current Versions

```bash
# See what's running
docker inspect <container_name> | grep Image

# List available tags (requires gh CLI)
gh api /users/mrgeoffrich/packages/container/mini-infra/versions --jq '.[].metadata.container.tags'
```
