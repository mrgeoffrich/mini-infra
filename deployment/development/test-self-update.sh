#!/bin/bash
# Self-Update Local Test Script
# Tests the self-update sidecar mechanism using a local Docker registry.
#
# Usage:
#   ./test-self-update.sh <API_KEY>            Run the self-update test
#   ./test-self-update.sh cleanup              Clean up test resources
#
# Prerequisites:
#   - mini-infra-dev container running (via ./start.sh)
#   - A valid API key with settings:write permission

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."

REGISTRY_PORT=5051
REGISTRY_NAME="mini-infra-test-registry"
IMAGE_NAME="localhost:${REGISTRY_PORT}/mini-infra"
SIDECAR_IMAGE_NAME="localhost:${REGISTRY_PORT}/mini-infra-sidecar"
TARGET_TAG="v2-test"
SIDECAR_TAG="v1-test"
APP_URL="http://localhost:3005"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

step()  { echo -e "\n${BOLD}${CYAN}[$1/${TOTAL_STEPS}] $2${NC}"; }
ok()    { echo -e "  ${GREEN}✓ $1${NC}"; }
warn()  { echo -e "  ${YELLOW}⚠ $1${NC}"; }
fail()  { echo -e "  ${RED}✗ $1${NC}"; exit 1; }
info()  { echo -e "  ${CYAN}$1${NC}"; }

# ---------------------------------------------------------------------------
# Cleanup mode
# ---------------------------------------------------------------------------
if [ "${1:-}" = "cleanup" ]; then
    echo -e "${BOLD}${YELLOW}Cleaning up self-update test resources...${NC}"
    echo ""

    docker stop "$REGISTRY_NAME" 2>/dev/null && ok "Stopped registry" || warn "Registry not running"
    docker rm "$REGISTRY_NAME" 2>/dev/null && ok "Removed registry container" || true

    # Remove locally-tagged test images
    docker rmi "${IMAGE_NAME}:${TARGET_TAG}" 2>/dev/null && ok "Removed ${IMAGE_NAME}:${TARGET_TAG}" || true
    docker rmi "${SIDECAR_IMAGE_NAME}:${SIDECAR_TAG}" 2>/dev/null && ok "Removed ${SIDECAR_IMAGE_NAME}:${SIDECAR_TAG}" || true

    # Clean up any leftover sidecar containers
    SIDECAR_IDS=$(docker ps -a -q --filter "label=mini-infra.sidecar=true" 2>/dev/null)
    if [ -n "$SIDECAR_IDS" ]; then
        docker rm -f $SIDECAR_IDS 2>/dev/null && ok "Removed leftover sidecar containers" || true
    fi

    echo ""
    echo -e "${GREEN}Cleanup complete.${NC}"
    echo ""
    echo -e "${YELLOW}If the update succeeded, your container was replaced and is no longer managed by docker-compose.${NC}"
    echo -e "${YELLOW}To restore the original docker-compose setup:${NC}"
    echo "  docker stop mini-infra-dev 2>/dev/null; docker rm mini-infra-dev 2>/dev/null"
    echo "  ./deployment/development/start.sh"
    exit 0
fi

# ---------------------------------------------------------------------------
# Run mode — requires API key as first argument
# ---------------------------------------------------------------------------
API_KEY="${1:-}"
if [ -z "$API_KEY" ]; then
    echo -e "${RED}Usage: $0 <API_KEY>${NC}"
    echo ""
    echo "  Get your API key from the Mini Infra UI (Settings > API Keys)"
    echo "  or by running: npm run show-dev-key -w server  (local dev mode only)"
    echo ""
    echo "  Other commands:"
    echo "    $0 cleanup    Clean up test resources"
    exit 1
fi

TOTAL_STEPS=7

echo ""
echo -e "${BOLD}${CYAN}═══════════════════════════════════════════════${NC}"
echo -e "${BOLD}${CYAN}  Mini Infra Self-Update Local Test${NC}"
echo -e "${BOLD}${CYAN}═══════════════════════════════════════════════${NC}"

# ---------------------------------------------------------------------------
# Step 1: Verify dev container is running
# ---------------------------------------------------------------------------
step 1 "Verifying mini-infra-dev container is running..."

if ! docker ps --format '{{.Names}}' | grep -q '^mini-infra-dev$'; then
    fail "mini-infra-dev container is not running. Run ./deployment/development/start.sh first."
fi
ok "mini-infra-dev is running"

# Quick API connectivity check
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "x-api-key: ${API_KEY}" "${APP_URL}/health" || echo "000")
if [ "$HTTP_CODE" != "200" ]; then
    fail "Cannot reach ${APP_URL}/health (HTTP ${HTTP_CODE}). Is the app healthy?"
fi
ok "App is reachable and healthy"

# Verify the API key works
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "x-api-key: ${API_KEY}" "${APP_URL}/api/self-update/status")
if [ "$HTTP_CODE" != "200" ]; then
    fail "API key is invalid or lacks settings:read permission (HTTP ${HTTP_CODE})"
fi
ok "API key is valid"

# ---------------------------------------------------------------------------
# Step 2: Start local Docker registry
# ---------------------------------------------------------------------------
step 2 "Starting local Docker registry on port ${REGISTRY_PORT}..."

if docker ps --format '{{.Names}}' | grep -q "^${REGISTRY_NAME}$"; then
    ok "Registry already running"
