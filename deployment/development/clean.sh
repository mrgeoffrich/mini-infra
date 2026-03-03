#!/bin/bash
# Mini Infra Development Deployment Cleanup Script (Bash)
# This script stops and removes all containers, networks, and volumes

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "\033[0;33mStopping and removing Mini Infra development deployment...\033[0m"
echo -e "\033[0;31mThis will remove containers, networks, AND volumes (all data will be lost)!\033[0m"
echo ""

# Confirm with user
read -p "Are you sure you want to continue? (yes/no): " confirmation
if [ "$confirmation" != "yes" ]; then
    echo -e "\033[0;36mCleanup cancelled.\033[0m"
    exit 0
fi

echo ""
echo -e "\033[0;33mRemoving deployment...\033[0m"

# Stop and remove containers, networks, and volumes
docker compose -f "$SCRIPT_DIR/docker-compose.yaml" down -v

if [ $? -eq 0 ]; then
    echo ""
    echo -e "\033[0;32mMini Infra development deployment cleaned successfully!\033[0m"
    echo -e "\033[0;36mAll containers, networks, and volumes have been removed.\033[0m"
    echo ""
else
    echo ""
    echo -e "\033[0;31mERROR: Failed to clean deployment\033[0m"
    exit 1
fi
