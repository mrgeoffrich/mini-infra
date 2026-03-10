#!/bin/bash
# Mini Infra Development Deployment Startup Script (Bash)
# This script builds and starts the development Mini Infra deployment using Docker Compose
# It builds from the local Dockerfile instead of pulling from ghcr.io

set -e

SEED_DB=false
for arg in "$@"; do
    case "$arg" in
        --seed-db) SEED_DB=true ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."
ENV_FILE="$PROJECT_ROOT/server/.env"

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

echo -e "\033[0;32mBuilding and starting Mini Infra development deployment...\033[0m"
echo -e "\033[0;36mUsing .env file: $ENV_FILE\033[0m"
echo -e "\033[0;36mBuilding from local Dockerfile...\033[0m"
echo ""

# Seed database from dev.db if requested
if [ "$SEED_DB" = true ]; then
    DEV_DB="$PROJECT_ROOT/server/dev.db"
    if [ ! -f "$DEV_DB" ]; then
        echo -e "\033[0;31mERROR: Dev database not found at: $DEV_DB\033[0m"
        echo -e "\033[0;33mRun the dev server at least once to create it.\033[0m"
        exit 1
    fi

    echo -e "\033[0;33mSeeding container database from server/dev.db...\033[0m"

    # Ensure the volume exists
    docker volume create mini-infra-dev-data 2>/dev/null || true

    # Copy dev.db into the volume as production.db using a temporary container
    docker run --rm \
        -v mini-infra-dev-data:/app/data \
        -v "$DEV_DB":/tmp/dev.db:ro \
        alpine sh -c "cp /tmp/dev.db /app/data/production.db && chmod 644 /app/data/production.db"

    echo -e "\033[0;32mDatabase seeded successfully.\033[0m"
fi

# Build and start Docker Compose with explicit env file
docker compose --env-file "$ENV_FILE" -f "$SCRIPT_DIR/docker-compose.yaml" up -d --build

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
