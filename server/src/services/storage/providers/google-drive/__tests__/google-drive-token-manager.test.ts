import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { internalSecrets } from "../../../../../lib/security-config";
import { CryptoError } from "../../../../../lib/crypto";

beforeAll(() => {
  if (!internalSecrets.isInitialized()) {
    internalSecrets.setAuthSecret("test-auth-secret-for-drive-token-manager");
  }
});

vi.mock("../../../../../lib/logger-factory", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// We don't want googleapis touching the network in these tests, even though
// the manager itself only calls into `GoogleDriveOAuthClient` lazily via
// `buildOAuthClient` — guard against incidental imports.
vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        async getToken() {
          return { tokens: {} };
        }
        async refreshAccessToken() {
          return {
            credentials: {
              access_token: "refreshed-token",
              refresh_token: "test-refresh-token",
              expiry_date: Date.now() + 60 * 60 * 1000,
            },
          };
        }
        generateAuthUrl() {
          return "https://accounts.google.com/o/oauth2/v2/auth?mock";
        }
      },
    },
    drive: vi.fn(),
  },
}));

import { GoogleDriveTokenManager } from "../google-drive-token-manager";

function buildPrisma() {
  return {
    systemSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn(),
    },
    connectivityStatus: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  } as unknown as import("../../../../../lib/prisma").PrismaClient;
}

describe("GoogleDriveTokenManager.getValidAccessToken", () => {
  it("returns the stored token when not near expiry", async () => {
    const prisma = buildPrisma();
    const mgr = new GoogleDriveTokenManager(prisma);
    vi.spyOn(mgr, "getStoredTokens").mockResolvedValue({
      accessToken: "fresh-token",
      refreshToken: "refresh",
      expiryDate: new Date(Date.now() + 30 * 60 * 1000),
      accountEmail: null,
    });
    const result = await mgr.getValidAccessToken(
      "https://example.com/callback",
    );
    expect(result).toBe("fresh-token");
  });

  it("refreshes the token when near expiry", async () => {
    const prisma = buildPrisma();
    const mgr = new GoogleDriveTokenManager(prisma);
    vi.spyOn(mgr, "getStoredTokens").mockResolvedValue({
      accessToken: "stale-token",
      refreshToken: "refresh",
      expiryDate: new Date(Date.now() + 60 * 1000), // 1 minute from now
      accountEmail: null,
    });
    vi.spyOn(mgr, "buildOAuthClient").mockResolvedValue({
      refreshAccessToken: async () => ({
        accessToken: "refreshed-token",
        refreshToken: "refresh",
        expiryDate: new Date(Date.now() + 60 * 60 * 1000),
      }),
    } as never);
    vi.spyOn(mgr, "storeTokens").mockResolvedValue();
    const result = await mgr.getValidAccessToken(
      "https://example.com/callback",
    );
    expect(result).toBe("refreshed-token");
  });

  it("returns null and records connectivity when refresh token is missing", async () => {
    const prisma = buildPrisma();
    const mgr = new GoogleDriveTokenManager(prisma);
    vi.spyOn(mgr, "getStoredTokens").mockResolvedValue({
      accessToken: "expiring",
      refreshToken: null,
      expiryDate: new Date(Date.now() + 60 * 1000),
      accountEmail: null,
    });
    const result = await mgr.getValidAccessToken(
      "https://example.com/callback",
    );
    expect(result).toBeNull();
    expect(prisma.connectivityStatus.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          service: "storage",
          status: "failed",
          errorCode: "REFRESH_TOKEN_MISSING",
        }),
      }),
    );
  });

  it("returns null + connectivity row when refresh fails", async () => {
    const prisma = buildPrisma();
    const mgr = new GoogleDriveTokenManager(prisma);
    vi.spyOn(mgr, "getStoredTokens").mockResolvedValue({
      accessToken: "expiring",
      refreshToken: "refresh",
      expiryDate: new Date(Date.now() + 60 * 1000),
      accountEmail: null,
    });
    vi.spyOn(mgr, "buildOAuthClient").mockResolvedValue({
      refreshAccessToken: async () => {
        throw new Error("invalid_grant");
      },
    } as never);
    const result = await mgr.getValidAccessToken(
      "https://example.com/callback",
    );
    expect(result).toBeNull();
    expect(prisma.connectivityStatus.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          errorCode: "TOKEN_REFRESH_FAILED",
        }),
      }),
    );
  });
});

describe("GoogleDriveTokenManager.getStoredTokens decrypt failure", () => {
  it("returns null and records unauthorized on CryptoError", async () => {
    const prisma = buildPrisma();
    const mgr = new GoogleDriveTokenManager(prisma);
    // Force the decrypt path to throw. `getSecure` is on the base class.
    vi.spyOn(mgr, "getSecure").mockRejectedValue(
      new CryptoError("decrypt failed"),
    );
    const result = await mgr.getStoredTokens();
    expect(result).toBeNull();
    expect(prisma.connectivityStatus.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          errorCode: "TOKEN_DECRYPT_FAILED",
        }),
      }),
    );
  });
});
