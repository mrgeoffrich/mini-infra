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
      // UTC
      { value: "UTC", label: "UTC (Coordinated Universal Time)" },
      
      // North America
      { value: "America/New_York", label: "Eastern Time (New York)" },
      { value: "America/Detroit", label: "Eastern Time (Detroit)" },
      { value: "America/Toronto", label: "Eastern Time (Toronto)" },
      { value: "America/Chicago", label: "Central Time (Chicago)" },
      { value: "America/Winnipeg", label: "Central Time (Winnipeg)" },
      { value: "America/Mexico_City", label: "Central Time (Mexico City)" },
      { value: "America/Denver", label: "Mountain Time (Denver)" },
      { value: "America/Edmonton", label: "Mountain Time (Edmonton)" },
      { value: "America/Phoenix", label: "Mountain Time (Phoenix)" },
      { value: "America/Los_Angeles", label: "Pacific Time (Los Angeles)" },
      { value: "America/Vancouver", label: "Pacific Time (Vancouver)" },
      { value: "America/Anchorage", label: "Alaska Time (Anchorage)" },
      { value: "Pacific/Honolulu", label: "Hawaii Time (Honolulu)" },
      { value: "America/Adak", label: "Hawaii-Aleutian Time (Adak)" },
      
      // South America
      { value: "America/Sao_Paulo", label: "Brasília Time (São Paulo)" },
      { value: "America/Argentina/Buenos_Aires", label: "Argentina Time (Buenos Aires)" },
      { value: "America/Santiago", label: "Chile Time (Santiago)" },
      { value: "America/Lima", label: "Peru Time (Lima)" },
      { value: "America/Bogota", label: "Colombia Time (Bogotá)" },
      { value: "America/Caracas", label: "Venezuela Time (Caracas)" },
      
      // Europe
      { value: "Europe/London", label: "Greenwich Mean Time (London)" },
      { value: "Europe/Dublin", label: "Greenwich Mean Time (Dublin)" },
      { value: "Europe/Lisbon", label: "Western European Time (Lisbon)" },
      { value: "Europe/Paris", label: "Central European Time (Paris)" },
      { value: "Europe/Berlin", label: "Central European Time (Berlin)" },
      { value: "Europe/Rome", label: "Central European Time (Rome)" },
      { value: "Europe/Madrid", label: "Central European Time (Madrid)" },
      { value: "Europe/Amsterdam", label: "Central European Time (Amsterdam)" },
      { value: "Europe/Brussels", label: "Central European Time (Brussels)" },
      { value: "Europe/Vienna", label: "Central European Time (Vienna)" },
      { value: "Europe/Zurich", label: "Central European Time (Zurich)" },
      { value: "Europe/Prague", label: "Central European Time (Prague)" },
      { value: "Europe/Warsaw", label: "Central European Time (Warsaw)" },
      { value: "Europe/Stockholm", label: "Central European Time (Stockholm)" },
      { value: "Europe/Oslo", label: "Central European Time (Oslo)" },
      { value: "Europe/Copenhagen", label: "Central European Time (Copenhagen)" },
      { value: "Europe/Helsinki", label: "Eastern European Time (Helsinki)" },
      { value: "Europe/Athens", label: "Eastern European Time (Athens)" },
      { value: "Europe/Istanbul", label: "Turkey Time (Istanbul)" },
      { value: "Europe/Moscow", label: "Moscow Standard Time" },
      { value: "Europe/Kiev", label: "Eastern European Time (Kyiv)" },
      { value: "Europe/Bucharest", label: "Eastern European Time (Bucharest)" },
      
      // Africa
      { value: "Africa/Cairo", label: "Eastern European Time (Cairo)" },
      { value: "Africa/Lagos", label: "West Africa Time (Lagos)" },
      { value: "Africa/Johannesburg", label: "South Africa Standard Time (Johannesburg)" },
      { value: "Africa/Casablanca", label: "Western European Time (Casablanca)" },
      { value: "Africa/Nairobi", label: "East Africa Time (Nairobi)" },
      { value: "Africa/Addis_Ababa", label: "East Africa Time (Addis Ababa)" },
      
      // Asia
      { value: "Asia/Tokyo", label: "Japan Standard Time (Tokyo)" },
      { value: "Asia/Seoul", label: "Korea Standard Time (Seoul)" },
      { value: "Asia/Shanghai", label: "China Standard Time (Shanghai)" },
      { value: "Asia/Beijing", label: "China Standard Time (Beijing)" },
      { value: "Asia/Hong_Kong", label: "Hong Kong Time" },
      { value: "Asia/Singapore", label: "Singapore Standard Time" },
      { value: "Asia/Manila", label: "Philippines Time (Manila)" },
      { value: "Asia/Bangkok", label: "Indochina Time (Bangkok)" },
      { value: "Asia/Ho_Chi_Minh", label: "Indochina Time (Ho Chi Minh City)" },
      { value: "Asia/Jakarta", label: "Western Indonesia Time (Jakarta)" },
      { value: "Asia/Kuala_Lumpur", label: "Malaysia Time (Kuala Lumpur)" },
      { value: "Asia/Kolkata", label: "India Standard Time (Kolkata)" },
      { value: "Asia/Mumbai", label: "India Standard Time (Mumbai)" },
      { value: "Asia/Dhaka", label: "Bangladesh Standard Time (Dhaka)" },
      { value: "Asia/Karachi", label: "Pakistan Standard Time (Karachi)" },
      { value: "Asia/Dubai", label: "Gulf Standard Time (Dubai)" },
      { value: "Asia/Riyadh", label: "Arabia Standard Time (Riyadh)" },
      { value: "Asia/Tehran", label: "Iran Standard Time (Tehran)" },
      { value: "Asia/Jerusalem", label: "Israel Standard Time (Jerusalem)" },
      { value: "Asia/Beirut", label: "Eastern European Time (Beirut)" },
      { value: "Asia/Baghdad", label: "Arabia Standard Time (Baghdad)" },
      { value: "Asia/Kuwait", label: "Arabia Standard Time (Kuwait)" },
      { value: "Asia/Qatar", label: "Arabia Standard Time (Qatar)" },
      
      // Central Asia
      { value: "Asia/Tashkent", label: "Uzbekistan Time (Tashkent)" },
      { value: "Asia/Almaty", label: "Alma-Ata Time (Almaty)" },
      { value: "Asia/Yekaterinburg", label: "Yekaterinburg Time" },
      { value: "Asia/Novosibirsk", label: "Novosibirsk Time" },
      { value: "Asia/Krasnoyarsk", label: "Krasnoyarsk Time" },
      { value: "Asia/Irkutsk", label: "Irkutsk Time" },
      { value: "Asia/Vladivostok", label: "Vladivostok Time" },
      
      // Oceania
      { value: "Australia/Sydney", label: "Australian Eastern Time (Sydney)" },
      { value: "Australia/Melbourne", label: "Australian Eastern Time (Melbourne)" },
      { value: "Australia/Brisbane", label: "Australian Eastern Time (Brisbane)" },
      { value: "Australia/Adelaide", label: "Australian Central Time (Adelaide)" },
      { value: "Australia/Darwin", label: "Australian Central Time (Darwin)" },
      { value: "Australia/Perth", label: "Australian Western Time (Perth)" },
      { value: "Pacific/Auckland", label: "New Zealand Standard Time (Auckland)" },
      { value: "Pacific/Fiji", label: "Fiji Time" },
      { value: "Pacific/Guam", label: "Chamorro Standard Time (Guam)" },
      { value: "Pacific/Tahiti", label: "Tahiti Time" },
      
      // Atlantic
      { value: "Atlantic/Azores", label: "Azores Time" },
      { value: "Atlantic/Canary", label: "Western European Time (Canary Islands)" },
      { value: "Atlantic/Cape_Verde", label: "Cape Verde Time" },
      { value: "Atlantic/Reykjavik", label: "Greenwich Mean Time (Reykjavik)" },
      
      // Indian Ocean
      { value: "Indian/Maldives", label: "Maldives Time" },
      { value: "Indian/Mauritius", label: "Mauritius Time" },
      
      // Antarctica (for research stations)
      { value: "Antarctica/McMurdo", label: "New Zealand Time (McMurdo)" },
    ];
  }
}