#!/bin/bash

# List of test files that need the auth fix
TEST_FILES=(
  "src/routes/__tests__/postgres-backup-configs.test.ts"
  "src/routes/__tests__/postgres-backups.test.ts"
  "src/routes/__tests__/postgres-databases.test.ts"
  "src/routes/__tests__/postgres-progress.test.ts"
  "src/routes/__tests__/settings.test.ts"
)

AUTH_MOCK_REPLACEMENT='// Mock auth middleware - need to mock the api-key-middleware functions that are re-exported through middleware/auth
const mockRequireSessionOrApiKey = jest.fn((req: any, res: any, next: any) => {
  // Set up authenticated user context for tests
  req.apiKey = {
    userId: "test-user-id",
    id: "test-key-id",
    user: { id: "test-user-id", email: "test@example.com" }
  };
  res.locals = {
    requestId: "test-request-id",
  };
  next();
});

jest.mock("../../lib/api-key-middleware", () => ({
  requireSessionOrApiKey: mockRequireSessionOrApiKey,
  getCurrentUserId: (req: any) => "test-user-id",
  getCurrentUser: (req: any) => ({ id: "test-user-id", email: "test@example.com" })
}));

// Mock auth middleware functions
jest.mock("../../lib/auth-middleware", () => ({
  getAuthenticatedUser: (req: any) => ({ id: "test-user-id", email: "test@example.com" }),
}));'

for TEST_FILE in "${TEST_FILES[@]}"; do
  echo "Processing $TEST_FILE..."

  if [ -f "$TEST_FILE" ]; then
    # Check if the file contains old auth mock patterns
    if grep -q "requireAuth\|auth-middleware" "$TEST_FILE"; then
      echo "  - File needs auth fix"
      # Backup the file
      cp "$TEST_FILE" "$TEST_FILE.bak"
      echo "  - Created backup: $TEST_FILE.bak"
    else
      echo "  - File doesn't need auth fix"
    fi
  else
    echo "  - File not found: $TEST_FILE"
  fi
done

echo "Auth fix script preparation complete!"
echo "Manual fixes still needed per file based on their specific mock patterns."