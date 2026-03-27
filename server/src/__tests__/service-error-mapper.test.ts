import { describe, it, expect } from "vitest";
import { toServiceError } from "../lib/service-error-mapper";

describe("toServiceError", () => {
  describe("Cloudflare errors", () => {
    it("maps 403 authentication error", () => {
      const sdkError = Object.assign(
        new Error(
          '403 {"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}',
        ),
        {
          status: 403,
          errors: [{ code: 10000, message: "Authentication error" }],
        },
      );
      const result = toServiceError(sdkError, "cloudflare");
      expect(result.statusCode).toBe(403);
      expect(result.message).toContain("Cloudflare API token");
      expect(result.message).toContain("permission");
      expect(result.serviceName).toBe("cloudflare");
    });

    it("maps 401 invalid token", () => {
      const sdkError = Object.assign(new Error("401 Unauthorized"), {
        status: 401,
      });
      const result = toServiceError(sdkError, "cloudflare");
      expect(result.statusCode).toBe(401);
      expect(result.message).toContain("invalid");
      expect(result.serviceName).toBe("cloudflare");
    });

    it("maps 429 rate limit", () => {
      const sdkError = Object.assign(new Error("429 Too Many Requests"), {
        status: 429,
      });
      const result = toServiceError(sdkError, "cloudflare");
      expect(result.statusCode).toBe(429);
      expect(result.message).toContain("rate limit");
      expect(result.serviceName).toBe("cloudflare");
    });

    it("maps timeout errors", () => {
      const err = new Error("Tunnel creation timeout");
      const result = toServiceError(err, "cloudflare");
      expect(result.statusCode).toBe(504);
      expect(result.message).toContain("timed out");
    });
  });

  describe("Azure errors", () => {
    it("maps authentication failure", () => {
      const sdkError = Object.assign(new Error("AuthenticationFailed"), {
        statusCode: 403,
        code: "AuthenticationFailed",
      });
      const result = toServiceError(sdkError, "azure");
      expect(result.statusCode).toBe(403);
      expect(result.message).toContain("Azure");
      expect(result.serviceName).toBe("azure");
    });
  });

  describe("Docker errors", () => {
    it("maps 404 not found", () => {
      const sdkError = Object.assign(
        new Error("(HTTP code 404) no such container"),
        { statusCode: 404 },
      );
      const result = toServiceError(sdkError, "docker");
      expect(result.statusCode).toBe(404);
      expect(result.message).toContain("not found");
      expect(result.serviceName).toBe("docker");
    });

    it("maps 409 conflict", () => {
      const sdkError = Object.assign(
        new Error("(HTTP code 409) conflict - container already exists"),
        { statusCode: 409 },
      );
      const result = toServiceError(sdkError, "docker");
      expect(result.statusCode).toBe(409);
      expect(result.message).toContain("conflict");
    });
  });

  describe("GitHub errors", () => {
    it("maps 401 bad credentials", () => {
      const sdkError = Object.assign(new Error("Bad credentials"), {
        status: 401,
      });
      const result = toServiceError(sdkError, "github");
      expect(result.statusCode).toBe(401);
      expect(result.message).toContain("GitHub");
    });
  });

  describe("unknown errors", () => {
    it("wraps non-Error values", () => {
      const result = toServiceError("string error", "cloudflare");
      expect(result.statusCode).toBe(502);
      expect(result.message).toBe("Cloudflare service error: string error");
    });

    it("preserves original message for unrecognized errors", () => {
      const err = new Error("Something completely unexpected");
      const result = toServiceError(err, "cloudflare");
      expect(result.statusCode).toBe(502);
      expect(result.message).toBe(
        "Cloudflare service error: Something completely unexpected",
      );
    });
  });
});
