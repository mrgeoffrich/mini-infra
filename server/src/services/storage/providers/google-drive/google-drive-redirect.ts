/**
 * Canonical redirect URI for the Google Drive OAuth flow.
 *
 * Always derived from `getPublicUrl()` — the same source the user-login
 * Google OAuth flow uses — so worktree dev / Cloudflare-tunnel / prod all
 * resolve to the right URL without hardcoding ports. The operator must
 * register this exact URL in their Google Cloud Console (Google does not
 * accept wildcards). Worktree dev needs each worktree URL added separately.
 */

import { getPublicUrl } from "../../../../lib/public-url-service";

export const GOOGLE_DRIVE_OAUTH_CALLBACK_PATH =
  "/api/storage/google-drive/oauth/callback";

export class GoogleDrivePublicUrlNotConfiguredError extends Error {
  readonly code = "PUBLIC_URL_NOT_CONFIGURED";
  constructor() {
    super(
      "Mini Infra public URL is not configured — set system.public_url before running the Google Drive OAuth flow",
    );
    this.name = "GoogleDrivePublicUrlNotConfiguredError";
  }
}

/**
 * Build the canonical redirect URI used both at authorize time and during
 * `refresh_token` calls. Throws when no public URL is configured — the OAuth
 * flow can't work without one and we'd rather fail loudly than mint an
 * unusable redirect URI.
 */
export async function buildGoogleDriveRedirectUri(): Promise<string> {
  const publicUrl = await getPublicUrl();
  if (!publicUrl) {
    throw new GoogleDrivePublicUrlNotConfiguredError();
  }
  // Strip a trailing slash so the join is deterministic.
  const base = publicUrl.replace(/\/+$/, "");
  return `${base}${GOOGLE_DRIVE_OAUTH_CALLBACK_PATH}`;
}
