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
4. When ready → create GitHub Release (using gh cli)
5. Release builds :production tag
6. Deploy to production
```

## Creating a Release

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
