/**
 * Google Drive backend for the pluggable Storage provider.
 *
 * Mirrors the Azure backend's surface but talks to Drive v3 via `googleapis`.
 *
 * Key behaviours:
 *  - Uses scope `drive.file` only — Drive only sees folders/files this app
 *    created or was explicitly given access to. External folders surface as
 *    "404 File not found" or "403 forbidden"; we map both to a clear "folder
 *    not accessible" error and offer "Create folder via Mini Infra" in the
 *    UI.
 *  - Connectivity is recorded under `service="storage"` (matches Azure).
 *  - `getDownloadHandle` is intentionally absent — Drive has no SAS-equivalent.
 *    Routes that need a download fall back to streaming via
 *    `getDownloadStream`.
 *  - `mintUploadHandle` returns a credential bundle for the `pg-az-backup`
 *    sidecar — `accessToken` (TTL ≥ requested), `folderId`, `fileName`. The
 *    sidecar uses Drive's resumable-upload protocol with the token directly.
 *  - Retention is enforced *client-side* (Drive has no native age-based
 *    sweep): list → filter by `createdTime` → delete each.
 */

import { google, drive_v3 } from "googleapis";
import { Readable } from "stream";
import type { PrismaClient } from "../../../../lib/prisma";
import { getLogger } from "../../../../lib/logger-factory";
import type {
  ConnectivityStatusType,
  ServiceHealthStatus,
  ValidationResult,
  StorageBackend,
  StorageLocationRef,
  StorageObjectMetadata,
  ListResult,
  LocationInfo,
  UploadHandle,
  UploadOptions,
  UploadResult,
  DownloadStream,
  ProviderMetadata,
  RetentionEnforcementResult,
  RetentionPolicy,
} from "@mini-infra/types";
import { GoogleDriveTokenManager } from "./google-drive-token-manager";

const log = () => getLogger("integrations", "google-drive-backend");

/**
 * Resolves the redirect URI used to refresh tokens. The token-refresh
 * endpoint at Google doesn't actually use the redirect URI, but `googleapis`
 * still requires the OAuth2Client to be constructed with one — keeping it
 * deterministic ensures we never accidentally drift between authorize and
 * refresh.
 */
type RedirectUriResolver = () => Promise<string>;

// Drive access tokens are typically valid for an hour from issue, but Google
// does not honour an arbitrary explicit TTL on an OAuth access token — we
// just ensure the *current* token has at least the requested life remaining
// (refreshing if not). The refresh-leeway window already lives inside
// `getValidAccessToken`; we don't add a second buffer at the call site.

