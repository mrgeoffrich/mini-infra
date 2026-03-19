#!/bin/bash
# Mini Infra Development Deployment Startup Script (Bash)
# This script builds and starts the development Mini Infra deployment using Docker Compose
# It builds from the local Dockerfile instead of pulling from ghcr.io

set -e

SEED_DB=false
JUST_COPY_ENV=false
for arg in "$@"; do
    case "$arg" in
        --seed-db) SEED_DB=true ;;
        --just-copy-env) JUST_COPY_ENV=true ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."
ENV_FILE="$PROJECT_ROOT/server/.env"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yaml"

# Local registry configuration
REGISTRY_HOST="localhost:5051"
AGENT_SIDECAR_IMAGE="$REGISTRY_HOST/mini-infra-agent-sidecar:latest"

# Check if .env file exists
if [ ! -f "$ENV_FILE" ]; then
    echo -e "\033[0;31mERROR: .env file not found at: $ENV_FILE\033[0m"
    echo ""
    echo -e "\033[0;33mPlease create a .env file in the server/ directory.\033[0m"
    echo -e "\033[0;33mYou can use the following template as a starting point:\033[0m"
    echo ""
    echo "  SESSION_SECRET=<generate with: openssl rand -base64 32>"
    echo "  API_KEY_SECRET=<generate with: openssl rand -base64 32>"
    echo "  GOOGLE_CLIENT_ID=your_google_client_id"
    echo "  GOOGLE_CLIENT_SECRET=your_google_client_secret"
    echo "  GOOGLE_CALLBACK_URL=http://localhost:3005/auth/google/callback"
    echo ""
    exit 1
fi

# Quick env refresh: recreate the container with updated env vars (no rebuild)
if [ "$JUST_COPY_ENV" = true ]; then
    echo -e "\033[0;36mRecreating mini-infra container with updated .env...\033[0m"
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build --force-recreate mini-infra
    echo -e "\033[0;32mEnvironment updated successfully.\033[0m"
    exit 0
fi

echo -e "\033[0;32mBuilding and starting Mini Infra development deployment...\033[0m"
echo -e "\033[0;36mUsing .env file: $ENV_FILE\033[0m"
echo -e "\033[0;36mBuilding from local Dockerfile...\033[0m"
echo ""

# Seed database from dev.db if requested
if [ "$SEED_DB" = true ]; then
    DEV_DB="$PROJECT_ROOT/server/prisma/dev.db"
    if [ ! -f "$DEV_DB" ]; then
        echo -e "\033[0;31mERROR: Dev database not found at: $DEV_DB\033[0m"
        echo -e "\033[0;33mRun the dev server at least once to create it.\033[0m"
        exit 1
    fi

    echo -e "\033[0;33mSeeding container database from server/prisma/dev.db...\033[0m"

    # Resolve the actual volume name (Docker Compose prefixes it with the project name)
    VOLUME_NAME=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --volumes | grep data | head -1)
    COMPOSE_PROJECT=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --format json | python3 -c "import sys,json; print(json.load(sys.stdin)['name'])")
    FULL_VOLUME_NAME="${COMPOSE_PROJECT}_${VOLUME_NAME}"

    # Create a clean backup copy to avoid WAL/SHM corruption issues
    SEED_TMP=$(mktemp /tmp/mini-infra-seed-XXXXXX.db)
    sqlite3 "$DEV_DB" ".backup '$SEED_TMP'"

    # Ensure the volume exists
    docker volume create "$FULL_VOLUME_NAME" 2>/dev/null || true

    # Copy the clean backup into the volume as production.db
    docker run --rm \
        -v "$FULL_VOLUME_NAME":/app/data \
        -v "$SEED_TMP":/tmp/seed.db:ro \
        alpine sh -c "cp /tmp/seed.db /app/data/production.db && chmod 644 /app/data/production.db"

    rm -f "$SEED_TMP"

    echo -e "\033[0;32mDatabase seeded successfully.\033[0m"
fi

# ---------------------------------------------------------------------------
# Step 1: Ensure the local registry is running
# ---------------------------------------------------------------------------
echo -e "\033[0;36mEnsuring local Docker registry is running...\033[0m"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d registry

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

# ---------------------------------------------------------------------------
# Step 3: Build and start Mini Infra (with the registry-prefixed sidecar tag)
# ---------------------------------------------------------------------------
AGENT_SIDECAR_IMAGE_TAG="$AGENT_SIDECAR_IMAGE" \
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build

if [ $? -eq 0 ]; then
    echo ""
    echo -e "\033[0;32mMini Infra development deployment started successfully!\033[0m"
    echo ""
    echo -e "\033[0;36mUseful commands:\033[0m"
    echo "  View logs:    docker compose -f deployment/development/docker-compose.yaml logs -f"
    echo "  Check status: docker compose -f deployment/development/docker-compose.yaml ps"
    echo "  Rebuild:      docker compose -f deployment/development/docker-compose.yaml up -d --build"
    echo "  Stop:         docker compose -f deployment/development/docker-compose.yaml down"
    echo "  Seed DB:      ./deployment/development/start.sh --seed-db"
    echo ""
else
    echo ""
    echo -e "\033[0;31mERROR: Failed to start Mini Infra\033[0m"
    exit 1
fi
