---
title: Connecting your app to NATS
description: Step-by-step guide for declaring NATS roles and signers in a stack template and consuming them from your application code.
tags:
  - nats
  - messaging
  - applications
  - integration
  - templates
---

# Connecting your app to NATS

This guide shows what to add to a stack template so your service gets NATS credentials at runtime, plus the minimum client code to publish and subscribe.

If you haven't yet, skim the [overview](/nats/overview) first to understand prefixes, roles, and signers.

## Step 1 --- Declare a role

A **role** is a named bundle of subject permissions. Add a `nats.roles[]` entry for each distinct permission set your stack needs (typically one per service).

```json
{
  "nats": {
    "roles": [
      {
        "name": "worker",
        "publish": ["jobs.completed"],
        "subscribe": ["jobs.queued"]
      }
    ]
  }
}
```

Subject patterns are written **relative to your stack's subject prefix** (default `app.<stack-id>`). So a worker that subscribes to `jobs.queued` will actually subscribe to `app.<stack-id>.jobs.queued` on the wire — the orchestrator prepends the prefix.

Wildcards (`*` and `>`) work the same as regular NATS, e.g. `events.*` matches one token, `events.>` matches one or more.

### Role fields

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | yes | --- | Identifier; referenced from `services[].natsRole`. |
| `publish` | no | `[]` | Subject patterns this role can publish to (relative to prefix). |
| `subscribe` | no | `[]` | Subject patterns this role can subscribe to (relative to prefix). |
| `inboxAuto` | no | `both` | Whether `_INBOX.>` is auto-injected for request/reply: `both`, `request`, `reply`, or `none`. |
| `ttlSeconds` | no | `3600` | TTL (seconds) of the minted credential JWT. |

## Step 2 --- Bind a service to the role

In `services[]`, set `natsRole` to the role name and add the standard NATS env vars to the service's `dynamicEnv`:

```json
{
  "services": [
    {
      "serviceName": "worker",
      "natsRole": "worker",
      "containerConfig": {
        "image": "ghcr.io/example/worker:1.0.0",
        "dynamicEnv": {
          "NATS_URL": { "kind": "nats-url" },
          "NATS_CREDS": { "kind": "nats-creds" }
        }
      }
    }
  ]
}
```

At apply time, the orchestrator:

1. Mints a NATS credential JWT for the role.
2. Resolves `NATS_URL` to the cluster URL reachable from the service's network.
3. Writes the JWT to `NATS_CREDS` as a multi-line credentials file.

The values appear as plain environment variables to your container --- no SDK calls or AppRole flow needed for the connect itself.

## Step 3 --- Connect from your app

Most NATS clients accept a credentials file via `nats.credsAuthenticator` or an equivalent option. Two examples:

### Node.js (`nats.js`)

```ts
import { connect, credsAuthenticator } from 'nats';

const nc = await connect({
  servers: process.env.NATS_URL,
  authenticator: credsAuthenticator(new TextEncoder().encode(process.env.NATS_CREDS!)),
});

// Publish (the prefix is invisible to your code; permissions are enforced server-side)
nc.publish('jobs.completed', new TextEncoder().encode(JSON.stringify({ id: 'abc' })));

// Subscribe
const sub = nc.subscribe('jobs.queued');
for await (const msg of sub) {
  console.log('got job:', new TextDecoder().decode(msg.data));
}
```

> **Wait — don't I need to publish to `app.<stack-id>.jobs.completed`?** Yes, on the wire. But the credential JWT pins your client into the prefixed namespace, so your code uses the unprefixed name and the server rewrites/enforces. In practice you publish and subscribe by the relative subject everywhere.

Actually that's a half-truth: NATS does **not** rewrite subjects. Your code must use the *full* subject including the prefix. Read [the prefix gotcha](#the-prefix-gotcha) below before you ship.

### Go (`nats.go`)

```go
nc, err := nats.Connect(
  os.Getenv("NATS_URL"),
  nats.UserCredentials(writeTempCreds(os.Getenv("NATS_CREDS"))),
)
```

(`writeTempCreds` writes the env var to a temp file because the Go client expects a path.)

## The prefix gotcha

Subject patterns in `roles[].publish` / `subscribe` are **relative** to the stack's subject prefix. Your **client code is not**. So if your prefix is `app.cm0xyz` and your role allows `jobs.queued`, your subscribe call must be:

```ts
nc.subscribe('app.cm0xyz.jobs.queued');
```

The simplest pattern: read the prefix from an env var and prepend it in code.

```json
"dynamicEnv": {
  "NATS_URL": { "kind": "nats-url" },
  "NATS_CREDS": { "kind": "nats-creds" },
  "NATS_SUBJECT_PREFIX": { "value": "app.cm0xyz" }
}
```