export class GoogleDriveBackend implements StorageBackend {
  readonly providerId = "google-drive" as const;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly tokens: GoogleDriveTokenManager,
    private readonly resolveRedirectUri: RedirectUriResolver,
  ) {}

  // ====================
  // Internal — drive client wiring
  // ====================

  /**
   * Build a `drive_v3.Drive` client backed by a guaranteed-fresh access
   * token. Returns null when the provider isn't connected (caller surfaces
   * the appropriate error to the route).
   */
  private async buildDriveClient(): Promise<drive_v3.Drive | null> {
    const redirectUri = await this.resolveRedirectUri();
    const accessToken = await this.tokens.getValidAccessToken(redirectUri);
    if (!accessToken) return null;
    const oauth = new google.auth.OAuth2();
    oauth.setCredentials({ access_token: accessToken });
    return google.drive({ version: "v3", auth: oauth });
  }

  /**
   * Same as {@link buildDriveClient} but throws a clear error if not
   * connected. Use when the call site needs the client and "not connected"
   * is a 5xx rather than an empty success.
   */
  private async requireDriveClient(): Promise<drive_v3.Drive> {
    const client = await this.buildDriveClient();
    if (!client) {
      throw new Error(
        "Google Drive provider is not connected — run the OAuth flow first",
      );
    }
    return client;
  }

  /**
   * Pull `code/status` out of a googleapis error consistently. We don't lean
   * on `instanceof GaxiosError` because (a) googleapis ships multiple gaxios
   * versions in different release lines, and (b) tests mock the surface with
   * plain Error subclasses. Any error with a numeric `code` or a
   * `response.status` is treated as a Drive HTTP error.
   */
  private extractDriveErrorInfo(error: unknown): {
    status: number | undefined;
    message: string;
  } {
    if (error && typeof error === "object") {
      const e = error as {
        code?: unknown;
        response?: { status?: unknown };
        message?: unknown;
      };
      const codeNum =
        typeof e.code === "number"
          ? e.code
          : typeof e.code === "string"
            ? Number(e.code)
            : undefined;
      const responseStatus =
        typeof e.response?.status === "number"
          ? e.response.status
          : undefined;
      const status =
        codeNum !== undefined && Number.isFinite(codeNum)
          ? codeNum
          : responseStatus;
      return {
        status,
        message:
          typeof e.message === "string"
            ? e.message
            : error instanceof Error
              ? error.message
              : "Unknown error",
      };
    }
    return {
      status: undefined,
      message: "Unknown error",
    };
  }

  // ====================
  // StorageBackend — validate, health, metadata
  // ====================

  async validate(): Promise<ValidationResult> {
    const start = Date.now();
    try {
      const drive = await this.buildDriveClient();
      if (!drive) {
        const message =
          "Google Drive is not connected. Configure client credentials and run the OAuth flow.";
        await this.recordConnectivityStatus(
          "failed",
          Date.now() - start,
          message,
          "NOT_CONNECTED",
        );
        return {
          isValid: false,
          message,
          errorCode: "NOT_CONNECTED",
          responseTimeMs: Date.now() - start,
        };
      }
      const about = await drive.about.get({ fields: "user" });
      const email = about.data.user?.emailAddress ?? null;
      if (email) {
        await this.tokens.setAccountEmail(email, "system");
      }
      const metadata: Record<string, unknown> = {
        accountEmail: email,
        displayName: about.data.user?.displayName,
      };
      const responseTime = Date.now() - start;
      await this.recordConnectivityStatus(
        "connected",
        responseTime,
        undefined,
        undefined,
        metadata,
      );
      return {
        isValid: true,
        message: email
          ? `Google Drive connected as ${email}`
          : "Google Drive connected",
        responseTimeMs: responseTime,
        metadata,
      };
    } catch (error) {
      const { status, message } = this.extractDriveErrorInfo(error);
      let connectivityStatus: ConnectivityStatusType = "failed";
      let errorCode = "GOOGLE_DRIVE_ERROR";
      if (status === 401 || status === 403) errorCode = "UNAUTHORIZED";
      else if (status === 429) errorCode = "RATE_LIMITED";
      else if (
        message.includes("ENOTFOUND") ||
        message.includes("ECONNREFUSED") ||
        message.includes("getaddrinfo")
      ) {
        errorCode = "NETWORK_ERROR";
        connectivityStatus = "unreachable";
      } else if (message.toLowerCase().includes("timeout")) {
        errorCode = "TIMEOUT";
        connectivityStatus = "timeout";
      }
      const responseTime = Date.now() - start;
      const result: ValidationResult = {
        isValid: false,
        message: `Google Drive validation failed: ${message}`,
        errorCode,
        responseTimeMs: responseTime,
      };
      await this.recordConnectivityStatus(
        connectivityStatus,
        responseTime,
        result.message,
        errorCode,
      );
      log().error({ error: message, errorCode }, "Google Drive validate failed");
      return result;
    }
  }

  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const row = await this.prisma.connectivityStatus.findFirst({
      where: { service: "storage" },
      orderBy: { checkedAt: "desc" },
    });
    if (!row) {
      return { service: "storage", status: "failed", lastChecked: new Date() };
    }
    return {
      service: "storage",
      status: row.status as ConnectivityStatusType,
      lastChecked: row.checkedAt,
      lastSuccessful: row.lastSuccessfulAt ?? undefined,
      responseTime:
        row.responseTimeMs != null ? Number(row.responseTimeMs) : undefined,
      errorMessage: row.errorMessage ?? undefined,
      errorCode: row.errorCode ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  async getProviderMetadata(): Promise<ProviderMetadata> {
    const snapshot = await this.tokens.getStoredTokens();
    return {
      accountLabel: snapshot?.accountEmail ?? "Google Drive",
      providerId: this.providerId,
      accountEmail: snapshot?.accountEmail ?? null,
    };
  }

  // ====================
  // StorageBackend — locations
  // ====================

  async listLocations(opts?: {
    search?: string;
    limit?: number;
  }): Promise<LocationInfo[]> {
    const limit = opts?.limit ?? 50;
    const drive = await this.buildDriveClient();
    if (!drive) return [];
    const search = opts?.search?.trim();
    const qParts = [
      "mimeType='application/vnd.google-apps.folder'",
      "trashed=false",
    ];
    if (search) {
      // Escape single quotes per Drive query syntax: ' → \'
      const safe = search.replace(/'/g, "\\'");
      qParts.push(`name contains '${safe}'`);
    }
    try {
      const res = await drive.files.list({
        q: qParts.join(" and "),
        pageSize: Math.min(limit, 1000),
        fields: "files(id, name, modifiedTime, parents)",
        spaces: "drive",
      });
      return (res.data.files ?? [])
        .filter((f): f is drive_v3.Schema$File => !!f.id)
        .map((f) => ({
          id: f.id!,
          displayName: f.name ?? f.id!,
          lastModified: f.modifiedTime ?? undefined,
          accessible: true,
          metadata: { parents: f.parents ?? [] },
        }));
    } catch (error) {
      const { message } = this.extractDriveErrorInfo(error);
      log().error({ error: message }, "Failed to list Google Drive folders");
      return [];
    }
  }

  async testLocationAccess(ref: StorageLocationRef): Promise<LocationInfo> {
    const start = Date.now();
    const drive = await this.requireDriveClient();
    const probeName = `.mini-infra-probe-${Date.now()}`;
    try {
      // Probe write: create a zero-byte file in the folder, then immediately
      // delete it. This catches both 404 (folder not visible to drive.file
      // scope) and 403 (folder visible but write-forbidden) in one shot.
      const created = await drive.files.create({
        requestBody: {
          name: probeName,
          parents: [ref.id],
          mimeType: "application/octet-stream",
        },
        media: {
          mimeType: "application/octet-stream",
          body: Readable.from(Buffer.alloc(0)),
        },
        fields: "id, name",
      });
      const fileId = created.data.id;
      if (fileId) {
        try {
          await drive.files.delete({ fileId });
        } catch (deleteError) {
          // Probe write succeeded → location is writable. A delete failure is
          // worth logging but not enough to fail the test (the file is small
          // and named for easy manual cleanup).
          log().warn(
            {
              fileId,
              error:
                deleteError instanceof Error
                  ? deleteError.message
                  : "Unknown error",
            },
            "Failed to clean up Drive probe-write file",
          );
        }
      }
      // Try to fetch the folder metadata for the displayName.
      let displayName = ref.id;
      try {
        const folder = await drive.files.get({
          fileId: ref.id,
          fields: "name",
        });
        if (folder.data.name) displayName = folder.data.name;
      } catch {
        // Non-fatal — display the ID if metadata fetch fails.
      }
      return {
        id: ref.id,
        displayName,
        accessible: true,
        metadata: { responseTimeMs: Date.now() - start },
      };
    } catch (error) {
      const { status, message } = this.extractDriveErrorInfo(error);
      let errorCode = "DRIVE_FOLDER_ACCESS_ERROR";
      if (status === 404 || status === 403) {
        errorCode = "FOLDER_NOT_ACCESSIBLE";
      } else if (status === 401) {
        errorCode = "UNAUTHORIZED";
      }
      log().warn(
        { folderId: ref.id, status, errorCode, error: message },
        "Google Drive folder probe-write failed",
      );
      return {
        id: ref.id,
        displayName: ref.id,
        accessible: false,
        metadata: {
          responseTimeMs: Date.now() - start,
          error: message,
          errorCode,
          status,
        },
      };
    }
  }

  /**
   * Create a folder under the user's My Drive root (within the `drive.file`
   * scope so we can see it later). Used by the frontend's "Create folder via
   * Mini Infra" helper when the operator can't (or shouldn't) hand us an
   * existing folder.
   */
  async createFolder(name: string): Promise<LocationInfo> {
    if (!name.trim()) throw new Error("Folder name is required");
    const drive = await this.requireDriveClient();
    const created = await drive.files.create({
      requestBody: {
        name: name.trim(),
        mimeType: "application/vnd.google-apps.folder",
      },
      fields: "id, name, modifiedTime",
    });
    if (!created.data.id) {
      throw new Error("Drive folder creation returned no id");
    }
    return {
      id: created.data.id,
      displayName: created.data.name ?? name,
      lastModified: created.data.modifiedTime ?? undefined,
      accessible: true,
    };
  }

  // ====================
  // StorageBackend — list / head / upload / download / delete
  // ====================

  async list(
    ref: StorageLocationRef,
    opts?: { prefix?: string; limit?: number },
  ): Promise<ListResult> {
    const limit = opts?.limit ?? 100;
    const drive = await this.requireDriveClient();
    const qParts = [`'${ref.id}' in parents`, "trashed=false"];
    if (opts?.prefix) {
      const safe = opts.prefix.replace(/'/g, "\\'");
      qParts.push(`name contains '${safe}'`);
    }
    try {
      const res = await drive.files.list({
        q: qParts.join(" and "),
        pageSize: Math.min(limit, 1000),
        fields:
          "files(id, name, size, mimeType, md5Checksum, createdTime, modifiedTime), nextPageToken",
        spaces: "drive",
        orderBy: "createdTime desc",
      });
      const files = res.data.files ?? [];
      const objects: StorageObjectMetadata[] = files
        .filter((f) => !!f.name)
        // Drive's `name contains` is a substring match, but our contract says
        // prefix; filter post-hoc.
        .filter((f) =>
          opts?.prefix ? (f.name ?? "").startsWith(opts.prefix) : true,
        )
        .map((f) => ({
          name: f.name!,
          size: f.size ? Number(f.size) : 0,
          contentType: f.mimeType ?? undefined,
          contentMD5: f.md5Checksum ?? undefined,
          createdAt: f.createdTime ? new Date(f.createdTime) : undefined,
          lastModified: f.modifiedTime ? new Date(f.modifiedTime) : undefined,
          metadata: f.id ? { driveFileId: f.id } : undefined,
        }));
      return {
        objects,
        hasMore: !!res.data.nextPageToken,
        nextCursor: res.data.nextPageToken ?? undefined,
      };
    } catch (error) {
      const { message } = this.extractDriveErrorInfo(error);
      log().error(
        { folderId: ref.id, prefix: opts?.prefix, error: message },
        "Failed to list Drive files",
      );
      throw new Error(`Failed to list Drive files: ${message}`, {
        cause: error,
      });
    }
  }

  async head(
    ref: StorageLocationRef,
    name: string,
  ): Promise<StorageObjectMetadata | null> {
    const fileId = await this.findFileIdByName(ref.id, name);
    if (!fileId) return null;
    const drive = await this.requireDriveClient();
    try {
      const res = await drive.files.get({
        fileId,
        fields:
          "id, name, size, mimeType, md5Checksum, createdTime, modifiedTime",
      });
      const f = res.data;
      return {
        name: f.name ?? name,
        size: f.size ? Number(f.size) : 0,
        contentType: f.mimeType ?? undefined,
        contentMD5: f.md5Checksum ?? undefined,
        createdAt: f.createdTime ? new Date(f.createdTime) : undefined,
        lastModified: f.modifiedTime ? new Date(f.modifiedTime) : undefined,
        metadata: f.id ? { driveFileId: f.id } : undefined,
      };
    } catch (error) {
      const { status, message } = this.extractDriveErrorInfo(error);
      if (status === 404) return null;
      log().error({ folderId: ref.id, name, error: message }, "Drive head failed");
      throw new Error(`Drive head failed: ${message}`, { cause: error });
    }
  }

  async upload(
    ref: StorageLocationRef,
    name: string,
    body: unknown,
    size: number,
    opts?: UploadOptions,
  ): Promise<UploadResult> {
    const drive = await this.requireDriveClient();
    const mimeType = opts?.contentType ?? "application/octet-stream";
    const stream =
      Buffer.isBuffer(body)
        ? Readable.from(body)
        : (body as NodeJS.ReadableStream);
    try {
      // googleapis automatically uses resumable-upload for non-trivial sizes.
      const res = await drive.files.create({
        requestBody: {
          name,
          parents: [ref.id],
          mimeType,
        },
        media: {
          mimeType,
          body: stream,
        },
        fields: "id, name, size, md5Checksum",
      });
      // Mirror Azure's path-shaped objectUrl so `parseBackupUrl()` works
      // uniformly: `<folderId>/<fileName>`. Drive has no public URL we can
      // hand a downloader; routes detect the absence of `getDownloadHandle`
      // and stream via `getDownloadStream`.
      return {
        objectUrl: `${ref.id}/${name}`,
        size: res.data.size ? Number(res.data.size) : size,
        etag: res.data.md5Checksum ?? undefined,
      };
    } catch (error) {
      const { message } = this.extractDriveErrorInfo(error);
      log().error(
        { folderId: ref.id, name, error: message },
        "Failed to upload to Google Drive",
      );
      throw new Error(`Drive upload failed: ${message}`, { cause: error });
    }
  }

  async getDownloadStream(
    ref: StorageLocationRef,
    name: string,
  ): Promise<DownloadStream> {
    const fileId = await this.findFileIdByName(ref.id, name);
    if (!fileId) {
      throw new Error(`Drive file '${name}' not found in folder '${ref.id}'`);
    }
    const drive = await this.requireDriveClient();
    const meta = await drive.files.get({
      fileId,
      fields: "name, size, mimeType",
    });
    const stream = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" },
    );
    return {
      stream: stream.data,
      contentLength: meta.data.size ? Number(meta.data.size) : 0,
      contentType: meta.data.mimeType ?? undefined,
      fileName: meta.data.name ?? name,
    };
  }

  // Drive intentionally does NOT implement `getDownloadHandle` — there is no
  // SAS-equivalent. Routes detect the absent method and stream via
  // `getDownloadStream`.

  async mintUploadHandle(
    ref: StorageLocationRef,
    name: string,
    ttlMinutes: number,
  ): Promise<UploadHandle> {
    const redirectUri = await this.resolveRedirectUri();
    let accessToken = await this.tokens.getValidAccessToken(redirectUri);
    if (!accessToken) {
      throw new Error(
        "Google Drive provider is not connected — cannot mint upload handle",
      );
    }
    // If the existing token has less than the requested TTL remaining, force
    // a refresh so the sidecar gets a token that lasts the whole upload.
    const snapshot = await this.tokens.getStoredTokens();
    const remainingMs =
      (snapshot?.expiryDate?.getTime() ?? 0) - Date.now();
    const requiredMs = Math.max(ttlMinutes, 1) * 60 * 1000;
    if (remainingMs < requiredMs && snapshot?.refreshToken) {
      const oauthClient = await this.tokens.buildOAuthClient(redirectUri);
      if (oauthClient) {
        try {
          const refreshed = await oauthClient.refreshAccessToken(
            snapshot.refreshToken,
          );
          await this.tokens.storeTokens(refreshed, "system");
          accessToken = refreshed.accessToken;
        } catch (error) {
          // Refresh failed; fall through and use the older token. The
          // sidecar will surface a clear error if Google rejects it.
          log().warn(
            {
              error:
                error instanceof Error ? error.message : "Unknown error",
            },
            "Failed to pre-emptively refresh Google Drive token for sidecar",
          );
        }
      }
    }
    const fresh = await this.tokens.getStoredTokens();
    const expiresAt =
      fresh?.expiryDate ?? new Date(Date.now() + ttlMinutes * 60 * 1000);
    return {
      kind: "google-drive-token",
      payload: {
        accessToken,
        folderId: ref.id,
        fileName: name,
      },
      expiresAt,
    };
  }

  async delete(ref: StorageLocationRef, name: string): Promise<void> {
    const fileId = await this.findFileIdByName(ref.id, name);
    if (!fileId) return; // idempotent
    const drive = await this.requireDriveClient();
    try {
      await drive.files.delete({ fileId });
    } catch (error) {
      const { status, message } = this.extractDriveErrorInfo(error);
      if (status === 404) return; // already gone — idempotent
      log().error(
        { folderId: ref.id, name, status, error: message },
        "Failed to delete Drive file",
      );
      throw new Error(`Drive delete failed: ${message}`, { cause: error });
    }
  }

  // ====================
  // StorageBackend — retention
  // ====================

  /**
   * Drive does retention *client-side*: list → filter by `createdTime` older
   * than cutoff (and optional `databaseName` prefix) → delete each. Azure
   * does the equivalent server-side via `listBlobsFlat` + `delete`; the
   * interface is identical, the implementation differs.
   */
  async enforceRetention(
    ref: StorageLocationRef,
    policy: RetentionPolicy,
  ): Promise<RetentionEnforcementResult> {
    const drive = await this.requireDriveClient();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - policy.retentionDays);

    const namePrefix = (() => {
      const base = policy.pathPrefix ?? "";
      if (policy.databaseName) {
        return base ? `${base}/${policy.databaseName}` : policy.databaseName;
      }
      return base;
    })();

    const deletedFiles: string[] = [];
    const errors: string[] = [];
    let totalSizeFreed = 0;

    let pageToken: string | undefined;
    do {
      try {
        const res: import("gaxios").GaxiosResponse<drive_v3.Schema$FileList> =
          await drive.files.list({
            q: `'${ref.id}' in parents and trashed=false and createdTime < '${cutoff.toISOString()}'`,
            fields: "files(id, name, size, createdTime), nextPageToken",
            pageSize: 1000,
            pageToken,
            spaces: "drive",
          });
        for (const f of res.data.files ?? []) {
          if (!f.id || !f.name) continue;
          if (namePrefix && !f.name.startsWith(namePrefix)) continue;
          try {
            await drive.files.delete({ fileId: f.id });
            deletedFiles.push(f.name);
            totalSizeFreed += f.size ? Number(f.size) : 0;
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            errors.push(`Failed to delete ${f.name}: ${msg}`);
            log().warn(
              { fileId: f.id, error: msg },
              "Drive retention delete failed",
            );
          }
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } catch (error) {
        const { message } = this.extractDriveErrorInfo(error);
        errors.push(`Drive list during retention failed: ${message}`);
        log().error(
          { folderId: ref.id, error: message },
          "Drive retention list page failed",
        );
        break;
      }
    } while (pageToken);

    log().info(
      {
        folderId: ref.id,
        retentionDays: policy.retentionDays,
        pathPrefix: policy.pathPrefix,
        databaseName: policy.databaseName,
        deletedCount: deletedFiles.length,
        totalSizeFreed,
        errorCount: errors.length,
      },
      "Drive retention sweep complete",
    );

    return {
      deletedFiles,
      deletedCount: deletedFiles.length,
      totalSizeFreed,
      errors,
    };
  }

  // ====================
  // Internal helpers
  // ====================

  /**
   * Resolve a folder + filename to the underlying Drive file id. Drive
   * doesn't address files by `parent/name` — every operation needs the file
   * id — so this is the workhorse used by `head`/`delete`/`getDownloadStream`.
   */
  private async findFileIdByName(
    folderId: string,
    name: string,
  ): Promise<string | null> {
    const drive = await this.requireDriveClient();
    const safe = name.replace(/'/g, "\\'");
    try {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and name='${safe}' and trashed=false`,
        fields: "files(id)",
        pageSize: 1,
        spaces: "drive",
      });
      return res.data.files?.[0]?.id ?? null;
    } catch (error) {
      const { status, message } = this.extractDriveErrorInfo(error);
      if (status === 404) return null;
      log().error(
        { folderId, name, status, error: message },
        "Drive name lookup failed",
      );
      throw new Error(`Drive lookup failed: ${message}`, { cause: error });
    }
  }

  private async recordConnectivityStatus(
    status: ConnectivityStatusType,
    responseTimeMs?: number,
    errorMessage?: string,
    errorCode?: string,
    metadata?: Record<string, unknown>,
    userId?: string,
  ): Promise<void> {
    try {
      await this.prisma.connectivityStatus.create({
        data: {
          service: "storage",
          status,
          responseTimeMs: responseTimeMs ?? null,
          errorMessage: errorMessage ?? null,
          errorCode: errorCode ?? null,
          metadata: metadata ? JSON.stringify(metadata) : null,
          checkInitiatedBy: userId ?? null,
          checkedAt: new Date(),
          lastSuccessfulAt: status === "connected" ? new Date() : null,
        },
      });
    } catch (error) {
      log().error(
        {
          status,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to record Drive connectivity status",
      );
    }
  }
}
