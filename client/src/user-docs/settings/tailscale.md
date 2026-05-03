---
title: Tailscale
description: How to connect Mini Infra to a Tailscale tailnet so it can mint authkeys and expose addon-attached services on your tailnet.
tags:
  - settings
  - tailscale
  - connectivity
  - oauth
  - acl
---

# Tailscale

The **Tailscale** page at [/connectivity-tailscale](/connectivity-tailscale) configures the OAuth client Mini Infra uses to mint short-lived, ephemeral authkeys against your tailnet.

Once configured, the Service Addons framework can attach Tailscale sidecars (`tailscale-ssh`, `tailscale-web`) to any stack service, making the workload reachable on your tailnet without exposing host ports.

## Prerequisites

Setting up Tailscale is a four-step handoff between Tailscale's admin console and Mini Infra. Steps 1–3 happen in Tailscale; step 4 happens in Mini Infra.

### 1. Create the OAuth client

Sign in to [login.tailscale.com/admin/settings/oauth](https://login.tailscale.com/admin/settings/oauth) as a tailnet **Owner** or **Admin** and create a new OAuth client with these scopes:

| Scope | Mode | Why |
|-------|------|-----|
| `auth_keys` | write | Mint authkeys for new tailnet nodes |
| `devices:core` | write | Manage device attributes (required for Tailscale SSH in Phase 3) |

Tailscale shows the **client secret only once** at creation — copy it before navigating away.

### 2. Assign `tag:mini-infra-managed` to the OAuth client

OAuth clients can only mint authkeys with tags they themselves own. While editing the OAuth client in Tailscale's admin console, add the tag `tag:mini-infra-managed` to the **Tags** field.

If you skip this step, Mini Infra's first authkey mint returns HTTP 403 and the connectivity card flips red with the message "OAuth client doesn't own the tag."

### 3. Paste the ACL bootstrap snippet into your tailnet policy

Open the **Tags** section on the Mini Infra Tailscale settings page. The page renders a JSON snippet under **2. Bootstrap ACL snippet**. Click **Copy**, then paste it into your tailnet policy at [login.tailscale.com/admin/acls](https://login.tailscale.com/admin/acls) and save.

The snippet declares:

| Stanza | What it does |
|--------|--------------|
| `tagOwners` | Grants tailnet admins ownership of `tag:mini-infra-managed` (and any extras you add) |
| `grants` | Allows tailnet members to reach devices carrying the managed tags on any port |
| `ssh` | Enables Tailscale SSH (`action: check`) into managed devices, with a 12-hour re-check window |

The `ssh` stanza is what the Phase 3 `tailscale-ssh` addon needs — without it, SSH connections will be rejected by your ACL.

### 4. Paste OAuth credentials into Mini Infra

Back in Mini Infra at [/connectivity-tailscale](/connectivity-tailscale), under **3. OAuth credentials**:

| Field | Description |
|-------|-------------|
| **Client ID** | Public identifier of your Tailscale OAuth client (e.g. `kXXXXXXCNTRL`) |
| **Client secret** | The secret Tailscale showed you once at creation |

Click **Validate & Save**. Mini Infra exchanges the credentials for an access token, mints a 60-second probe authkey to confirm tag ownership, then stores the credentials encrypted at rest.

## Tag list

| Default tag | Why |
|-------------|-----|
| `tag:mini-infra-managed` | Pinned — Mini Infra mints every authkey with this tag so addons can target it in ACLs. Cannot be removed. |

You can add **extra tags** if you want every minted authkey to carry additional tags (for example, environment-specific tags like `tag:prod` or `tag:lab`). Extras must match the regex `tag:[a-z0-9-]+`.

Editing the tag list affects **future** tailnet devices only — existing devices keep their original tag set until they are re-applied. The bootstrap ACL snippet automatically re-renders so you can copy the updated version into your tailnet policy.

## Rotating the client secret

Tailscale client secrets don't expire, but rotate them whenever:

- A team member with access leaves the project.
- You suspect the secret has been exposed (e.g. leaked into a screen share or commit).
- You're on a regular credential-rotation schedule.

To rotate:

1. Create a new OAuth client at Tailscale (or rotate the secret on the existing one).
2. Paste the new client ID + secret into the Mini Infra form.
3. Click **Validate & Save**.

Existing tailnet devices keep working — their authkeys were already consumed at registration time and are not tied to the OAuth client's lifecycle.

## Connectivity status

Once configured, the Tailscale entry appears on the [Connected Services dashboard](/dashboard) with a status pill:

| Status | Meaning |
|--------|---------|
| **Connected** | Mini Infra successfully minted an OAuth access token within the last 5 minutes. |
| **Failed** | The most recent OAuth token mint or tag-ownership probe returned an error. Click into the page to see the error category. |
| **Unreachable** | Mini Infra couldn't reach `api.tailscale.com` — check your network or Tailscale's status page. |
| **Timeout** | The OAuth call took more than 15 seconds. Usually a transient network issue. |

The connectivity scheduler re-validates Tailscale credentials every 5 minutes, so a transient failure typically self-resolves on the next cycle.

## Troubleshooting

### "Tailscale rejected these credentials"

The OAuth client ID or secret is wrong, or the OAuth client doesn't have the required scopes (`auth_keys` write + `devices:core` write). Recheck both values and the scopes in Tailscale's admin console.

### "OAuth client doesn't own the tag"

Step 2 of the prerequisites was skipped. Open [login.tailscale.com/admin/settings/oauth](https://login.tailscale.com/admin/settings/oauth), edit the OAuth client, and assign `tag:mini-infra-managed` (plus any extras you added in Mini Infra) to it.

### "Couldn't reach Tailscale"

The Mini Infra host can't reach `api.tailscale.com`. If you're running behind an egress firewall or proxy, allow outbound HTTPS to `api.tailscale.com` and `login.tailscale.com`.

## Related

- [Connected Services overview](/dashboard) — health pills for every external integration
- The Service Addons framework consumes Tailscale credentials in later phases to attach `tailscale-ssh` and `tailscale-web` sidecars to stack services.
