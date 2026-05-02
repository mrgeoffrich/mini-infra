# Tailscale Auth Integration for Self-Hosted Apps

How to let users connect their Tailscale account to your homelab software so it can programmatically create tailnet web and SSH endpoints.

## TL;DR

Tailscale does **not** offer a "Sign in with Tailscale" OAuth flow for end users. The user has to manually generate a credential in their own Tailscale admin console and paste it into your app. Two credential types are viable:

| Option | Best for | Expiry |
|---|---|---|
| **Auth key** | Simplest setup, single-tenant homelab | Max 90 days |
| **OAuth client** (client credentials grant) | Long-lived integrations, mints auth keys on demand | Never expires |

Both require the user to be a tailnet **Owner** or **Admin** and to add some ACL policy first.

---

## Option 1: User-pasted auth key

### User flow

1. In your app, show a "Connect Tailscale" button.
2. Open instructions / deep-link to `https://login.tailscale.com/admin/settings/keys`.
3. User generates a **reusable** (and optionally **ephemeral**) auth key with a tag like `tag:homelab`.
4. User pastes the key (`tskey-auth-...`) into your app.
5. Store encrypted; use as `TS_AUTHKEY` when starting tsnet nodes.

### ACL prerequisites the user must add

```json
{
  "tagOwners": {
    "tag:homelab": ["autogroup:admin"]
  }
}
```

### Caveats

- Keys expire (90 days max). You need a re-auth flow.
- Each `tsnet.Server` consumes the key to register, then persists its own node state.

---

## Option 2: OAuth client (recommended for production)

This uses the OAuth 2.0 **client credentials** grant. The user creates one OAuth client; your app uses it to mint short-lived auth keys on demand whenever it needs to register a new node.

### User flow

1. Show "Connect Tailscale" button.
2. Deep-link to `https://login.tailscale.com/admin/settings/oauth`.
3. User creates an OAuth client with these scopes:
   - `auth_keys` (write) — to mint auth keys for new nodes
   - `devices:core` (write) — to manage devices, including enabling SSH
   - `devices:posture_attributes` (read) — optional, if you want device metadata
4. User assigns the tag `tag:homelab` to the client.
5. User copies the **client ID** and **client secret** (secret is only shown once).
6. User pastes both into your app.

### ACL prerequisites

```json
{
  "tagOwners": {
    "tag:homelab": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["*"],
      "dst": ["tag:homelab"],
      "ip": ["*"]
    }
  ]
}
```

### Minting an auth key from the OAuth client

```bash
# Step 1: Get an access token
curl -X POST https://api.tailscale.com/api/v2/oauth/token \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET"

# Returns: {"access_token":"tskey-api-...","expires_in":3600,"token_type":"Bearer"}

# Step 2: Use the access token to create an auth key
curl -X POST "https://api.tailscale.com/api/v2/tailnet/-/keys" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "capabilities": {
      "devices": {
        "create": {
          "reusable": false,
          "ephemeral": true,
          "preauthorized": true,
          "tags": ["tag:homelab"]
        }
      }
    },
    "expirySeconds": 3600
  }'
```

The `-` in the URL means "the tailnet that owns this OAuth client." You can also use the user's tailnet name explicitly.

---

## Storing credentials safely

- Encrypt at rest (your existing Vault integration is the right home for this).
- Never log the secret or auth keys.
- Provide a "Disconnect Tailscale" action that revokes locally stored credentials and surfaces a link to revoke the OAuth client in the Tailscale admin console.

---

## Creating endpoints with tsnet

Once you have credentials, endpoint creation happens via the **tsnet** Go library. Each `tsnet.Server` instance is a separate node on the tailnet with its own hostname, IP, and TLS cert.

### Web endpoint (tailnet-only)

```go
srv := &tsnet.Server{
    Hostname: "myapp",
    Dir:      "/state/tsnet/myapp",
    AuthKey:  authKey, // minted from OAuth client
}
defer srv.Close()

ln, err := srv.ListenTLS("tcp", ":443")
// serve at https://myapp.<tailnet>.ts.net
http.Serve(ln, handler)
```

### Web endpoint (public internet via Funnel)

```go
ln, err := srv.ListenFunnel("tcp", ":443")
```

Funnel is restricted to ports `443`, `80`, and `8080`, one service per port per node. Use multiple `tsnet.Server` instances with different hostnames to expose multiple Funnels.

### SSH endpoint

Tailscale SSH is a **node-level** setting, not a per-listener one. The flow is:

1. Register the node via tsnet (above).
2. Call the device API to enable Tailscale SSH on that device:

```bash
curl -X POST "https://api.tailscale.com/api/v2/device/$DEVICE_ID/attributes/custom:ssh" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d '{"value": "true"}'
```

3. Ensure your ACL grants SSH access to `tag:homelab`:

```json
{
  "ssh": [
    {
      "action": "accept",
      "src": ["autogroup:member"],
      "dst": ["tag:homelab"],
      "users": ["root", "ubuntu"]
    }
  ]
}
```

---

## TypeScript stack note

`tsnet` is Go-only. `libtailscale` (C bindings) is officially discouraged for non-Go runtimes — Tailscale's own engineers warn it ends in tears when mixed with another language runtime. The Rust `tailscale-rs` library has Python/Elixir/C bindings but no Node binding and is still experimental.

For a TypeScript homelab app, the cleanest pattern is a **Go sidecar**:

- Small Go binary that owns tsnet node lifecycle
- Exposes a local HTTP/Unix-socket API your TS app calls
- Receives OAuth credentials from your TS app at startup or via secrets mount
- Persists tsnet state directories per node

This isolates Go's runtime takeover from your Node process and gives you a clean boundary you can swap out later if a proper Node binding ships.

---

## References

- OAuth clients: https://tailscale.com/docs/features/oauth-clients
- tsnet: https://tailscale.com/docs/features/tsnet
- Tailscale Services (GA): https://tailscale.com/blog/services-ga
- API reference: https://tailscale.com/api