else
    docker run -d --name "$REGISTRY_NAME" -p "${REGISTRY_PORT}:5000" registry:2 > /dev/null
    # Wait for registry to be ready
    for i in $(seq 1 10); do
        if curl -s "http://localhost:${REGISTRY_PORT}/v2/" > /dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    ok "Registry started on port ${REGISTRY_PORT}"
fi

# ---------------------------------------------------------------------------
# Step 3: Build and push main app image
# ---------------------------------------------------------------------------
step 3 "Building main app image and pushing to local registry..."
info "This builds the full app from the Dockerfile (may take a minute)..."

docker build -q -t "${IMAGE_NAME}:${TARGET_TAG}" -f "$PROJECT_ROOT/Dockerfile" "$PROJECT_ROOT" > /dev/null
ok "Built ${IMAGE_NAME}:${TARGET_TAG}"

docker push "${IMAGE_NAME}:${TARGET_TAG}" > /dev/null 2>&1
ok "Pushed to local registry"

# ---------------------------------------------------------------------------
# Step 4: Build sidecar image
# ---------------------------------------------------------------------------
step 4 "Building sidecar image..."

docker build -q -t "${SIDECAR_IMAGE_NAME}:${SIDECAR_TAG}" -f "$PROJECT_ROOT/sidecar/Dockerfile" "$PROJECT_ROOT/sidecar" > /dev/null
ok "Built ${SIDECAR_IMAGE_NAME}:${SIDECAR_TAG}"

# ---------------------------------------------------------------------------
# Step 5: Configure self-update settings via API
# ---------------------------------------------------------------------------
step 5 "Configuring self-update settings..."
info "Registry pattern: ${IMAGE_NAME}:*"
info "Sidecar image:    ${SIDECAR_IMAGE_NAME}:${SIDECAR_TAG}"

RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT "${APP_URL}/api/self-update/config" \
    -H "x-api-key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{
        \"allowedRegistryPattern\": \"${IMAGE_NAME}:*\",
        \"sidecarImage\": \"${SIDECAR_IMAGE_NAME}:${SIDECAR_TAG}\",
        \"healthCheckTimeoutMs\": 90000,
        \"gracefulStopSeconds\": 30
    }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
    fail "Failed to configure self-update (HTTP ${HTTP_CODE}): ${BODY}"
fi
ok "Self-update configured"

# ---------------------------------------------------------------------------
# Step 6: Verify configuration with /check endpoint
# ---------------------------------------------------------------------------
step 6 "Verifying self-update readiness..."

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${APP_URL}/api/self-update/check" \
    -H "x-api-key: ${API_KEY}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
    fail "Check endpoint failed (HTTP ${HTTP_CODE}): ${BODY}"
fi

# Parse key fields from the check response
AVAILABLE=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('available', False))" 2>/dev/null || echo "unknown")
CONFIGURED=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('configured', False))" 2>/dev/null || echo "unknown")

if [ "$AVAILABLE" != "True" ]; then
    fail "Self-update not available (running in Docker? check response: ${BODY})"
fi
ok "Running in Docker: yes"

if [ "$CONFIGURED" != "True" ]; then
    fail "Self-update not configured (unexpected — we just set it)"
fi
ok "Configuration verified"

# ---------------------------------------------------------------------------
# Step 7: Trigger the self-update
# ---------------------------------------------------------------------------
step 7 "Triggering self-update to tag '${TARGET_TAG}'..."

echo ""
echo -e "  ${BOLD}${YELLOW}⚡ This will stop the current container and replace it!${NC}"
echo -e "  ${YELLOW}   The app will be briefly unavailable during the swap.${NC}"
echo ""
read -p "  Continue? [y/N] " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "\n${YELLOW}Aborted. No changes were made.${NC}"
    echo "Run '$0 cleanup' to remove test images and the registry."
    exit 0
fi

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${APP_URL}/api/self-update/trigger" \
    -H "x-api-key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"targetTag\": \"${TARGET_TAG}\"}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "202" ]; then
    fail "Failed to trigger update (HTTP ${HTTP_CODE}): ${BODY}"
fi

ok "Update triggered!"
echo ""
echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"

# ---------------------------------------------------------------------------
# Monitor the sidecar
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}${CYAN}Monitoring update progress...${NC}"
echo -e "${YELLOW}The sidecar will: pull image → inspect → stop old → create new → health-check${NC}"
echo ""

sleep 2

SIDECAR_CID=$(docker ps -q --filter "label=mini-infra.sidecar=true" 2>/dev/null | head -1)
if [ -n "$SIDECAR_CID" ]; then
    info "Following sidecar logs (Ctrl+C to detach — update continues in background):"
    echo ""
    docker logs -f "$SIDECAR_CID" 2>&1 || true
else
    warn "Could not find running sidecar container (it may have already finished)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}${CYAN}═══════════════════════════════════════════════${NC}"
echo -e "${BOLD}${CYAN}  Test complete${NC}"
echo -e "${BOLD}${CYAN}═══════════════════════════════════════════════${NC}"
echo ""
echo -e "${CYAN}Check container status:${NC}"
echo "  docker ps -a --filter 'name=mini-infra'"
echo ""
echo -e "${CYAN}Check update result via API:${NC}"
echo "  curl -s -H 'x-api-key: ${API_KEY}' ${APP_URL}/api/self-update/status | python3 -m json.tool"
echo ""
echo -e "${CYAN}Clean up when done:${NC}"
echo "  $0 cleanup"
echo "  docker stop mini-infra-dev 2>/dev/null; docker rm mini-infra-dev 2>/dev/null"
echo "  ./deployment/development/start.sh"
