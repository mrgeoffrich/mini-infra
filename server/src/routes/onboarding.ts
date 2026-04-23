import { Router, Request, Response } from "express";
import prisma from "../lib/prisma";
import { getLogger } from "../lib/logger-factory";
import { requirePermission } from "../middleware/auth";
import { getAuthenticatedUser } from "../lib/auth-middleware";
import { UserPreferencesService } from "../services/user-preferences";
import { TlsConfigService } from "../services/tls/tls-config";

const logger = getLogger("http", "onboarding");
const router = Router();

const SELF_BACKUP_DEFAULT_CRON = "0 2 * * *";
const ACME_DEFAULT_PROVIDER = "letsencrypt";
const ACME_DEFAULT_RENEWAL_DAYS = "30";
const TLS_DEFAULT_RENEWAL_CHECK_CRON = "0 2 * * *";

async function upsertSelfBackupDefault(
  key: string,
  value: string,
  userId: string,
): Promise<boolean> {
  const existing = await prisma.systemSettings.findUnique({
    where: { category_key: { category: "self-backup", key } },
  });
  if (existing && existing.value) {
    return false;
  }
  await prisma.systemSettings.upsert({
    where: { category_key: { category: "self-backup", key } },
    create: {
      category: "self-backup",
      key,
      value,
      isEncrypted: false,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    },
    update: {
      value,
      updatedBy: userId,
      updatedAt: new Date(),
    },
  });
  return true;
}

/**
 * POST /complete — finalise onboarding, marking it complete and seeding
 * sensible defaults for backups and TLS/ACME based on the user's profile.
 * Existing values are preserved so this is safe to call on re-entry.
 */
router.post(
  "/complete",
  requirePermission("settings:write"),
  async (req: Request, res: Response) => {
    // Use the unified helper so API-key auth (where req.user isn't
    // populated by the JWT middleware) works the same as a session.
    const user = getAuthenticatedUser(req);
    if (!user?.id) {
      return res
        .status(401)
        .json({ success: false, error: "User not authenticated" });
    }
    const userId = user.id;
    const userEmail = user.email;

    try {
      const preferences =
        await UserPreferencesService.getUserPreferences(userId);
      const userTimezone = preferences.timezone || "UTC";

      await prisma.systemSettings.upsert({
        where: {
          category_key: { category: "system", key: "onboarding_complete" },
        },
        create: {
          category: "system",
          key: "onboarding_complete",
          value: "true",
          isEncrypted: false,
          isActive: true,
          createdBy: userId,
          updatedBy: userId,
        },
        update: {
          value: "true",
          isActive: true,
          updatedBy: userId,
          updatedAt: new Date(),
        },
      });

      const backupCronSeeded = await upsertSelfBackupDefault(
        "cron_schedule",
        SELF_BACKUP_DEFAULT_CRON,
        userId,
      );
      const backupTimezoneSeeded = await upsertSelfBackupDefault(
        "timezone",
        userTimezone,
        userId,
      );

      const tlsConfig = new TlsConfigService(prisma);
      const existingAcmeEmail = await tlsConfig.get("default_acme_email");
      const existingAcmeProvider = await tlsConfig.get("default_acme_provider");
      const existingRenewalDays = await tlsConfig.get(
        "renewal_days_before_expiry",
      );
      const existingRenewalCheckCron = await tlsConfig.get(
        "renewal_check_cron",
      );

      let acmeEmailSeeded = false;
      let acmeProviderSeeded = false;
      let renewalDaysSeeded = false;
      let renewalCheckCronSeeded = false;

      if (!existingAcmeEmail && userEmail) {
        await tlsConfig.set("default_acme_email", userEmail, userId);
        acmeEmailSeeded = true;
      }
      if (!existingAcmeProvider) {
        await tlsConfig.set(
          "default_acme_provider",
          ACME_DEFAULT_PROVIDER,
          userId,
        );
        acmeProviderSeeded = true;
      }
      if (!existingRenewalDays) {
        await tlsConfig.set(
          "renewal_days_before_expiry",
          ACME_DEFAULT_RENEWAL_DAYS,
          userId,
        );
        renewalDaysSeeded = true;
      }
      if (!existingRenewalCheckCron) {
        await tlsConfig.set(
          "renewal_check_cron",
          TLS_DEFAULT_RENEWAL_CHECK_CRON,
          userId,
        );
        renewalCheckCronSeeded = true;
      }

      logger.info(
        {
          userId,
          seeded: {
            backupCron: backupCronSeeded,
            backupTimezone: backupTimezoneSeeded,
            acmeEmail: acmeEmailSeeded,
            acmeProvider: acmeProviderSeeded,
            renewalDays: renewalDaysSeeded,
            renewalCheckCron: renewalCheckCronSeeded,
          },
          userTimezone,
        },
        "Onboarding completed and defaults seeded",
      );

      res.json({ success: true });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        { userId, error: errorMessage },
        "Failed to complete onboarding",
      );
      res.status(500).json({
        success: false,
        error: "Failed to complete onboarding",
      });
    }
  },
);

export default router;
