# Managed Account + Vendor OAuth

> Design exploration. Not a plan-doc yet — captures the architecture for `id.mininfra.net` (managed accounts) and the recommended pattern for connecting end-user Google / GitHub accounts to a self-hosted Mini Infra instance.

## 1. Problem

Two things hurt today:

1. **Vendor OAuth setup is miserable.** To use Google APIs (Drive, Gmail, Cloud DNS, etc.) or GitHub on behalf of the user, the user currently has to create their own OAuth client in Google Cloud Console / GitHub, configure consent screens, set redirect URIs, and possibly go through verification. For a homelab tool this is a giant friction wall.
2. **Mini Infra has no shared identity.** Each instance has its own local admin. Users running multiple instances re-do setup each time, and there's no way to "sign in" to a fresh instance with an existing identity.

We want to fix both *without* `id.mininfra.net` becoming a permanent custodian of every user's vendor refresh tokens — that's a security and trust posture we don't want.

## 2. Two distinct layers

These often get conflated. Keep them separate:

| Layer | What it answers | Owned by | Mini Infra needs it? |
|-------|-----------------|----------|----------------------|
| **Login identity** | "Who are you?" | the user | optional — local admin works |
| **Vendor connections** | "What can the instance do on your behalf at Google / GitHub / etc.?" | the instance | optional — only for features that need it |

A user can have either, both, or neither. The break-glass local admin keeps working regardless.

## 3. Login identity

### 3.1 Local admin (always present)

Every Mini Infra install has a local admin set up on first boot — username + password. This is the **break-glass account**: it always works even if `id.mininfra.net` is offline forever.

Bind the local-admin login endpoint to private network ranges only (RFC1918 + Tailscale CGNAT `100.64.0.0/10` + loopback). If a user accidentally exposes the instance via a tunnel, only the device-flow handshake (a public, short-lived endpoint) is reachable from the internet — the password endpoint isn't.

Rate-limit + lockout password attempts. Nudge a long random password during setup.

### 3.2 Managed account on `id.mininfra.net` (optional)

A user can opt into a managed account during onboarding — "link a managed account so you can sign in from anywhere without remembering a password". The managed account itself supports linking multiple sign-in methods (Google, GitHub, email + password). Standard "social account linking" pattern.

**Account-collision handling:** if a user signs up with Google as `alice@gmail.com`, then later tries to sign in with GitHub which has `alice@gmail.com` as a verified email, do **not** auto-merge on email — that's a known account-takeover vector if either provider's email verification is weaker than expected. Show "looks like you already have an account, sign in with the original method to link them" instead.

### 3.3 Linking a Mini Infra instance to a managed account

This is the device-flow handshake — works regardless of where the instance lives (`http://mini-infra.lan`, Tailscale IP, `192.168.1.50`, etc.) because no callback URL is needed.

OAuth 2.0 Device Authorization Grant (RFC 8628):

1. Instance calls `POST id.mininfra.net/device/code` → gets `{ device_code, user_code, verification_uri, expires_in, interval }`.
2. Instance shows the user `"Go to id.mininfra.net/link and enter ABCD-1234"`.
3. User opens that URL in any browser, signs in if needed, approves the link.
4. Instance polls `POST id.mininfra.net/oauth/token` with the device code until it gets a session token back.

Same pattern as `gh auth login` and Apple TVs. No inbound port required on the home server.

## 4. Vendor connections (the painful bit, fixed)

This is the layer that replaces "set up your own Google Cloud OAuth app". The pattern is **OAuth 2.0 for Native / Installed Apps with PKCE** — and the key insight is that `id.mininfra.net` is **not in the data path**.

### 4.1 The flow

