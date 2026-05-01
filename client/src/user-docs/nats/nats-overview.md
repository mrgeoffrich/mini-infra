---
title: NATS for App Developers
description: What the built-in NATS message bus offers app authors and how stacks plug into it.
tags:
  - nats
  - messaging
  - jetstream
  - applications
  - integration
---

# NATS for App Developers

Mini Infra ships a managed NATS cluster (with JetStream) as a shared message bus. Any stack can publish and subscribe to it without standing up its own broker — credentials, subject scoping, and connection details are wired in automatically when you declare the dependency in your stack template.

This page is for app authors writing or reviewing a template. For administrative tasks (running the NATS stack, viewing accounts, managing the prefix allowlist), see the Settings → NATS area in the dashboard.

## What you get

- A cluster URL and a per-stack credential JWT, injected into your container as environment variables.
- Subject-level publish/subscribe permissions enforced by the NATS server — your app can only touch the subjects you declared.
- Automatic subject namespacing: every publish/subscribe is silently prefixed so two unrelated stacks never collide.
- Optional **signers** for apps that need to mint short-lived per-user JWTs in process (e.g. an agent gateway handing scoped credentials to workers).
- Optional **exports/imports** for cross-stack messaging without sharing credentials.

## Key concepts

- **Subject prefix** --- A dotted namespace prepended to every publish/subscribe subject for your stack. Defaults to `app.{{stack.id}}`, which is unique and collision-free. Custom prefixes are allowed only when an admin has added an entry to the [prefix allowlist](/nats/cross-stack-sharing#subject-prefix-allowlist).
- **Role** --- A named set of publish and subscribe permissions, scoped to subjects under your stack's prefix. Each role materializes into a credential profile (a NATS JWT) at apply time. Bind a service to a role and it gets `NATS_URL` + `NATS_CREDS` injected.
- **Signer** --- A scoped signing key your service uses to mint downstream user JWTs in-process. Constrained server-side to a sub-tree of subjects you declare (so a leaked signer cannot escape its scope). Bind a service to a signer and it gets `NATS_SIGNER_SEED` injected.
- **Export** --- A subject (under your prefix) that you publicly publish for other stacks in the same environment to consume.
- **Import** --- A subject from another stack's exports that you want one of your roles to subscribe to. Resolved at apply time against the producer's last-applied snapshot.
- **`_INBOX.>` auto-injection** --- NATS request/reply uses ephemeral `_INBOX.<id>` subjects. Roles auto-inject the necessary `_INBOX.>` permissions; you can override the default via `inboxAuto`.

## How it fits together

```
┌─────────────────────────┐
│ Stack template          │
│   nats:                 │
│     roles: [gateway]    │      ┌─────────────────────────┐
│     signers: [minter]   │ ───▶ │ Apply orchestrator      │
│   services:             │      │  - mints credential JWT │
│     - natsRole: gateway │      │  - writes signer seed   │
│       natsSigner:minter │      │  - resolves imports     │
└─────────────────────────┘      └────────────┬────────────┘
                                              │
                                              ▼
                                  ┌─────────────────────────┐
                                  │ Container at start      │
                                  │  NATS_URL=nats://...    │
                                  │  NATS_CREDS=<jwt>       │
                                  │  NATS_SIGNER_SEED=<nk>  │
                                  └─────────────────────────┘
```

## When to reach for NATS

| You want to… | Use this |
|---|---|
| Fan out events between services in one stack | A single role with `publish` and `subscribe` |
| Do request/reply RPC | A role (default `inboxAuto: 'both'` covers it) |
| Stream events from one stack to another | `exports` on the producer + `imports` on the consumer |
| Hand short-lived per-user tokens to workers | A signer with a scoped `subjectScope` |
| Use durable JetStream streams/consumers | The advanced `accounts` / `streams` / `consumers` surface (system-template territory — talk to an admin) |

## Next steps

- [Connecting your app to NATS](/nats/app-integration) --- declare a role, wire the env vars, write client code.
- [Sharing subjects across stacks](/nats/cross-stack-sharing) --- exports, imports, and the prefix allowlist.
- [Using Vault from your app](/vault/app-integration) --- the companion guide for secrets.

## What to watch out for

- **Subject patterns are relative to your prefix.** Write `events.in`, not `app.<stackId>.events.in`. The orchestrator prepends the prefix server-side.
- **Apps cannot mix the role surface with raw `accounts` / `credentials`.** Templates that try to use both are rejected at validation time. The role/signer surface is for apps; the low-level surface is for system templates.
- **Imports resolve against the producer's *last applied* snapshot.** If the producer renamed an export but hasn't applied yet, your import will still resolve to the old name. Re-apply the producer first.
- **Credentials are minted at apply time.** If your app rotates secrets out from under itself or the NATS account JWT changes, you need to re-apply the consumer stack to pick up new credentials.
