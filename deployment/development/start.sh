#!/bin/bash
# Mini Infra Development Deployment Startup Script (Bash)
# This script builds and starts the development Mini Infra deployment using Docker Compose
# It builds from the local Dockerfile instead of pulling from ghcr.io

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yaml"

# Local registry configuration
REGISTRY_HOST="localhost:5051"
AGENT_SIDECAR_IMAGE="$REGISTRY_HOST/mini-infra-agent-sidecar:latest"

echo -e "\033[0;32mBuilding and starting Mini Infra development deployment...\033[0m"
echo -e "\033[0;36mBuilding from local Dockerfile...\033[0m"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Ensure the local registry is running
# ---------------------------------------------------------------------------
echo -e "\033[0;36mEnsuring local Docker registry is running...\033[0m"
docker compose -f "$COMPOSE_FILE" up -d registry

# Wait for registry to be ready
for i in $(seq 1 10); do
    if curl -sf http://$REGISTRY_HOST/v2/ >/dev/null 2>&1; then
        break
    fi
    if [ "$i" -eq 10 ]; then
        echo -e "\033[0;31mERROR: Local registry failed to start\033[0m"
        exit 1
    fi
    sleep 1
done
echo -e "\033[0;32mLocal registry is ready at $REGISTRY_HOST\033[0m"

# ---------------------------------------------------------------------------
# Step 2: Build and push the agent sidecar image to the local registry
# ---------------------------------------------------------------------------
echo -e "\033[0;36mBuilding agent sidecar image...\033[0m"
docker build -t "$AGENT_SIDECAR_IMAGE" -f "$PROJECT_ROOT/agent-sidecar/Dockerfile" "$PROJECT_ROOT"

echo -e "\033[0;36mPushing agent sidecar image to local registry...\033[0m"
docker push "$AGENT_SIDECAR_IMAGE"
echo -e "\033[0;32mAgent sidecar image pushed to $AGENT_SIDECAR_IMAGE\033[0m"

# Remove the old sidecar container so Mini Infra creates a fresh one on startup
if docker inspect mini-infra-agent-sidecar >/dev/null 2>&1; then
    echo -e "\033[0;36mRemoving old agent sidecar container...\033[0m"
    docker rm -f mini-infra-agent-sidecar >/dev/null 2>&1 || true
    echo -e "\033[0;32mOld agent sidecar container removed\033[0m"
fi

# ---------------------------------------------------------------------------
# Step 3: Remember extra networks attached to mini-infra-dev
# (Networks joined dynamically at runtime, e.g. the dataplane network via
# joinSelf, are not in docker-compose.yaml and get lost on container recreate.)
# ---------------------------------------------------------------------------
EXTRA_NETWORKS=""
if docker inspect mini-infra-dev >/dev/null 2>&1; then
    # Get the networks defined in the compose file
    COMPOSE_NETWORKS=$(docker compose -f "$COMPOSE_FILE" config --format json \
        | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
project = cfg.get('name', '')
nets = set()
# Collect networks from each service
for svc in cfg.get('services', {}).values():
    for net_name in svc.get('networks', {}).keys():
        nets.add(net_name)
# Also add the default network
nets.add('default')
# Print compose-managed network names (project_netname format)
for n in nets:
    print(f'{project}_{n}')
" 2>/dev/null)

    # Get all networks currently attached to the container
    CURRENT_NETWORKS=$(docker inspect mini-infra-dev --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' 2>/dev/null)

    # Find networks that are attached but not managed by compose
    for net in $CURRENT_NETWORKS; do
        is_compose=false
        for cn in $COMPOSE_NETWORKS; do
            if [ "$net" = "$cn" ]; then
                is_compose=true
                break
            fi
        done
        if [ "$is_compose" = false ]; then
            EXTRA_NETWORKS="$EXTRA_NETWORKS $net"
        fi
    done

    if [ -n "$EXTRA_NETWORKS" ]; then
        echo -e "\033[0;36mWill restore extra networks after rebuild:$EXTRA_NETWORKS\033[0m"
    fi
fi

# ---------------------------------------------------------------------------
# Step 4: Build and start Mini Infra (with the registry-prefixed sidecar tag)
# ---------------------------------------------------------------------------
AGENT_SIDECAR_IMAGE_TAG="$AGENT_SIDECAR_IMAGE" \
    docker compose -f "$COMPOSE_FILE" up -d --build

if [ $? -eq 0 ]; then
    # -----------------------------------------------------------------------
    # Step 5: Rejoin extra networks that were stripped by the rebuild
    # -----------------------------------------------------------------------
    if [ -n "$EXTRA_NETWORKS" ]; then
        echo -e "\033[0;36mWaiting for mini-infra-dev to start before restoring networks...\033[0m"
        for i in $(seq 1 30); do
            STATUS=$(docker inspect mini-infra-dev --format '{{.State.Status}}' 2>/dev/null)
            if [ "$STATUS" = "running" ]; then
                break
            fi
            sleep 1
        done

        for net in $EXTRA_NETWORKS; do
            if docker network inspect "$net" >/dev/null 2>&1; then
                docker network connect "$net" mini-infra-dev 2>/dev/null \
                    && echo -e "\033[0;32mRejoined network: $net\033[0m" \
                    || echo -e "\033[0;33mFailed to rejoin network: $net (may already be connected)\033[0m"
            else
                echo -e "\033[0;33mSkipping network $net (no longer exists)\033[0m"
            fi
        done
    fi

    echo ""
    echo -e "\033[0;32mMini Infra development deployment started successfully!\033[0m"
    echo ""
    echo -e "\033[0;36mUseful commands:\033[0m"
    echo "  View logs:    docker compose -f deployment/development/docker-compose.yaml logs -f"
    echo "  Check status: docker compose -f deployment/development/docker-compose.yaml ps"
    echo "  Rebuild:      docker compose -f deployment/development/docker-compose.yaml up -d --build"
    echo "  Stop:         docker compose -f deployment/development/docker-compose.yaml down"
    echo ""
else
    echo ""
    echo -e "\033[0;31mERROR: Failed to start Mini Infra\033[0m"
    exit 1
fi
