import { describe, it, expect, beforeEach, vi } from "vitest";
import { Readable } from "stream";

// ----- googleapis mock --------------------------------------------------------
// Build a fully synchronous, vi-tracked surface for `google.drive("v3")`.
// We mock at the module boundary so neither the backend nor the token manager
// actually hits Google.
const driveMocks = {
  filesList: vi.fn(),
  filesGet: vi.fn(),
  filesCreate: vi.fn(),
  filesDelete: vi.fn(),
  aboutGet: vi.fn(),
};

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        generateAuthUrl() {
          return "https://accounts.google.com/o/oauth2/v2/auth?mock";
        }
        async getToken() {
          return {
            tokens: {
              access_token: "mock-access-token",
              refresh_token: "mock-refresh-token",
              expiry_date: Date.now() + 60 * 60 * 1000,
            },
          };
        }
        async refreshAccessToken() {
          return {
            credentials: {
              access_token: "refreshed-access-token",
              refresh_token: "mock-refresh-token",
              expiry_date: Date.now() + 60 * 60 * 1000,
            },
          };
        }
      },
    },
    drive: vi.fn(() => ({
      files: {
        list: driveMocks.filesList,
        get: driveMocks.filesGet,
        create: driveMocks.filesCreate,
        delete: driveMocks.filesDelete,
      },
      about: {
        get: driveMocks.aboutGet,
      },
    })),
  },
}));

// Logger noise.
vi.mock("../../../../../lib/logger-factory", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ----- Test imports -----------------------------------------------------------
// Imports MUST come after vi.mock() so Vitest hoists the mocks correctly.
import { GoogleDriveBackend } from "../google-drive-backend";
import { GoogleDriveTokenManager } from "../google-drive-token-manager";

function buildPrismaStub() {
  return {
    connectivityStatus: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    systemSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      findFirst: vi.fn(),
    },
  } as unknown as import("../../../../../lib/prisma").PrismaClient;
}

function buildBackend(prisma: ReturnType<typeof buildPrismaStub>) {
  // Make the token manager always serve a valid token without touching Prisma.
  const tokens = new GoogleDriveTokenManager(prisma);
  vi.spyOn(tokens, "getValidAccessToken").mockResolvedValue("test-access-token");
  vi.spyOn(tokens, "getStoredTokens").mockResolvedValue({
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiryDate: new Date(Date.now() + 30 * 60 * 1000),
    accountEmail: "ops@example.com",
  });
  vi.spyOn(tokens, "setAccountEmail").mockResolvedValue(undefined);
  vi.spyOn(tokens, "buildOAuthClient").mockResolvedValue({
    refreshAccessToken: async () => ({
      accessToken: "refreshed",
      refreshToken: "test-refresh-token",
      expiryDate: new Date(Date.now() + 60 * 60 * 1000),
    }),
  } as never);
  return new GoogleDriveBackend(prisma, tokens, async () =>
    "https://example.com/api/storage/google-drive/oauth/callback",
  );
}

beforeEach(() => {
  for (const fn of Object.values(driveMocks)) fn.mockReset();
});

describe("GoogleDriveBackend.validate", () => {
  it("records a connected status when about.get succeeds", async () => {
    const prisma = buildPrismaStub();
    const backend = buildBackend(prisma);
    driveMocks.aboutGet.mockResolvedValue({
      data: { user: { emailAddress: "ops@example.com", displayName: "Ops" } },
    });
    const result = await backend.validate();
    expect(result.isValid).toBe(true);
    expect(result.message).toContain("ops@example.com");
    expect(prisma.connectivityStatus.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          service: "storage",
          status: "connected",
        }),
      }),
    );
  });

  it("records a failed status when about.get throws", async () => {
    const prisma = buildPrismaStub();
    const backend = buildBackend(prisma);
    driveMocks.aboutGet.mockRejectedValue(
      Object.assign(new Error("invalid_grant"), { code: "401" }),
    );
    const result = await backend.validate();
    expect(result.isValid).toBe(false);
    expect(prisma.connectivityStatus.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          service: "storage",
          status: "failed",
        }),
      }),
    );
  });
});

