---
title: Sharing NATS subjects across stacks
description: Use exports and imports to publish events from one stack and consume them in another, plus the subject-prefix allowlist for human-readable namespaces.
tags:
  - nats
  - messaging
  - integration
  - templates
  - exports
  - imports
---

# Sharing NATS subjects across stacks

By default, every stack gets a unique subject prefix and a credential JWT pinned to it. That isolation is great until you actually want one stack to listen to events another stack publishes. **Exports** and **imports** are the supported way to do that without sharing credentials or punching holes in NATS permissions.

## When to use this

- An events producer (e.g. `orders`) needs to publish `order.placed` for one or more downstream consumers.
- A data pipeline stack needs to subscribe to a stream another stack emits.
- Two stacks need a clean contract — the producer declares what it shares; the consumer declares what it pulls in; nothing else leaks.

If you only need internal pub/sub within a single stack, you don't need exports/imports — just give your role the right permissions.

## Producer side --- declare exports

In the producer template, list the subjects you want to make available. Subjects are relative to the producer's prefix.

```json
{
  "nats": {
    "subjectPrefix": "orders",
    "roles": [
      { "name": "publisher", "publish": ["order.placed", "order.cancelled"] }
    ],
    "exports": ["order.placed", "order.cancelled"]
  }
}
```

Notes:

- An entry must appear in `exports[]` *and* be publishable by some role in the same template, otherwise the exported subject would never have a publisher.
- Exports are visible only to consumers in the **same environment**. Cross-environment messaging is not supported by this surface.
- Once you apply the producer, the exports are recorded on its `lastAppliedSnapshot` --- that's what consumers resolve against.

## Consumer side --- declare imports

In the consumer template, declare what to import and which of your local roles should be able to subscribe to it.

```json
{
  "nats": {
    "roles": [
      { "name": "shipping", "subscribe": ["internal.>"] }
    ],
    "imports": [
      {
        "fromStack": "orders",
        "subjects": ["order.placed"],
        "forRoles": ["shipping"]
      }
    ]
  },
  "services": [
    {
      "serviceName": "shipping",
      "natsRole": "shipping",
      "containerConfig": {
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

1. Looks up the `orders` stack in the same environment.
2. Reads its `lastAppliedSnapshot` for the listed subjects.
3. Adds the producer-prefixed subjects (e.g. `orders.order.placed`) to the `subscribe` list of every role in `forRoles`.
4. Re-mints the credential for those roles to include the new permissions.

Your client subscribes to the *producer's* subject as it appears on the wire (e.g. `orders.order.placed`).

### Import fields

| Field | Required | Description |
|---|---|---|
| `fromStack` | yes | Producer stack name (in the same environment). |
| `subjects` | yes | Subjects relative to the producer's prefix. Must match an entry in the producer's `exports[]`. |
| `forRoles` | yes | Role names in *this* template that should be granted subscribe access to the imported subjects. |

## Subject prefix allowlist

By default, every stack's subject prefix is `app.<stack-id>` --- unique, opaque, and collision-free. Sometimes you want something readable instead (e.g. `orders` in the example above). That requires an admin to add an allowlist entry.

### Why it's gated

A custom prefix is essentially a claim on a subject namespace. Without governance, two unrelated stacks could grab `events.>` and shadow each other. The allowlist enforces:

- No wildcards (`*`, `>`).
- No leading or trailing `.`.
- Not under `$SYS.>` (reserved for the NATS server).
- Each segment is `[a-zA-Z0-9_-]`.
- No overlap (subset *or* superset) with existing entries --- so `events` blocks `events.platform` and vice versa.

### Requesting an entry

Ask an admin to open **Settings → NATS Prefix Allowlist** and add an entry mapping your template ID (or a glob) to the prefix you want. Once it exists, your template can set `nats.subjectPrefix: "<your-prefix>"` and apply will accept it.

If you apply with a non-default, non-allowlisted prefix you'll get:

> Subject prefix '`<prefix>`' is not in the allowlist. Contact an administrator to add it.

### Choosing a prefix

- **Use a stable name.** The prefix becomes part of every subject your producers and consumers see; renaming it is a breaking change for every consumer.
- **Keep it short.** Subjects are length-limited and clients log them often.
- **Match the team or product**, not the environment. The same prefix is used in staging and production --- environments isolate scope.

## End-to-end example

**Producer (`orders` stack):**

```json
{
  "nats": {
    "subjectPrefix": "orders",
    "roles": [
      { "name": "writer", "publish": ["order.placed", "order.cancelled"] }
    ],
    "exports": ["order.placed", "order.cancelled"]
  },
  "services": [
    {
      "serviceName": "writer",
      "natsRole": "writer",
      "containerConfig": {
        "image": "ghcr.io/example/orders:1.2.0",
        "dynamicEnv": {
          "NATS_URL": { "kind": "nats-url" },
          "NATS_CREDS": { "kind": "nats-creds" }
        }
      }
    }
  ]
}
```

**Consumer (`shipping` stack):**

```json
{
  "nats": {
    "roles": [
      { "name": "reader", "subscribe": [] }
    ],
    "imports": [
      { "fromStack": "orders", "subjects": ["order.placed"], "forRoles": ["reader"] }
    ]
  },
  "services": [
    {
      "serviceName": "reader",
      "natsRole": "reader",
      "containerConfig": {
        "image": "ghcr.io/example/shipping:1.0.0",
        "dynamicEnv": {
          "NATS_URL": { "kind": "nats-url" },
          "NATS_CREDS": { "kind": "nats-creds" }
        }
      }
    }
  ]
}
```

In `shipping`, the reader subscribes to `orders.order.placed` on the wire.

## What to watch out for

- **Apply order matters.** Imports resolve against the producer's `lastAppliedSnapshot`. If the producer hasn't been applied since adding the export, your import will fail. Apply the producer first, then the consumer.
- **Renaming an export is a breaking change.** All consumers must update their `imports[]` and re-apply.
- **Same-environment only.** A staging stack cannot import from a production stack. Move the producer or duplicate it per environment.
- **Imports can't grant publish.** They only add to `subscribe`. If two stacks need bidirectional comms, both must export and both must import.
- **Glob imports are not supported.** List each subject (or use a producer-side wildcard like `order.>` and import that).
