/**
 * Tests for the client's error presentation layer (Phase 2 of
 * docs/planning/not-shipped/error-handling-overhaul-plan.md, §4.4):
 * `getUserFacingError` and `toastApiError`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorCode } from "@mini-infra/types";
import { ApiRequestError } from "@/lib/api-client";

const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

// Imported after the mock so `errors.ts`'s `import { toast } from "sonner"`
// resolves to the mock above.
import { getUserFacingError, toastApiError } from "@/lib/errors";

describe("getUserFacingError", () => {
  beforeEach(() => {
    toastErrorMock.mockClear();
  });

  it("turns a migrated 409 (code + resource + action) into an actionable title/description/action", () => {
    // Mirrors the real quick-setup-backup conflict envelope (§4.3 / the
    // reference postgres-backup-quick-setup-conflict integration test).
    const body = {
      error: ErrorCode.POSTGRES_BACKUP_CONFIG_EXISTS,
      message: "kumiko already has a backup configuration.",
      resource: { type: "postgresBackupConfig", name: "kumiko" },
      action: "Edit the existing backup config instead of creating a new one.",
      details: null,
      requestId: "req-1",
      timestamp: new Date().toISOString(),
    };
    const err = new ApiRequestError(
      409,
      ErrorCode.POSTGRES_BACKUP_CONFIG_EXISTS,
      body.message,
      body,
    );

    const result = getUserFacingError(err);

    expect(result.title).toBe("Backup already configured");
    expect(result.description).toBe("kumiko already has a backup configuration.");
    expect(result.action).toBe(
      "Edit the existing backup config instead of creating a new one.",
    );
  });

  it("uses the curated title for DOCKER_NETWORK_IN_USE instead of the misleading 409 'already exists' fallback", () => {
    // Phase 4 (environments/networks): the generic resource-based title for
    // a 409 would read "Docker Network already exists", which is wrong —
    // the network already exists just fine, it's still attached to
    // containers. This is exactly the case CODE_TITLES exists for.
    const body = {
      error: ErrorCode.DOCKER_NETWORK_IN_USE,
      message: 'Cannot remove network "app-net": one or more containers are connected.',
      resource: { type: "dockerNetwork", id: "app-net" },
      action: "Disconnect the attached containers first, then try again.",
    };
    const err = new ApiRequestError(409, ErrorCode.DOCKER_NETWORK_IN_USE, body.message, body);

    const result = getUserFacingError(err);

    expect(result.title).toBe("Network still in use");
    expect(result.description).toBe(body.message);
    expect(result.action).toBe(body.action);
  });

  it("uses the curated title for ENVIRONMENT_NETWORK_TYPE_CONFLICT and ENVIRONMENT_HAPROXY_MIGRATION_IN_PROGRESS", () => {
    const networkTypeConflict = new ApiRequestError(
      409,
      ErrorCode.ENVIRONMENT_NETWORK_TYPE_CONFLICT,
      'A local environment ("prod") already exists. Only one local environment is allowed.',
      { error: ErrorCode.ENVIRONMENT_NETWORK_TYPE_CONFLICT, resource: { type: "environment", name: "prod" } },
    );
    expect(getUserFacingError(networkTypeConflict).title).toBe("Network type already in use");

    const migrationInProgress = new ApiRequestError(
      409,
      ErrorCode.ENVIRONMENT_HAPROXY_MIGRATION_IN_PROGRESS,
      "An HAProxy migration is already in progress for this environment.",
      { error: ErrorCode.ENVIRONMENT_HAPROXY_MIGRATION_IN_PROGRESS, resource: { type: "environment", id: "env-1" } },
    );
    expect(getUserFacingError(migrationInProgress).title).toBe("Migration already in progress");
  });

  it("sharpens the title from body.resource when the code has no curated title", () => {
    const body = {
      error: "STACK_ALREADY_DEPLOYED",
      message: "This stack has already been deployed.",
      resource: { type: "stackDefinition", name: "web-frontend" },
    };
    const err = new ApiRequestError(409, "STACK_ALREADY_DEPLOYED", body.message, body);

    const result = getUserFacingError(err);

    expect(result.title).toBe("Stack Definition already exists");
    expect(result.description).toBe("This stack has already been deployed.");
  });

  it("surfaces the human text from a legacy `{ error: <human text> }` response (no `message` field), not the HTTP status text", () => {
    // Mirrors client/src/app/change-password/page.tsx's documented shape:
    // the server responds `{ error: "<human message>" }` with no `message`
    // field, so `ApiRequestError.message` falls back to the generic HTTP
    // status text (extractMessage's fallback) while the real human text
    // lands in `.code` (== body.error).
    const body = { error: "Current password is incorrect" };
    const err = new ApiRequestError(400, "Current password is incorrect", "Bad Request", body);

    const result = getUserFacingError(err);

    expect(result.description).toBe("Current password is incorrect");
    expect(result.description).not.toBe("Bad Request");
  });

  it.each([
    [409, "Already exists"],
    [403, "Not allowed"],
    [404, "Not found"],
    [400, "Invalid request"],
    [503, "Server error — try again"],
    [418, "Something went wrong"],
  ])(
    "falls back by status class (%i) when there's no useful message or code",
    (status, expected) => {
      // A real machine code (SCREAMING_SNAKE) with no message and no
      // resource carries no human-readable content at all.
      const body = { error: "SOME_UNMAPPED_CODE" };
      const err = new ApiRequestError(status, "SOME_UNMAPPED_CODE", "", body);

      const result = getUserFacingError(err);

      expect(result.description).toBe(expected);
    },
  );

  it("formats Zod validation `details` into a readable sentence (VALIDATION_FAILED)", () => {
    const body = {
      error: ErrorCode.VALIDATION_FAILED,
      message: "Validation failed",
      details: [
        { path: ["databaseName"], message: "Required" },
        { path: ["environmentId"], message: "Invalid uuid" },
      ],
    };
    const err = new ApiRequestError(400, ErrorCode.VALIDATION_FAILED, body.message, body);

    const result = getUserFacingError(err);

    expect(result.description).toBe(
      "Validation failed: databaseName: Required, environmentId: Invalid uuid",
    );
  });

  it("falls back to the generic VALIDATION_FAILED message when details aren't a usable array", () => {
    const body = { error: ErrorCode.VALIDATION_FAILED, message: "Validation failed" };
    const err = new ApiRequestError(400, ErrorCode.VALIDATION_FAILED, body.message, body);

    expect(getUserFacingError(err).description).toBe("Validation failed");
  });

  it("uses ApiRequestError.message directly when there is no parsed body at all (e.g. a timeout)", () => {
    const err = new ApiRequestError(0, "TIMEOUT", "Request to /api/x timed out after 30000ms");

    const result = getUserFacingError(err);

    expect(result.description).toBe("Request to /api/x timed out after 30000ms");
  });

  it("turns a Phase 5 TLS_CERTIFICATE_NOT_FOUND 404 into its curated title", () => {
    // Mirrors the certificate domain's canonical envelope (DELETE/GET/renew
    // against a missing certificate ID) — server/src/routes/tls-certificates.ts.
    const body = {
      error: ErrorCode.TLS_CERTIFICATE_NOT_FOUND,
      message: "Certificate not found: cert-123",
      resource: { type: "tlsCertificate", id: "cert-123" },
      action: "Verify the certificate ID or check the certificates list.",
    };
    const err = new ApiRequestError(
      404,
      ErrorCode.TLS_CERTIFICATE_NOT_FOUND,
      body.message,
      body,
    );

    const result = getUserFacingError(err);

    expect(result.title).toBe("Certificate not found");
    expect(result.description).toBe("Certificate not found: cert-123");
    expect(result.action).toBe(
      "Verify the certificate ID or check the certificates list.",
    );
  });

  it("handles a plain Error gracefully", () => {
    const result = getUserFacingError(new Error("boom"));

    expect(result).toEqual({ title: "Something went wrong", description: "boom" });
  });

  it("handles a completely unknown thrown value gracefully", () => {
    expect(getUserFacingError("not an error")).toEqual({
      title: "Something went wrong",
      description: "An unexpected error occurred.",
    });
    expect(getUserFacingError(undefined)).toEqual({
      title: "Something went wrong",
      description: "An unexpected error occurred.",
    });
  });

  it("uses the curated title for API_KEY_NOT_FOUND over the resource-derived one (Phase 9)", () => {
    // Mirrors the real revoke/rotate/delete 404 envelope (see
    // api-keys-not-found.integration.test.ts on the server).
    const body = {
      error: ErrorCode.API_KEY_NOT_FOUND,
      message: "API key not found or not owned by user",
      resource: { type: "apiKey", id: "key-123" },
      action: "Check the key ID — it must belong to your account.",
    };
    const err = new ApiRequestError(404, ErrorCode.API_KEY_NOT_FOUND, body.message, body);

    const result = getUserFacingError(err);

    expect(result.title).toBe("API key not found");
    expect(result.description).toBe("API key not found or not owned by user");
    expect(result.action).toBe(body.action);
  });

  it("uses the curated title for AUTH_ACCOUNT_LOCKED on a 423 status the generic fallback doesn't cover (Phase 9)", () => {
    // 423 isn't one of statusClassFallback's mapped status classes, so
    // without a CODE_TITLES entry this would fall through to the generic
    // "Something went wrong".
    const body = {
      error: ErrorCode.AUTH_ACCOUNT_LOCKED,
      message: "Account locked. Try again in 42 minute(s).",
      action: "Wait for the lockout to expire, or use password recovery.",
    };
    const err = new ApiRequestError(423, ErrorCode.AUTH_ACCOUNT_LOCKED, body.message, body);

    const result = getUserFacingError(err);

    expect(result.title).toBe("Account locked");
    expect(result.description).toBe("Account locked. Try again in 42 minute(s).");
  describe("HAProxy domain (Phase 8)", () => {
    it("turns a missing-frontend 404 (curated CODE_TITLES entry) into an actionable title/description/action", () => {
      // Mirrors PUT/DELETE /api/haproxy/manual-frontends/:frontendName
      // acting on a frontend that doesn't exist (the domain's canonical
      // not-found action).
      const body = {
        error: ErrorCode.HAPROXY_FRONTEND_NOT_FOUND,
        message: "Frontend not found: manual_missing_abc123",
        resource: { type: "haproxyFrontend", name: "manual_missing_abc123" },
        action: "Refresh the page — the frontend may have already been removed.",
      };
      const err = new ApiRequestError(404, ErrorCode.HAPROXY_FRONTEND_NOT_FOUND, body.message, body);

      const result = getUserFacingError(err);

      expect(result.title).toBe("Frontend not found");
      expect(result.description).toBe("Frontend not found: manual_missing_abc123");
      expect(result.action).toBe(body.action);
    });

    it("turns a duplicate-hostname 409 (curated CODE_TITLES entry) into an actionable title/description", () => {
      // Mirrors PATCH /api/haproxy/frontends/:frontendName/routes/:routeId
      // colliding with an existing route's hostname on the same shared
      // frontend (the domain's canonical conflict action).
      const body = {
        error: ErrorCode.HAPROXY_HOSTNAME_IN_USE,
        message: "A route with this hostname already exists on this frontend",
        resource: { type: "haproxyRoute", name: "existing.example.com" },
        action: "Choose a different hostname.",
      };
      const err = new ApiRequestError(409, ErrorCode.HAPROXY_HOSTNAME_IN_USE, body.message, body);

      const result = getUserFacingError(err);

      expect(result.title).toBe("Hostname already in use");
      expect(result.description).toBe(body.message);
      expect(result.action).toBe("Choose a different hostname.");
    });

    it("sharpens the title from body.resource for a HAProxy code with no curated CODE_TITLES entry", () => {
      // HAPROXY_ROUTE_FRONTEND_MISMATCH intentionally has no curated title —
      // the resourceTitle() fallback (§4.4) should still produce a sensible
      // "HAProxy Route invalid" from the 400 status class + resource type.
      const body = {
        error: ErrorCode.HAPROXY_ROUTE_FRONTEND_MISMATCH,
        message: "Route does not belong to this frontend",
        resource: { type: "haproxyRoute", id: "route-1" },
      };
      const err = new ApiRequestError(400, ErrorCode.HAPROXY_ROUTE_FRONTEND_MISMATCH, body.message, body);

      const result = getUserFacingError(err);

      expect(result.title).toBe("Haproxy Route invalid");
      expect(result.description).toBe("Route does not belong to this frontend");
    });
  });
});

describe("toastApiError", () => {
  beforeEach(() => {
    toastErrorMock.mockClear();
  });

  it("renders a sonner error toast with the resolved title/description, folding `action` into the description", () => {
    const body = {
      error: ErrorCode.POSTGRES_BACKUP_CONFIG_EXISTS,
      message: "kumiko already has a backup configuration.",
      resource: { type: "postgresBackupConfig", name: "kumiko" },
      action: "Edit the existing backup config instead of creating a new one.",
    };
    const err = new ApiRequestError(
      409,
      ErrorCode.POSTGRES_BACKUP_CONFIG_EXISTS,
      body.message,
      body,
    );

    toastApiError(err);

    expect(toastErrorMock).toHaveBeenCalledOnce();
    const [title, options] = toastErrorMock.mock.calls[0] as [string, { description: string }];
    expect(title).toBe("Backup already configured");
    expect(options.description).toBe(
      "kumiko already has a backup configuration. Edit the existing backup config instead of creating a new one.",
    );
  });

  it("respects an explicit title override", () => {
    const err = new ApiRequestError(500, "INTERNAL", "boom");

    toastApiError(err, { title: "Custom title" });

    const [title] = toastErrorMock.mock.calls[0] as [string, unknown];
    expect(title).toBe("Custom title");
  });
});
