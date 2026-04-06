---
title: AI Assistant Settings
description: How to configure the AI assistant's API key, model, and view its capabilities in Mini Infra.
tags:
  - ai
  - configuration
  - anthropic
  - claude
  - settings
---

# AI Assistant Settings

Mini Infra includes an AI assistant powered by Anthropic's Claude models. The **AI Assistant** settings page lets you configure an API key, choose a model, and see which services the assistant can access. Navigate to **Administration > AI Assistant** to manage these settings.

## API Key Configuration

The assistant requires an Anthropic API key to function. You can provide a key in two ways:

| Method | How to set | Can modify in UI? |
|--------|-----------|-------------------|
| **Database** | Enter directly on this page | Yes — can update or delete |
| **Environment variable** | Set `ANTHROPIC_API_KEY` before starting the server | No — read-only in UI |

To add a key through the UI:

1. Enter your Anthropic API key in the input field (keys start with `sk-ant-...`)
2. Optionally click **Validate** to test the key against the Anthropic API without saving
3. Click **Save** to store the key and enable the assistant

If a key is already configured, it appears masked (e.g. `sk-ant-...abcd`). A **source** label shows whether the key comes from the database or an environment variable.

When the key is set via the `ANTHROPIC_API_KEY` environment variable, the input field is informational only. To change it, update the environment variable and restart the server.

### Deleting an API Key

Click the **Delete** button (trash icon) next to the masked key to remove it. This immediately disables the AI assistant. The delete option is only available for keys stored in the database — environment-variable keys must be removed by unsetting the variable and restarting.

### Validation Results

When you click **Validate**, the server tests the key by making a request to the Anthropic API. Possible outcomes:

| Result | Meaning |
|--------|---------|
| Valid | Key authenticated successfully |
| Valid (rate limited) | Key is correct but currently rate-limited by Anthropic |
| Invalid API key | Key was rejected — check for typos or expiration |
| Connection error | Could not reach the Anthropic API — check network connectivity |

## Model Selection

Choose which Claude model the assistant uses from the **Model** dropdown:

| Model ID | Label |
|----------|-------|
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |

The default model is **Claude Sonnet 4.6**. After selecting a different model, click **Save Model** to apply the change.

If the `AGENT_MODEL` environment variable is set, the dropdown is disabled and a notice explains the override. Update the environment variable and restart the server to change it.

A **source** label indicates how the current model was configured:

| Source | Meaning |
|--------|---------|
| `default` | Using the built-in default (Claude Sonnet 4.6) |
| `database` | Saved through the UI |
| `environment` | Set via the `AGENT_MODEL` environment variable |

## Capabilities

The **Capabilities** card shows which services the assistant can access. Each capability displays an **Available** (green) or **Unavailable** (red) status badge.

| Capability | Description | How to enable |
|------------|-------------|---------------|
| **API Access** | Internal API access via a dedicated service key | Automatically available when the assistant is configured |
| **Docker** | Access to the Docker socket at `/var/run/docker.sock` | Ensure the Docker socket is mounted and accessible |
| **GitHub** | Access to GitHub repositories and packages via the GitHub App | Configure an agent token under **Connected Services > GitHub** |

## Advanced Settings

The **Advanced Settings** card displays environment-variable-only configuration that controls the assistant's behaviour. These values are read-only in the UI.

| Setting | Environment Variable | Values | Default |
|---------|---------------------|--------|---------|
| **Thinking Mode** | `AGENT_THINKING` | `adaptive`, `enabled`, `disabled` | `adaptive` |
| **Effort Level** | `AGENT_EFFORT` | `low`, `medium`, `high`, `max` | `medium` |
| **Max Turns** | `AGENT_MAX_TURNS` | Any positive integer | `20` |

To change these values, set the corresponding environment variable and restart the server.

## What to Watch Out For

- **Removing the API key disables the assistant immediately** — any in-progress AI features will stop working.
- **Environment-variable settings take priority** over database values. If both are set, the environment variable wins and the UI field becomes read-only.
- **API key validation uses a small test request** to Anthropic. This consumes a minimal amount of your API quota.
- **The assistant requires `settings:read` permission** to view this page and `settings:write` to make changes. If buttons are disabled, check your API key permissions.