Then:

```ts
const sub = nc.subscribe(`${process.env.NATS_SUBJECT_PREFIX}.jobs.queued`);
```

If you'd like a stable, human-readable prefix (e.g. `myapp` instead of `app.cm0xyz`), ask an admin to add an entry to the [prefix allowlist](/nats/cross-stack-sharing#subject-prefix-allowlist).

## Step 4 (optional) --- Add a signer for in-process JWT minting

A **signer** lets your service mint its own short-lived NATS JWTs --- useful for an agent gateway that hands one-shot credentials to per-user worker jobs. The server constrains anything signed with this key to the declared sub-tree, so a leaked seed cannot escape its scope.

```json
{
  "nats": {
    "roles": [{ "name": "gateway", "publish": ["agent.>"], "subscribe": ["agent.>"] }],
    "signers": [
      { "name": "worker-minter", "subjectScope": "agent.worker" }
    ]
  },
  "services": [
    {
      "serviceName": "gateway",
      "natsRole": "gateway",
      "natsSigner": "worker-minter",
      "containerConfig": {
        "dynamicEnv": {
          "NATS_URL": { "kind": "nats-url" },
          "NATS_CREDS": { "kind": "nats-creds" },
          "NATS_SIGNER_SEED": { "kind": "nats-signer-seed", "signer": "worker-minter" },
          "NATS_ACCOUNT_PUB": { "kind": "nats-account-public", "signer": "worker-minter" }
        }
      }
    }
  ]
}
```

At apply time, the seed is read from Vault KV at `shared/nats-signers/<stackId>-worker-minter` and injected into the container as `NATS_SIGNER_SEED` (NKey, base32). The matching account public key lands in `NATS_ACCOUNT_PUB` --- you need it as the `issuer_account` claim when minting JWTs (see below). Your service uses any standard nkeys library to mint user JWTs whose `pub`/`sub` permissions are *subsets* of `<prefix>.agent.worker.>`.

### Minting JWTs in-process

```ts
import { encodeUser, fmtCreds } from "nats-jwt";
import { createUser, fromSeed } from "nkeys.js";

const signerKp = fromSeed(new TextEncoder().encode(process.env.NATS_SIGNER_SEED!));
const accountPub = process.env.NATS_ACCOUNT_PUB!;

const userKp = createUser();
const userJwt = await encodeUser(
  "worker-job-42",
  userKp,
  signerKp,
  { issuer_account: accountPub }, // required when signing with a scoped key
  { exp: Math.floor(Date.now() / 1000) + 60, scopedUser: true },
);
const creds = new TextDecoder().decode(fmtCreds(userJwt, userKp));
// hand `creds` to the worker; the server trims its permissions to the scope envelope.
```

### Signer fields

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | yes | --- | Identifier; referenced from `services[].natsSigner` and from `nats-signer-seed` / `nats-account-public` dynamicEnv entries. |
| `subjectScope` | yes | --- | Sub-tree (relative to prefix) the signing key is constrained to. NATS-enforced. |
| `maxTtlSeconds` | no | `3600` | Hard cap on TTL of any JWT the signer can mint. |

## Putting it all together

A minimal complete example:

```json
{
  "nats": {
    "roles": [
      {
        "name": "api",
        "publish": ["events.created", "events.updated"],
        "subscribe": ["commands.>"]
      }
    ]
  },
  "services": [
    {
      "serviceName": "api",
      "natsRole": "api",
      "containerConfig": {
        "image": "ghcr.io/example/api:1.0.0",
        "dynamicEnv": {
          "NATS_URL": { "kind": "nats-url" },
          "NATS_CREDS": { "kind": "nats-creds" },
          "NATS_SUBJECT_PREFIX": { "value": "app.{{stack.id}}" }
        }
      }
    }
  ]
}
```

Apply, and your `api` container boots with everything it needs to talk to NATS.

## What to watch out for

- **`nats-creds` is a multi-line file's *contents*, not a path.** Most clients want either a path or the bytes — use whichever your client supports.
- **Subjects in role declarations are relative; your client code is absolute.** Read `NATS_SUBJECT_PREFIX` in your app and prepend it explicitly. Forgetting this is the #1 source of "permissions violation" errors.
- **`inboxAuto` matters for RPC.** Default `'both'` is right for most services. Pick `'reply'` for pure responders and `'request'` for pure requesters if you want tighter permissions.
- **Re-apply after editing roles.** Subject permission changes take effect when the orchestrator re-mints the credential. Container restarts alone don't pick up new permissions.
- **TTL = grant lifetime, not connection lifetime.** A connected client keeps its session even after the cred TTL expires (until it disconnects). Re-apply for new TTLs to take hold for fresh connections.
