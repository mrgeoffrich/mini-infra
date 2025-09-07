import prisma from "../lib/prisma";
import { servicesLogger } from "../lib/logger-factory";
import type { UserPreference, UpdateUserPreferencesRequest } from "@mini-infra/types";

const logger = servicesLogger();

export class UserPreferencesService {
  /**
   * Get user preferences, creating a default record if none exists
   */
  static async getUserPreferences(userId: string): Promise<UserPreference> {
    logger.debug({ userId }, "Getting user preferences");

    // Try to find existing preferences
    let preferences = await prisma.userPreference.findUnique({
      where: { userId }
    });

    // Create default preferences if none exist
    if (!preferences) {
      logger.info({ userId }, "Creating default user preferences");
      preferences = await prisma.userPreference.create({
        data: {
          userId,
          timezone: "UTC",
          containerSortField: "name",
          containerSortOrder: "asc",
        }
      });
    }

    logger.debug({ userId, preferencesId: preferences.id }, "Retrieved user preferences");
    return preferences;
  }

  /**
   * Update user preferences
   */
  static async updateUserPreferences(
    userId: string,
    updates: UpdateUserPreferencesRequest
  ): Promise<UserPreference> {
    logger.debug({ userId, updates }, "Updating user preferences");

    // Validate timezone if provided
    if (updates.timezone) {
      const isValidTimezone = UserPreferencesService.validateTimezone(updates.timezone);
      if (!isValidTimezone) {
        logger.warn({ userId, timezone: updates.timezone }, "Invalid timezone provided");
        throw new Error(`Invalid timezone: ${updates.timezone}`);
      }
    }

    // First ensure preferences exist
    await UserPreferencesService.getUserPreferences(userId);

    // Update preferences
    const preferences = await prisma.userPreference.update({
      where: { userId },
      data: {
        ...updates,
        updatedAt: new Date(),
      }
    });

    logger.info({ userId, preferencesId: preferences.id }, "User preferences updated successfully");
    return preferences;
  }

  /**
   * Validate timezone string
   */
  static validateTimezone(timezone: string): boolean {
    try {
      // Try to create a date formatter with the timezone
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get list of common timezones
   */
  static getCommonTimezones(): Array<{ value: string; label: string }> {
    return [
      { value: "UTC", label: "UTC (Coordinated Universal Time)" },
      { value: "America/New_York", label: "Eastern Time (New York)" },
      { value: "America/Chicago", label: "Central Time (Chicago)" },
      { value: "America/Denver", label: "Mountain Time (Denver)" },
      { value: "America/Los_Angeles", label: "Pacific Time (Los Angeles)" },
      { value: "America/Anchorage", label: "Alaska Time (Anchorage)" },
      { value: "Pacific/Honolulu", label: "Hawaii Time (Honolulu)" },
      { value: "Europe/London", label: "Greenwich Mean Time (London)" },
      { value: "Europe/Paris", label: "Central European Time (Paris)" },
      { value: "Europe/Berlin", label: "Central European Time (Berlin)" },
      { value: "Europe/Rome", label: "Central European Time (Rome)" },
      { value: "Europe/Moscow", label: "Moscow Standard Time" },
      { value: "Asia/Tokyo", label: "Japan Standard Time (Tokyo)" },
      { value: "Asia/Shanghai", label: "China Standard Time (Shanghai)" },
      { value: "Asia/Kolkata", label: "India Standard Time (Kolkata)" },
      { value: "Asia/Dubai", label: "Gulf Standard Time (Dubai)" },
      { value: "Australia/Sydney", label: "Australian Eastern Time (Sydney)" },
      { value: "Australia/Melbourne", label: "Australian Eastern Time (Melbourne)" },
      { value: "Australia/Perth", label: "Australian Western Time (Perth)" },
    ];
  }
}