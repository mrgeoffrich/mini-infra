/**
 * Canonical redirect URI for the Google Drive OAuth flow.
 *
 * Always derived from `getPublicUrl()` — the same source the user-login
 * Google OAuth flow uses — so worktree dev / Cloudflare-tunnel / prod all
 * resolve to the right URL without hardcoding ports. The operator must
 * register this exact URL in their Google Cloud Console (Google does not
 * accept wildcards). Worktree dev needs each worktree URL added separately.
 */

import { ErrorCode } from "@mini-infra/types";
import { getPublicUrl } from "../../../../lib/public-url-service";
import { ValidationError } from "../../../../lib/errors";

export const GOOGLE_DRIVE_OAUTH_CALLBACK_PATH =
  "/api/storage/google-drive/oauth/callback";

/**
 * Thrown when `system.public_url` isn't set yet. Folded into the taxonomy
 * (§4.2) as a 400 `ValidationError` — `.code` keeps its pre-migration value
 * (`"PUBLIC_URL_NOT_CONFIGURED"`, documented in
 * `client/src/user-docs/connectivity/health-monitoring.md`) via
 * `ErrorCode.PUBLIC_URL_NOT_CONFIGURED`.
 */
export class GoogleDrivePublicUrlNotConfiguredError extends ValidationError {
  constructor() {
    super(
      ErrorCode.PUBLIC_URL_NOT_CONFIGURED,
      "Mini Infra public URL is not configured — set system.public_url before running the Google Drive OAuth flow",
      {
        resource: { type: "systemSettings", name: "public_url" },
        action: "Set the Mini Infra public URL in Settings > System.",
      },
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

/**
 * Like {@link buildGoogleDriveRedirectUri} but falls back to a caller-supplied
 * origin (e.g. the incoming request's `protocol://host`) when no public URL is
 * configured. Used by the onboarding "Load from Backup" flow, which must run on
 * a fresh instance that hasn't set `system.public_url` yet. Both the authorize
 * redirect and the token exchange resolve through here with the same request
 * origin, so the redirect URI matches on both legs of the OAuth round-trip.
 */
export async function resolveGoogleDriveRedirectUri(
  fallbackOrigin?: string | null,
): Promise<string> {
  const publicUrl = await getPublicUrl();
  const base = (publicUrl ?? fallbackOrigin ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new GoogleDrivePublicUrlNotConfiguredError();
  }
  return `${base}${GOOGLE_DRIVE_OAUTH_CALLBACK_PATH}`;
}
