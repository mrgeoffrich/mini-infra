---
title: Authentication Configuration
description: How to configure authentication methods including Google OAuth in Mini Infra.
tags:
  - settings
  - authentication
  - google-oauth
  - administration
---

# Authentication Configuration

The **Authentication** settings page controls how users can sign in to Mini Infra. Password authentication is always enabled and cannot be turned off. You can optionally also allow users to sign in with their Google account via OAuth.

## Password Authentication

Password-based login is always available. Users authenticate with their email and password set on the [Users](/settings-users) page. There are no settings to configure for password authentication.

## Enabling Google OAuth

Google OAuth lets users sign in with an existing Google account instead of a separate password. Enabling it requires creating OAuth credentials in the Google Cloud Console.

### Step 1 — Create Google OAuth credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Create a new **OAuth 2.0 Client ID** of type **Web application**.
3. Under **Authorized redirect URIs**, add:
   ```
   https://your-mini-infra-host/auth/google/callback
   ```
   Replace `your-mini-infra-host` with your actual domain or IP address.
4. Copy the **Client ID** and **Client Secret**.

### Step 2 — Configure in Mini Infra

1. Navigate to **Administration → Authentication**.
2. Toggle **Google OAuth** on.
3. Enter the **Google Client ID** you copied from the Google Cloud Console.
4. Enter the **Google Client Secret**. If a secret is already configured, leave the field blank to keep the existing one.
5. Click **Save Changes**.

Once saved, a **Sign in with Google** button appears on the login page.

## Updating OAuth Credentials

To update the **Client ID**, enter the new value and click **Save Changes**.

To rotate the **Client Secret**, enter the new secret value and save. If you leave the secret field blank, the existing stored secret is kept unchanged.

## Disabling Google OAuth

Toggle **Google OAuth** off and click **Save Changes**. Users who previously signed in via Google will need to use password authentication going forward. If they do not have a password set, an administrator must create one via the [Users](/settings-users) page.

## What to watch out for

- **Redirect URI must match exactly.** Google rejects OAuth requests if the redirect URI in the request does not match what is registered in the Cloud Console. Include the correct protocol (`https://`) and port if non-standard.
- **Client Secret is stored encrypted.** Mini Infra stores the Google Client Secret encrypted in its database, not in plain text. The UI never exposes the stored secret back to you.
- **Disabling OAuth does not delete Google-linked accounts.** Existing accounts that were created via Google OAuth remain in the system but can no longer log in via Google. You may need to reset their password via the Users page to restore access.