describe("GoogleDriveBackend.listLocations", () => {
  it("returns folders from drive.files.list", async () => {
    const prisma = buildPrismaStub();
    const backend = buildBackend(prisma);
    driveMocks.filesList.mockResolvedValue({
      data: {
        files: [
          {
            id: "fid-1",
            name: "backups",
            modifiedTime: "2026-04-01T00:00:00Z",
            parents: ["root"],
          },
          {
            id: "fid-2",
            name: "tls-certs",
            modifiedTime: "2026-04-02T00:00:00Z",
            parents: ["root"],
          },
        ],
      },
    });
    const folders = await backend.listLocations();
    expect(folders).toHaveLength(2);
    expect(folders[0].id).toBe("fid-1");
    expect(folders[0].displayName).toBe("backups");
    // Drive query: folder mime type + not trashed
    expect(driveMocks.filesList).toHaveBeenCalledWith(
      expect.objectContaining({
        q: expect.stringContaining(
          "mimeType='application/vnd.google-apps.folder'",
        ),
      }),
    );
  });
});

describe("GoogleDriveBackend.testLocationAccess", () => {
  it("returns accessible=true when probe-write + delete succeed", async () => {
    const prisma = buildPrismaStub();
    const backend = buildBackend(prisma);
    driveMocks.filesCreate.mockResolvedValue({
      data: { id: "probe-id", name: ".mini-infra-probe" },
    });
    driveMocks.filesDelete.mockResolvedValue({});
    driveMocks.filesGet.mockResolvedValue({ data: { name: "Backups" } });

    const info = await backend.testLocationAccess({ id: "fid-1" });
    expect(info.accessible).toBe(true);
    expect(info.displayName).toBe("Backups");
    expect(driveMocks.filesCreate).toHaveBeenCalled();
    expect(driveMocks.filesDelete).toHaveBeenCalledWith({ fileId: "probe-id" });
  });

  it("maps 404 from create to FOLDER_NOT_ACCESSIBLE", async () => {
    const prisma = buildPrismaStub();
    const backend = buildBackend(prisma);
    driveMocks.filesCreate.mockRejectedValue(
      Object.assign(new Error("File not found"), { code: "404" }),
    );
    const info = await backend.testLocationAccess({ id: "fid-1" });
    expect(info.accessible).toBe(false);
    const meta = info.metadata as { errorCode?: string };
    expect(meta.errorCode).toBe("FOLDER_NOT_ACCESSIBLE");
  });

  it("maps 403 from create to FOLDER_NOT_ACCESSIBLE", async () => {
    const prisma = buildPrismaStub();
    const backend = buildBackend(prisma);
    driveMocks.filesCreate.mockRejectedValue(
      Object.assign(new Error("forbidden"), { code: "403" }),
    );
    const info = await backend.testLocationAccess({ id: "fid-1" });
    expect(info.accessible).toBe(false);
    const meta = info.metadata as { errorCode?: string };
    expect(meta.errorCode).toBe("FOLDER_NOT_ACCESSIBLE");
  });
});

describe("GoogleDriveBackend.upload", () => {
  it("returns a path-shaped objectUrl mirroring Azure", async () => {
    const prisma = buildPrismaStub();
    const backend = buildBackend(prisma);
    driveMocks.filesCreate.mockResolvedValue({
      data: { id: "fid", size: "1024", md5Checksum: "abc" },
    });
    const result = await backend.upload(
      { id: "folder-1" },
      "test.dump",
      Buffer.from("hello"),
      5,
    );
    expect(result.objectUrl).toBe("folder-1/test.dump");
    expect(result.size).toBe(1024);
    expect(result.etag).toBe("abc");
  });
});

describe("GoogleDriveBackend.list", () => {
  it("filters by name prefix client-side", async () => {
    const prisma = buildPrismaStub();
    const backend = buildBackend(prisma);
    driveMocks.filesList.mockResolvedValue({
      data: {
        files: [
          { id: "1", name: "db1/backup-1.dump", size: "100", createdTime: "2026-04-01T00:00:00Z", modifiedTime: "2026-04-01T00:00:00Z" },
          { id: "2", name: "db2/backup-1.dump", size: "200", createdTime: "2026-04-02T00:00:00Z", modifiedTime: "2026-04-02T00:00:00Z" },
        ],
      },
    });
    const result = await backend.list(
      { id: "folder-1" },
      { prefix: "db1/" },
    );
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].name).toBe("db1/backup-1.dump");
  });
});

describe("GoogleDriveBackend.delete", () => {
  it("is idempotent on 404", async () => {
    const prisma = buildPrismaStub();
    const backend = buildBackend(prisma);
    // findFileIdByName returns null (no match) → delete returns silently.
    driveMocks.filesList.mockResolvedValue({ data: { files: [] } });
    await expect(
      backend.delete({ id: "folder" }, "missing.dump"),
    ).resolves.toBeUndefined();
    expect(driveMocks.filesDelete).not.toHaveBeenCalled();
  });
});

