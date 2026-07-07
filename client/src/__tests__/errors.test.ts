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
