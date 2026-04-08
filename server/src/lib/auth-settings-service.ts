import CryptoJS from "crypto-js";
import prisma from "./prisma";
import { getApiKeySecret } from "./security-config";
import { appLogger } from "./logger-factory";
import type { AuthSettingsInfo, UpdateAuthSettingsRequest } from "@mini-infra/types";

const logger = appLogger();

function encrypt(value: string): string {
  return CryptoJS.AES.encrypt(value, getApiKeySecret()).toString();
}

function decrypt(encrypted: string): string {
  const bytes = CryptoJS.AES.decrypt(encrypted, getApiKeySecret());
  return bytes.toString(CryptoJS.enc.Utf8);
}

/**
 * Get or create the singleton AuthSettings row
 */
async function getOrCreateRow() {
  let settings = await prisma.authSettings.findFirst();
  if (!settings) {
    settings = await prisma.authSettings.create({
      data: { setupComplete: false },
    });
  }
  return settings;
}

/**
 * Get auth settings for API responses (secrets masked)
 */
export async function getSettings(): Promise<AuthSettingsInfo> {
  const settings = await getOrCreateRow();
  return {
    googleOAuthEnabled: settings.googleOAuthEnabled,
    googleClientId: settings.googleClientId
      ? maskString(settings.googleClientId)
      : null,
    hasGoogleClientSecret: !!settings.googleClientSecret,
  };
}

/**
 * Get full auth settings for internal server use
 */
export async function getSettingsInternal() {
  return getOrCreateRow();
}

/**
 * Update auth settings. Encrypts Google client secret before storing.
 */
export async function updateSettings(
  data: UpdateAuthSettingsRequest,
): Promise<void> {
  const settings = await getOrCreateRow();

  const updateData: Record<string, unknown> = {};

  if (data.googleOAuthEnabled !== undefined) {
    updateData.googleOAuthEnabled = data.googleOAuthEnabled;
  }
  if (data.googleClientId !== undefined) {
    updateData.googleClientId = data.googleClientId;
  }
  if (data.googleClientSecret !== undefined) {
    updateData.googleClientSecret = data.googleClientSecret
      ? encrypt(data.googleClientSecret)
      : null;
  }

  await prisma.authSettings.update({
    where: { id: settings.id },
    data: updateData,
  });

  logger.info("Auth settings updated");
}

/**
 * Check if initial setup has been completed
 */
export async function isSetupComplete(): Promise<boolean> {
  const settings = await getOrCreateRow();
  return settings.setupComplete;
}

/**
 * Mark initial setup as complete
 */
export async function markSetupComplete(): Promise<void> {
  const settings = await getOrCreateRow();
  await prisma.authSettings.update({
    where: { id: settings.id },
    data: { setupComplete: true },
  });
}

/**
 * Check if Google OAuth is enabled
 */
export async function isGoogleOAuthEnabled(): Promise<boolean> {
  const settings = await getOrCreateRow();
  return settings.googleOAuthEnabled;
}

/**
 * Get decrypted Google OAuth credentials (for Passport strategy)
 */
export async function getGoogleCredentials(): Promise<{
  clientId: string;
  clientSecret: string;
} | null> {
  const settings = await getOrCreateRow();
  if (
    !settings.googleOAuthEnabled ||
    !settings.googleClientId ||
    !settings.googleClientSecret
  ) {
    return null;
  }

  try {
    return {
      clientId: settings.googleClientId,
      clientSecret: decrypt(settings.googleClientSecret),
    };
  } catch (error) {
    logger.error({ error }, "Failed to decrypt Google OAuth credentials");
    return null;
  }
}

function maskString(value: string): string {
  if (value.length <= 8) return "****";
  return value.substring(0, 4) + "****" + value.substring(value.length - 4);
}
