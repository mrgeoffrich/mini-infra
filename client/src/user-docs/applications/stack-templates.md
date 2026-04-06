---
title: Stack Templates
category: applications
order: 3
description: How to create and manage reusable stack templates for deploying infrastructure in Mini Infra
tags:
  - stack-templates
  - infrastructure
  - docker
  - configuration
---

# Stack Templates

Stack templates are reusable blueprints for deploying multi-service infrastructure stacks. They define services, parameters, networks, and volumes in a structured format similar to Docker Compose.

## Viewing Templates

The Stack Templates page lists all templates with filtering options:

- **Source** --- System (built-in) or User (custom).
- **Scope** --- Host (host-level infrastructure) or Environment (per-environment).
- **Include archived** --- Toggle to show or hide archived templates.

## Creating a Template

Click **Create Template** to open the creation dialog. Provide a name and basic metadata, then use the template editor to define services and configuration.

## Template Editor

The editor page has a main editing area and a version sidebar:

### Services

Define one or more Docker services, each with:

- Docker image and tag.
- Container configuration.
- Initialization commands.
- Dependencies between services.
- Routing rules.

### Parameters

Define template parameters that act as input variables when the template is instantiated. Each parameter has a name and default value. Parameters allow the same template to be deployed with different configurations.

### Networks and Volumes

Configure Docker networks and persistent volumes that the template's services use.

## Versioning

Templates use a draft-and-publish workflow:

1. **Create Draft** --- Start editing from the current published version.
2. **Edit** --- Changes are saved automatically as you work.
3. **Publish Draft** --- Finalize the draft as a new version with optional release notes.
4. **Discard Draft** --- Abandon the draft and return to the last published version.

The version sidebar shows the full version history. You can select any version to view it in read-only mode.

## Template Scopes

- **Host** --- Templates scoped to the host level, used for infrastructure stacks (HAProxy, monitoring, etc.).
- **Environment** --- Templates scoped to a specific environment, used for application stacks.
