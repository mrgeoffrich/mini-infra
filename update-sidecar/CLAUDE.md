# Self-Update Sidecar (`mini-infra-sidecar`)

Container that performs in-place upgrades of the main Mini Infra container. The server pre-pulls the new image, then launches this sidecar with `TARGET_IMAGE` and `CONTAINER_ID`. The sidecar gracefully stops the old container, replaces it with the new image (preserving volumes, env, network, and labels), and rolls back on health-check failure.

## Important: Not in the pnpm Workspace

Standalone npm package — keeps its own `package-lock.json`. You must `cd update-sidecar` to run npm commands, then `cd` back to the project root.

## Structure

```
update-sidecar/
├── src/
│   ├── index.ts                # Orchestration: verify image → stop → recreate → verify
│   ├── container-inspector.ts  # Captures HostConfig, NetworkSettings, env, mounts, labels
│   └── logger.ts               # Pino logging
├── Dockerfile
└── package.json
```

## Commands

```bash
cd update-sidecar
npm install
npm run dev          # tsx watch src/index.ts
npm run build        # tsc → dist/
npm start            # node dist/index.js
npm run lint
npm run lint:fix
```

(Returns to project root afterwards — never leave the shell `cd`'d into a sidecar.)

## Required Environment

| Variable | Purpose |
|----------|---------|
| `TARGET_IMAGE` | Image tag to deploy (must already be pulled on the host) |
| `CONTAINER_ID` | The running Mini Infra container to replace |
| `GRACEFUL_STOP_SECONDS` | Optional, defaults to 30 |

The sidecar mounts `/var/run/docker.sock` and uses dockerode directly — it can't go through `DockerService` because the server it's about to replace is the host of that service.

## Conventions

- **Don't add features** the server can do itself before launching the sidecar (image pulls, validation). The sidecar should stay small — it's the last line of execution if the server is mid-restart.
- **Settings capture is in `container-inspector.ts`.** When the server adds a new container option (mount type, network mode, capability), update the inspector or the new container will come up missing it.
- The server tracks progress via the sidecar's stdout — keep log shapes stable, prefer additive changes.
