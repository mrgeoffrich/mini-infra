# Vault Auth — OIDC / JWT federation (deferred)

Deferred from the main SecretsVault design. The Vault feature ships first using OpenBao's built-in userpass/token flows and the root/AppRole tokens minted by mini-infra. This plan covers bringing mini-infra's user identity into Vault so operators can open the Vault UI already logged in as themselves.

## Goal

When a mini-infra user clicks "Open Vault UI", they land in OpenBao authenticated as themselves with a short-lived token bound to a policy derived from their mini-infra role.

## Staged approach

### Stage 1 — Vault JWT auth method (MVP)

Smallest path to federated identity. No full OIDC provider required.

- Mini-infra exposes `/.well-known/jwks.json` serving the public half of a signing key (RS256 or EdDSA). Key generated at boot, rotated on a schedule, stored encrypted alongside other platform secrets.
- New endpoint `POST /api/vault/login` mints a short-lived signed JWT for the current session:
  - `sub` = mini-infra user id
  - `email` = user email
  - `groups` = mini-infra roles (admin / editor / reader)
  - `aud` = `"mini-infra-vault"`
  - `exp` = now + 60s
- OpenBao configured once (during vault bootstrap) with the JWT auth method pointing at mini-infra's JWKS URL. One Vault role per mini-infra role group, each bound to a matching policy.
- UI: "Open Vault UI" button → calls `/api/vault/login` → POSTs the JWT to Vault's `/v1/auth/jwt/login` → stores the returned client token in the Vault UI's local storage → opens the UI.

### Stage 2 — Full OIDC provider (later)

Only if external consumers need to federate against mini-infra. Adds:
- Discovery document at `/.well-known/openid-configuration`
- Authorization code flow (`/authorize`, `/token`)
- Consent screen
- Client registration (DB-backed)

Meaningful scope — at least a 1–2 week job on top of stage 1. Defer until a second consumer exists.

### Stage 3 — External IdP passthrough (optional)

For teams that already have an IdP (Google / GitHub / Entra). Configure OpenBao's OIDC auth method directly against the external IdP and skip mini-infra entirely for the identity leg. Mini-infra stores the IdP config via the existing `ConfigurationServiceFactory` pattern.

## Open questions

- Role mapping — flat (mini-infra admin → vault admin) or configurable (admins can edit role-to-policy mapping in UI)?
- JWKS key rotation cadence — 30 days with 60-day retention of the previous key?
- Does "Open Vault UI" deep-link through Cloudflare tunnel, or is Vault's UI only reachable on the local network?