describe("GoogleDriveBackend.enforceRetention", () => {
  it("deletes files older than retentionDays", async () => {
    const prisma = buildPrismaStub();
    const backend = buildBackend(prisma);
    driveMocks.filesList.mockResolvedValue({
      data: {
        files: [
          { id: "old", name: "db/backup-old.dump", size: "100", createdTime: "2025-01-01T00:00:00Z" },
          { id: "old2", name: "db/backup-old2.dump", size: "200", createdTime: "2025-01-02T00:00:00Z" },
        ],
        nextPageToken: undefined,
      },
    });
    driveMocks.filesDelete.mockResolvedValue({});
    const result = await backend.enforceRetention(
      { id: "folder" },
      { retentionDays: 30 },
    );
    expect(result.deletedCount).toBe(2);
    expect(driveMocks.filesDelete).toHaveBeenCalledTimes(2);
  });
});

describe("GoogleDriveBackend.mintUploadHandle", () => {
  it("returns a google-drive-token bundle when the existing token has enough TTL", async () => {
    const prisma = buildPrismaStub();
    const tokens = new GoogleDriveTokenManager(prisma);
    vi.spyOn(tokens, "getValidAccessToken").mockResolvedValue("long-token");
    vi.spyOn(tokens, "getStoredTokens").mockResolvedValue({
      accessToken: "long-token",
      refreshToken: "refresh",
      // Plenty of life left — backend shouldn't pre-emptively refresh.
      expiryDate: new Date(Date.now() + 6 * 60 * 60 * 1000),
      accountEmail: null,
    });
    const { GoogleDriveBackend } = await import("../google-drive-backend");
    const backend = new GoogleDriveBackend(prisma, tokens, async () =>
      "https://example.com/api/storage/google-drive/oauth/callback",
    );
    const handle = await backend.mintUploadHandle(
      { id: "folder-1" },
      "backup.dump",
      60,
    );
    expect(handle.kind).toBe("google-drive-token");
    expect((handle.payload as { folderId: string }).folderId).toBe("folder-1");
    expect((handle.payload as { fileName: string }).fileName).toBe(
      "backup.dump",
    );
    expect((handle.payload as { accessToken: string }).accessToken).toBe(
      "long-token",
    );
  });

  it("pre-emptively refreshes when the stored token won't last the requested TTL", async () => {
    const prisma = buildPrismaStub();
    const tokens = new GoogleDriveTokenManager(prisma);
    vi.spyOn(tokens, "getValidAccessToken").mockResolvedValue("near-expiry");
    vi.spyOn(tokens, "getStoredTokens")
      // Pre-refresh: stale-ish, ~30 min remaining.
      .mockResolvedValueOnce({
        accessToken: "near-expiry",
        refreshToken: "refresh",
        expiryDate: new Date(Date.now() + 30 * 60 * 1000),
        accountEmail: null,
      })
      // Post-refresh: fresh token.
      .mockResolvedValue({
        accessToken: "freshly-refreshed",
        refreshToken: "refresh",
        expiryDate: new Date(Date.now() + 60 * 60 * 1000),
        accountEmail: null,
      });
    vi.spyOn(tokens, "buildOAuthClient").mockResolvedValue({
      refreshAccessToken: async () => ({
        accessToken: "freshly-refreshed",
        refreshToken: "refresh",
        expiryDate: new Date(Date.now() + 60 * 60 * 1000),
      }),
    } as never);
    vi.spyOn(tokens, "storeTokens").mockResolvedValue();
    const { GoogleDriveBackend } = await import("../google-drive-backend");
    const backend = new GoogleDriveBackend(prisma, tokens, async () =>
      "https://example.com/api/storage/google-drive/oauth/callback",
    );
    const handle = await backend.mintUploadHandle(
      { id: "folder-1" },
      "backup.dump",
      60,
    );
    expect((handle.payload as { accessToken: string }).accessToken).toBe(
      "freshly-refreshed",
    );
  });
});

describe("GoogleDriveBackend.getDownloadStream", () => {
  it("streams the file via alt=media", async () => {
    const prisma = buildPrismaStub();
    const backend = buildBackend(prisma);
    driveMocks.filesList.mockResolvedValue({ data: { files: [{ id: "f-id" }] } });
    driveMocks.filesGet.mockImplementation(async (params) => {
      if (params?.alt === "media") {
        return { data: Readable.from(Buffer.from("DUMP DATA")) };
      }
      return {
        data: { name: "test.dump", size: "9", mimeType: "application/octet-stream" },
      };
    });
    const result = await backend.getDownloadStream({ id: "folder" }, "test.dump");
    expect(result.contentLength).toBe(9);
    expect(result.fileName).toBe("test.dump");
  });
});
