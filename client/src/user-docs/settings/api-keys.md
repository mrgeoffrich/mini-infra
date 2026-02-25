---
title: API Keys
description: Creating, managing, rotating, and revoking API keys for programmatic access.
category: Settings
order: 2
tags:
  - api-keys
  - authentication
  - security
  - administration
---

# API Keys

API keys provide programmatic access to Mini Infra's API. Use them in scripts, CI/CD pipelines, or external tools that need to interact with Mini Infra without a browser session.

## Creating a key

Navigate to **API Keys** under Administration. Click **Create API Key** and enter a descriptive name (e.g. "CI Pipeline" or "Monitoring Script").

After creation, the full key is displayed once in a dialog. Copy it immediately. The key is hashed before storage, so Mini Infra cannot show it again.

Keys follow the format `mk_` followed by 64 hexadecimal characters.

## Using a key

Include the key in HTTP requests using either header format:

```
Authorization: Bearer mk_your_key_here
```

or:

```
x-api-key: mk_your_key_here
```

The key authenticates the request with the same access level as a logged-in user.

## The API Keys page

The page shows a statistics summary at the top: total keys, active keys, and when any key was last used.

The table lists each key with:

| Column | What it shows |
|--------|--------------|
| **Name** | The descriptive name you gave the key |
| **Key Prefix** | The first few characters (`mk_xxxx...`) for identification |
| **Status** | Active or Revoked |
| **Created** | When the key was created |
| **Last Used** | When the key last authenticated a request |

## Rotating a key

Click **Rotate** on a key to generate a new key value. The old key continues to work for a grace period, giving you time to update scripts and configurations that use it. After the grace period, only the new key works.

Rotation history is tracked — you can see when a key was last rotated.

## Revoking a key

Click **Revoke** to disable a key. Revoked keys cannot authenticate requests. The key record is preserved in the table with a "Revoked" status for audit purposes.

Revocation is immediate and irreversible. If you revoke a key by accident, create a new one.

## Deleting a key

Click **Delete** to permanently remove a key from the system. Unlike revocation, this removes the key entirely — it won't appear in the table.

## What to watch out for

- Keys provide full API access. Don't commit them to version control or share them in plain text.
- The "Last Used" timestamp updates on each API request. Use it to identify unused keys that should be cleaned up.
- If the API Key Secret is regenerated in Security settings, all existing keys stop working. New keys must be created.
- There's no limit on the number of keys you can create, but each active key is a credential that needs to be managed. Create keys for specific purposes and revoke them when no longer needed.