1. We register **one** OAuth client with Google as `mini-infra` (owned by us, on `mininfra.net`). One-time setup, one-time verification.
2. The `client_id` is baked into the Mini Infra image. PKCE replaces the `client_secret`. Per Google: for native apps "the client secret is not actually a secret" — safe to ship publicly.
3. When the user clicks "Connect Google" in the home server's UI:
   - Home server generates a PKCE `code_verifier` + `code_challenge`.
   - Home server pops a browser to `https://accounts.google.com/o/oauth2/v2/auth?...&code_challenge=...&redirect_uri=http://127.0.0.1:<random-port>`.
   - User consents directly with Google.
   - Google redirects back to `http://127.0.0.1:<random-port>` on the home server (loopback redirects are whitelisted by Google for native apps and don't need per-port pre-registration).
   - Home server exchanges code at `https://oauth2.googleapis.com/token` with `code_verifier`.
   - Home server stores the resulting **refresh token locally**, encrypted at rest.
4. From here, the home server talks directly to Google APIs. `id.mininfra.net` never sees the token.

GitHub is the same shape — GitHub added PKCE support for OAuth and GitHub Apps in July 2025, and supports `http://127.0.0.1:<port>` loopback redirects too.

### 4.2 What `id.mininfra.net` is responsible for

Not much, on this layer:

- Owning the OAuth app registrations with each vendor (Google, GitHub, Cloudflare, …).
- Going through each vendor's verification process **once** per scope set.
- Distributing the bundled `client_id`s with the Mini Infra image (already happens via image release).
- Optionally publishing a "rotation manifest" so we can swap a `client_id` if a vendor revokes one. The home server periodically checks this — same pattern Cloudflare uses for `cloudflared`.

`id.mininfra.net` is **not** in the data path for vendor API calls. It does not see, store, or proxy refresh tokens.

### 4.3 Why this is OK

The threat model:

| Threat | Mitigation |
|--------|------------|
| Attacker extracts `client_id` from the Mini Infra image | Expected — `client_id` is public. PKCE means they can't redeem an auth code without the `code_verifier` from the original session. |
| Attacker steals refresh token from a compromised home server | Same risk as today (existing host secrets, Vault, etc.). Refresh tokens are encrypted at rest, scope-limited, and revocable from the user's Google / GitHub account settings. |
| Mini Infra walks away from the project | Vendor connections keep working until tokens expire / are revoked. New connects break (no one to maintain the OAuth app), but existing instances keep working. Local admin still works forever. |
| `id.mininfra.net` is breached | No vendor tokens to steal. Worst case: managed-account session tokens for users — recoverable by rotating sessions and forcing re-login. |

## 5. Google config

### 5.1 OAuth client registration

In Google Cloud Console under our `mininfra` project:

- **Application type:** Desktop app (this is the magic — switches the client to the native-app flow with loopback redirects allowed).
- **Name:** Mini Infra.
- **Authorized redirect URIs:** none needed — loopback redirects (`http://127.0.0.1:<any-port>` and `http://[::1]:<any-port>`) are implicit for Desktop app type.
- **PKCE:** required client-side, no toggle needed on the Google side.

Endpoints:

- Authorization: `GET https://accounts.google.com/o/oauth2/v2/auth`
- Token exchange: `POST https://oauth2.googleapis.com/token`
- Token revocation: `POST https://oauth2.googleapis.com/revoke`

### 5.2 Consent screen

- **Publishing status:** In production (after verification) — required for use by Google accounts outside our org.
- **User type:** External.
- **App domain:** `mininfra.net`.
- **Authorized domains:** `mininfra.net`.
- **Scopes:** declared upfront. Start with the minimum — request more later if features need them.

### 5.3 Verification

Anything outside the `email` / `profile` / `openid` "non-sensitive" set requires verification:

- **Sensitive scopes** (e.g. `gmail.send`, `drive.file`): Google review, can take a few weeks.
- **Restricted scopes** (e.g. full `gmail` or `drive`): Google review + annual re-verification + a security assessment by a Google-approved third-party assessor (real money, real time).

**Strategy:** stick to non-sensitive + `*.file`-style narrow scopes wherever possible. If we need full Drive / Gmail access for a specific feature, gate that feature behind a "you'll need to set up your own Google Cloud OAuth app for this" escape hatch — same setup we have today, but only for the high-friction scopes, not all of them.

### 5.4 Refresh token quirks

- Google issues refresh tokens **only on first consent** by default. To force re-issuance, include `prompt=consent` and `access_type=offline` in the auth request — we should always include both.
- Limit: 100 refresh tokens per (Google account, client_id) pair. Hit it and the oldest gets silently invalidated. Affects power users running >100 instances.
- Limit per user across all clients also exists (global cap, generous).

## 6. GitHub config

### 6.1 GitHub App, not OAuth App

Use a **GitHub App** rather than an **OAuth App**:

- Fine-grained per-repo permissions instead of "all your repos".
- Short-lived user tokens (8 hours) with 6-month refresh tokens — auto-rotation enabled.
- Installation tokens for org/repo-scoped automation that can act independently of any user.
- GitHub explicitly recommends GitHub Apps over OAuth Apps for new integrations.

OAuth Apps issue tokens that don't expire by default — convenient but a much bigger blast radius if leaked.

### 6.2 Registration

In GitHub under our `mininfra` org:

- **GitHub App name:** Mini Infra.
- **Homepage URL:** `https://mininfra.net`.
- **Callback URL:** `http://127.0.0.1/callback` — GitHub allows the runtime port to differ from the registered port.
- **Request user authorization (OAuth) during installation:** yes, for the user-to-server flow.
- **Expire user authorization tokens:** yes (gives us 8h tokens + 6mo refresh).
- **Webhook URL:** none for now — webhooks would require `id.mininfra.net` to receive them and forward, which is a separate design call.
- **Permissions:** declared upfront, narrow as possible. Start with `contents:read`, `metadata:read`, `pull_requests:read`. Request more when features need them.

### 6.3 Endpoints + flow

- Authorization: `GET https://github.com/login/oauth/authorize` with `client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`.
- Token exchange: `POST https://github.com/login/oauth/access_token` with `code` + `code_verifier`.
- Refresh: `POST https://github.com/login/oauth/access_token` with `grant_type=refresh_token`.

PKCE applies to the authorization-code flow only — **not** to device flow or installation tokens. For the home-server-talks-to-GitHub case, the authorization-code-with-PKCE flow is what we want.

### 6.4 Limits

- 10 user tokens per (user, app, scope) — older ones invalidated when exceeded.
- 10 token-creation calls per hour per user/app.
- Device flow: 50 verification submissions per hour per app (irrelevant here, we're using auth-code).

## 7. Onboarding flow

After local admin login on first boot:

```
1. "Welcome — let's get a few optional things connected."

2. "Sign-in convenience"
   [ ] Link a managed account on id.mininfra.net so you can sign in
       from anywhere without remembering a password.
       (Skip — the local admin password keeps working.)

3. "Vendor connections (one-click setup)"
   [ ] Connect Google     — for Gmail / Drive / Cloud DNS features
   [ ] Connect GitHub     — to deploy from your repos
   [ ] Connect Cloudflare — for DNS + tunnels
       (Each is independent. You can do these later from Settings.)

4. [ Done ]
```

Each "Connect X" launches the PKCE dance described in §4. None of them require Google Cloud / GitHub setup on the user's side — the OAuth apps are ours.

## 8. Trust model summary

```
                     ┌──────────────────────┐
                     │   id.mininfra.net    │
                     │                      │
                     │  • Managed accounts  │
                     │  • Owns vendor       │
                     │    OAuth app regos   │
                     │  • Device-flow link  │
                     │    handshake         │
                     │                      │
                     │  Holds: session      │
                     │    tokens for users  │
                     │  Does NOT hold:      │
                     │    vendor refresh    │
                     │    tokens            │
                     └──────────┬───────────┘
                                │ identity only
                                │
                ┌───────────────┴───────────────┐
                │                               │
       ┌────────▼─────────┐            ┌────────▼─────────┐
       │  Mini Infra A    │            │  Mini Infra B    │
       │  (homelab)       │            │  (laptop)        │
       │                  │            │                  │
       │  Holds: vendor   │            │  Holds: vendor   │
       │    refresh tokens│            │    refresh tokens│
       │    (encrypted)   │            │    (encrypted)   │
       │  Local admin     │            │  Local admin     │
       │    fallback      │            │    fallback      │
       └────────┬─────────┘            └────────┬─────────┘
                │                               │
                │  Direct API calls             │  Direct API calls
                │  (PKCE-issued tokens)         │  (PKCE-issued tokens)
                │                               │
                ▼                               ▼
       ┌──────────────────────────────────────────────┐
       │  Google APIs / GitHub APIs / Cloudflare API  │
       └──────────────────────────────────────────────┘
```

Two instances of Mini Infra under the same managed account each do their own one-click vendor connect. `id.mininfra.net` brokers the *identity*, not the vendor data.

## 9. Open questions

- **Multi-user instances.** Mini Infra today is single-admin. If we ever support multiple users on one instance, vendor connections need to be either per-user or explicitly shared. Defer until needed.
- **Revoking a managed account.** When a user removes their managed-account link from a Mini Infra instance, do we also revoke the vendor connections? Probably no — vendor connections are instance-scoped, not identity-scoped. Worth surfacing in the UI.
- **Webhook delivery.** GitHub/Cloudflare webhooks need a public endpoint. Either `id.mininfra.net` proxies them down to the home server (puts us back in the data path) or we use vendor-side polling (worse UX). Defer until we need webhook-driven features.
- **Vendor app dies / `client_id` rotated.** Existing connections survive until refresh-token expiry. New connects fail. Need a `rotation manifest` endpoint on `id.mininfra.net` that home servers periodically check.
- **`prompt=consent` UX.** We're forcing it on every connect to guarantee a refresh token. Means the user sees the consent screen every time, even for re-connects. Tolerable, but worth confirming.

## 10. References

- [OAuth 2.0 for iOS & Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app) — Google native-app flow, PKCE, loopback redirects, refresh-token quirks
- [OAuth 2.0 Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) — Google verification process
- [OAuth 2.0 Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) — annual re-verification + third-party security assessment
- [Authorizing OAuth apps — GitHub](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) — endpoints, PKCE params, loopback redirects, token limits
- [PKCE support for OAuth and GitHub App authentication (July 2025)](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/) — recent PKCE support announcement
- [OAuth 2.0 Device Authorization Grant — RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) — the device-flow link handshake
- [OAuth 2.0 PKCE — RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636) — the public-client security mechanism
- [Auth0 Token Vault](https://auth0.com/docs/secure/tokens/token-vault) — for contrast: the broker-holds-tokens model we're explicitly *not* using
