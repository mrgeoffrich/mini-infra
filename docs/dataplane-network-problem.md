# Problem: Mini Infra Cannot Reach HAProxy DataPlane API

## The Problem

When deploying a stack with a `StatelessWeb` service (e.g. `internalnginx`), the deployment state machine successfully:

1. Creates the Docker network
2. Issues the TLS certificate
3. Creates the DNS record
4. Pulls the image and creates the application container
5. Starts the container and monitors startup

But then **fails** at the HAProxy configuration step. The mini-infra management container needs to call the HAProxy DataPlane API (port 5555) to add the new container as a backend, but it **cannot reach the HAProxy container** because they are on different Docker networks.

```
mini-infra-dev:  bridge, development_default, monitoring_monitoring_network
haproxy:         local-haproxy_network
```

The DataPlane API connection times out after 10 seconds, the deployment enters an error state, and the application container is left orphaned with no load balancer configuration.

## How Networks Work Today

1. **Environment creation** creates `EnvironmentNetwork` database records with a purpose (`applications`, `tunnel`). These map to Docker network names like `${envName}-applications`.

2. **HAProxy stack deployment** reads the template's `joinEnvironmentNetworks: ["applications", "tunnel"]` and connects the HAProxy container to those environment networks via the stack reconciler.

3. **Application deployment** discovers the HAProxy network dynamically by inspecting the running HAProxy container's `NetworkSettings.Networks`, filtering out `bridge`, and taking the first custom network. This becomes `haproxyNetworkName` in the state machine context.

4. **Application containers** are attached to that same network so HAProxy can route traffic to them.

The application containers and HAProxy end up on the same network — that part works. The problem is that **mini-infra itself** is never connected to that network, so it can't call the DataPlane API to configure HAProxy.

## Why This Worked Before (Probably)

In earlier setups, mini-infra likely shared a network with HAProxy by coincidence (e.g. both on the default bridge, or manually connected). As the networking became more structured with environment-scoped networks, mini-infra got left behind on its own `development_default` network.

## Idea: Host-Level Dataplane Network

### Concept

Introduce a **host-level stack** (not environment-scoped) that creates a dedicated `dataplane` network. This network exists purely for management traffic between mini-infra and the infrastructure services it needs to control (HAProxy, potentially others in the future).

### How It Would Work

- A host-level built-in stack (e.g. `dataplane-network`) creates a single Docker network (e.g. `mini-infra-dataplane`).
- The mini-infra container is always connected to this network (via docker-compose config or on startup).
- Every HAProxy stack automatically joins this dataplane network in addition to its environment-scoped application/tunnel networks.
- When mini-infra needs to call the DataPlane API, it reaches HAProxy via the dataplane network — regardless of which environment the HAProxy belongs to.

### Why Host-Level

- The dataplane network is not environment-specific. Mini-infra manages HAProxy instances across all environments from a single container.
- Environment networks are for **application traffic** (HAProxy to app containers). The dataplane network is for **management traffic** (mini-infra to HAProxy).
- This separation of concerns means environment networks stay clean — they only carry the traffic they're designed for.

### What This Solves

- Mini-infra can always reach any HAProxy DataPlane API, regardless of environment networking.
- No need to manually `docker network connect` the mini-infra container to every environment's network.
- Adding new environments with new HAProxy instances "just works" — they join the dataplane network automatically.
- Clear mental model: application traffic flows on environment networks, management traffic flows on the dataplane network.

### Open Questions

- Should the dataplane network be created as a built-in host-level stack, or as part of the mini-infra startup/bootstrap process?
- Should other management services (monitoring, agent sidecar) also join the dataplane network?
- How does the mini-infra container get connected to the dataplane network in development vs production? Docker-compose config vs runtime connection?
- Does the DataPlane API connection logic need to change to use a specific IP/hostname on the dataplane network, or is the current dynamic discovery sufficient once the network is shared?
