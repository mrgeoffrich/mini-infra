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
| `ttlSeconds` | no | `3600` | TTL (seconds) of the minted credential JWT. **Set to `0` to mint a non-expiring JWT — the canonical pattern for long-running services.** The default of `3600` only suits short-lived containers (jobs, batch tasks). See the warning at the end of Step 2. |

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

> **⚠ `NATS_CREDS` is minted once at apply time and never refreshed.** Whatever `ttlSeconds` the role is configured with becomes the JWT's `exp`. When `exp` passes, NATS closes the connection and rejects every reconnect attempt until the container is restarted or the stack re-applied. The default of `3600` is suitable only for one-shot containers (jobs, init containers, batch tasks) whose lifetime is shorter than the TTL.
>
> **For long-running services, set `ttlSeconds: 0` on the role:**
>
> ```json
> { "name": "worker", "publish": [...], "subscribe": [...], "ttlSeconds": 0 }
> ```
>
> That mints a non-expiring JWT — the canonical NATS pattern for service-owned connections. Revocation is via the account's revocations list rather than expiry. **No app-side code changes needed.** Re-apply + restart the container if you ever change the role's permissions, since the cred is static once minted.

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

> **The example above is incomplete — your client code must use the *absolute* subject (prefix-included), not the relative one from the role declaration.** NATS does not rewrite subjects on the server; the role's prefix-relative form is just how mini-infra renders the permission allowlist. Read [the prefix gotcha](#the-prefix-gotcha) below for the corrected pattern before you ship.

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

## Step 4 (optional) --- Mint ephemeral per-tenant creds with a signer

> **This is for the case where your service mints creds for *other* clients** — typically a manager/gateway that hands per-user, per-tenant, or per-job creds to downstream workers (the slackbot's worker-pool pattern is the canonical example). For the service's own NATS connection, use `ttlSeconds: 0` from Step 2 instead — that's the canonical NATS pattern for service-owned connections and needs no app-side code changes.

A **signer** is a scoped NKey on your stack's NATS account. Your service holds the seed and uses it to mint user JWTs in-process. The server cryptographically constrains anything signed with the key to the declared subject sub-tree, so a leaked seed cannot escape its scope --- which is what makes it safe to hand the seed to your service.

```json
{
  "nats": {
    "roles": [{ "name": "gateway", "publish": ["agent.>"], "subscribe": ["agent.>"], "ttlSeconds": 0 }],
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

At apply time, the seed is read from Vault KV at `shared/nats-signers/<stackId>-worker-minter` and injected into the container as `NATS_SIGNER_SEED` (NKey, base32). The matching account public key lands in `NATS_ACCOUNT_PUB` --- you need it as the `issuer_account` claim when minting JWTs. Your service uses any standard nkeys library to mint user JWTs whose `pub`/`sub` permissions are *subsets* of `<prefix>.agent.worker.>`.

The seed itself never expires; the user JWTs you mint with it are short-lived and disposable. Hand them to per-tenant clients; the server enforces the scope envelope cryptographically.

### Minting a per-tenant cred

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

### Advanced: fast permission propagation via authenticator callback

> **Niche.** Skip this unless you have a specific need: `ttlSeconds: 0` from Step 2 covers the long-running-service case, and the "mint a cred for a downstream worker" pattern above covers the per-tenant case.

If you want a long-running service to pick up new role permissions **without restarting the container**, you can replace its static `nats-creds` with the signer pattern wired through your NATS client's authenticator callback. The callback fires on every (re)connect, so re-applying the stack (which updates the signer's scope template via `$SYS.REQ.CLAIMS.UPDATE`) makes the next reconnect pick up new permissions automatically.

This adds app-side complexity and an extra NATS round-trip per reconnect; it's not the recommended default. Use it only when restart-on-permission-change is genuinely a problem.

#### Node.js (`nats.js`)

```ts
import { connect, jwtAuthenticator } from "nats";
import { encodeUser } from "nats-jwt";
import { createUser, fromSeed } from "nkeys.js";

const signerKp = fromSeed(new TextEncoder().encode(process.env.NATS_SIGNER_SEED!));
const accountPub = process.env.NATS_ACCOUNT_PUB!;

// Stable user nkey for the lifetime of the process. The user JWT we mint
// below is short-lived; the user nkey is not.
const userKp = createUser();
const userPub = userKp.getPublicKey();
const userSeed = userKp.getSeed();

async function mintFreshUserJwt(): Promise<string> {
  return await encodeUser(
    userPub,
    userKp,
    signerKp,
    { issuer_account: accountPub },
    { exp: Math.floor(Date.now() / 1000) + 600, scopedUser: true },
  );
}

const nc = await connect({
  servers: process.env.NATS_URL!,
  // jwtAuthenticator accepts a function for the JWT — called on every
  // (re)connect, so the JWT is always freshly minted.
  authenticator: jwtAuthenticator(() => mintFreshUserJwt(), userSeed),
  reconnect: true,
  maxReconnectAttempts: -1,
});
```

#### Go (`nats.go`)

```go
import (
  "github.com/nats-io/nats.go"
  "github.com/nats-io/nkeys"
  jwtv2 "github.com/nats-io/jwt/v2"
)

signerKp, _ := nkeys.FromSeed([]byte(os.Getenv("NATS_SIGNER_SEED")))
accountPub := os.Getenv("NATS_ACCOUNT_PUB")

userKp, _ := nkeys.CreateUser()
userPub, _ := userKp.PublicKey()

mintJwt := func() (string, error) {
  uc := jwtv2.NewUserClaims(userPub)
  uc.IssuerAccount = accountPub
  uc.Expires = time.Now().Add(10 * time.Minute).Unix()
  return uc.Encode(signerKp) // signed with the scoped signer
}

signCB := func(nonce []byte) ([]byte, error) { return userKp.Sign(nonce) }

nc, err := nats.Connect(
  os.Getenv("NATS_URL"),
  // UserJWT's first arg is called on every (re)connect.
  nats.UserJWT(mintJwt, signCB),
  nats.MaxReconnects(-1),
)
```

> **Why this works only with the callback variant.** Static authenticators (`credsAuthenticator` / `nats.UserCredentials`) capture the JWT bytes once at connect and reuse them on every internal reconnect. The callback variant is what makes the lib re-mint on each reconnect — that's how new permissions propagate without a container restart.

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
        "subscribe": ["commands.>"],
        "ttlSeconds": 0
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
- **`nats-creds` JWTs *are* enforced for the connection's lifetime.** When the JWT in `NATS_CREDS` expires, the NATS server closes the connection on the next protocol tick and rejects every reconnect attempt — your existing session does **not** get a grace period. The slackbot stack hit this in the wild: containers booted at 13:00, JWTs expired at 14:00, NATS started returning `authentication expired` at 14:06, and the dependent gateway → manager RPCs failed an hour later. Fix: set `ttlSeconds: 0` on the role to mint a non-expiring JWT — the canonical NATS pattern for service-owned connections — and re-deploy.
