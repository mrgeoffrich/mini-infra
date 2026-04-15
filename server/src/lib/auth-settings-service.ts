import prisma from "./prisma";
import { appLogger } from "./logger-factory";
import type { AuthSettingsInfo, UpdateAuthSettingsRequest } from "@mini-infra/types";

const logger = appLogger();

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
    updateData.googleClientSecret = data.googleClientSecret || null;
  }

  await prisma.authSettings.update({
    where: { id: settings.id },
    data: updateData,
  });

  logger.info("Auth settings updated");
}

export async function isSetupComplete(): Promise<boolean> {
  const settings = await getOrCreateRow();
  return settings.setupComplete;
}

export async function markSetupComplete(): Promise<void> {
  const settings = await getOrCreateRow();
  await prisma.authSettings.update({
    where: { id: settings.id },
    data: { setupComplete: true },
  });
}

export async function isGoogleOAuthEnabled(): Promise<boolean> {
  const settings = await getOrCreateRow();
  return settings.googleOAuthEnabled;
}

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

  return {
    clientId: settings.googleClientId,
    clientSecret: settings.googleClientSecret,
  };
}

function maskString(value: string): string {
  if (value.length <= 8) return "****";
  return value.substring(0, 4) + "****" + value.substring(value.length - 4);
}
