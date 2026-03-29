# Image Port Detection for Application Routing

**Date:** 2026-03-29
**Status:** Approved

## Problem

When creating a new application with routing enabled, users must manually type the listening port. Docker images already declare their exposed ports via `EXPOSE` directives, but this metadata isn't surfaced in the UI.

## Solution

Add a "Detect Ports" button to the new application form that queries the Docker registry V2 API for the image's exposed ports without pulling the image. Auto-fill the routing listening port when a single port is detected, or show a dropdown when multiple ports are found.

## Backend

### New Endpoint

`GET /api/images/inspect-ports?image=<image>&tag=<tag>`

**Auth:** `requirePermission('containers:read')`

**Response:**
```json
{ "success": true, "ports": [80, 443] }
```

**Error responses:**
- 400: Missing image or tag parameter
- 404: Image not found in registry
- 502: Registry unreachable or auth failed

### New Service: `ImageInspectService`

Location: `server/src/services/image-inspect.ts`

Single public method:

```typescript
async getExposedPorts(image: string, tag: string): Promise<number[]>
```

**Flow:**

1. Determine registry URL using `RegistryCredentialService.extractRegistryFromImage(image)`
2. Fetch credentials via `RegistryCredentialService.getCredentialsForImage(image)`
3. If Docker Hub:
   - Exchange credentials (or anonymous) for a bearer token via `https://auth.docker.io/token?service=registry.docker.io&scope=repository:<name>:pull`
   - Query `https://registry-1.docker.io/v2/<name>/manifests/<tag>` with `Accept: application/vnd.docker.distribution.manifest.v2+json`
4. If other registry (GHCR, ACR, etc.):
   - Use Basic auth with credentials from step 2
   - Query `https://<registry>/v2/<name>/manifests/<tag>`
5. Parse manifest to get config digest from `config.digest`
6. Fetch config blob: `GET /v2/<name>/blobs/<config-digest>`
7. Parse `Config.ExposedPorts` keys (e.g., `"80/tcp"` -> `80`)
8. Return sorted array of port numbers

**Timeout:** 10 seconds for the entire operation.

**Error handling:** Throws typed errors for image-not-found, auth-failed, registry-unreachable. Returns empty array if the image has no EXPOSE directive.

**Docker Hub specifics:**
- Unqualified images like `nginx` resolve to `library/nginx`
- Images like `myuser/myimage` resolve to `myuser/myimage`
- Token endpoint: `https://auth.docker.io/token`
- Registry endpoint: `https://registry-1.docker.io`

### New Route File

Location: `server/src/routes/images.ts`

Register in the Express app alongside other routes.

## Frontend

### New Hook: `useDetectImagePorts`

Location: `client/src/hooks/use-detect-image-ports.ts`

Uses `useMutation` (user-triggered, not automatic):

```typescript
export function useDetectImagePorts() {
  return useMutation({
    mutationFn: async ({ image, tag }: { image: string; tag: string }) => {
      const res = await fetch(`/api/images/inspect-ports?image=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`);
      if (!res.ok) throw new Error(/* parse error */);
      const data = await res.json();
      return data.ports as number[];
    },
  });
}
```

### Form Changes: `/applications/new/page.tsx`

**New form field:**
- `detectedPorts`: local state (`number[]`), not part of the Zod schema — it's UI-only state for rendering the dropdown vs input.

**"Detect Ports" button:**
- Placed below the Docker Image / Tag row in the Container Configuration card
- Disabled when image or tag is empty
- Shows a loading spinner while detecting
- On success:
  - Stores detected ports in local state
  - If 1 port: auto-sets `routing.listeningPort` to that port
  - If multiple ports: auto-sets `routing.listeningPort` to the first detected port
- On error: shows a toast via sonner ("Couldn't detect ports — you can set the port manually")

**Routing listening port field behavior:**
- When `detectedPorts` has 0 or 1 entry: render as `Input` (current behavior)
- When `detectedPorts` has 2+ entries: render as `Select` dropdown with detected ports as options, plus a "Custom..." option that switches back to an `Input`
- User can always override by selecting "Custom..." or by typing directly

**Reset behavior:**
- When image or tag changes, clear `detectedPorts` state (detected ports are stale for a different image)

## Scope

- New application form only (`/applications/new`). The edit page can be added later.
- Routing listening port only. Port mappings are not auto-populated.
- No caching of registry responses — each click re-queries.
