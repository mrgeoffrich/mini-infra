import { format, formatDistanceToNow } from "date-fns";

/**
 * Formats a date in a specific timezone using native Intl.DateTimeFormat.
 * Replaces the `date-fns-tz` package's `formatInTimeZone`.
 */
function formatInTimezone(
  date: Date,
  timezone: string,
  fmt: string,
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;

  return fmt
    .replace("MMM", p.month ?? "")
    .replace("yyyy", p.year ?? "")
    .replace("dd", (p.day ?? "").padStart(2, "0"))
    .replace("d", p.day ?? "")
    .replace("HH", (p.hour ?? "").padStart(2, "0"))
    .replace("mm", (p.minute ?? "").padStart(2, "0"))
    .replace("ss", (p.second ?? "").padStart(2, "0"));
}

export interface DateFormatOptions {
  /**
   * The timezone to format the date in. If not provided, uses browser timezone.
   */
  timezone?: string | null;
  /**
   * Whether to show seconds in time displays. Defaults to false.
   */
  showSeconds?: boolean;
}

/**
 * Formats a date as a localized string with timezone support
 * @param date - Date to format (string, Date, or number)
 * @param options - Formatting options including timezone
 * @returns Formatted date string
 */
export function formatDateTime(
  date: string | Date | number,
  options: DateFormatOptions = {},
): string {
  const { timezone, showSeconds = false } = options;
  const dateObj = typeof date === "string" ? new Date(date) : new Date(date);

  // If no timezone specified, use browser's default formatting
  if (!timezone) {
    const timeFormat = showSeconds ? "HH:mm:ss" : "HH:mm";
    return `${format(dateObj, "MMM d, yyyy")} ${format(dateObj, timeFormat)}`;
  }

  try {
    const timeFormat = showSeconds ? "HH:mm:ss" : "HH:mm";
    const dateFormat = `MMM d, yyyy ${timeFormat}`;
    return formatInTimezone(dateObj, timezone, dateFormat);
  } catch {
    // Fallback to browser timezone if timezone is invalid
    console.warn(`Invalid timezone "${timezone}", falling back to local time`);
    const timeFormat = showSeconds ? "HH:mm:ss" : "HH:mm";
    return `${format(dateObj, "MMM d, yyyy")} ${format(dateObj, timeFormat)}`;
  }
}

/**
 * Formats a date as just the date part with timezone support
 * @param date - Date to format (string, Date, or number)
 * @param options - Formatting options including timezone
 * @returns Formatted date string
 */
export function formatDate(
  date: string | Date | number,
  options: DateFormatOptions = {},
): string {
  const { timezone } = options;
  const dateObj = typeof date === "string" ? new Date(date) : new Date(date);

  if (!timezone) {
    return format(dateObj, "MMM d, yyyy");
  }

  try {
    return formatInTimezone(dateObj, timezone, "MMM d, yyyy");
  } catch {
    console.warn(`Invalid timezone "${timezone}", falling back to local time`);
    return format(dateObj, "MMM d, yyyy");
  }
}

/**
 * Formats a date as just the time part with timezone support
 * @param date - Date to format (string, Date, or number)
 * @param options - Formatting options including timezone
 * @returns Formatted time string
 */
export function formatTime(
  date: string | Date | number,
  options: DateFormatOptions = {},
): string {
  const { timezone, showSeconds = false } = options;
  const dateObj = typeof date === "string" ? new Date(date) : new Date(date);
  const timeFormat = showSeconds ? "HH:mm:ss" : "HH:mm";

  if (!timezone) {
    return format(dateObj, timeFormat);
  }

  try {
    return formatInTimezone(dateObj, timezone, timeFormat);
  } catch {
    console.warn(`Invalid timezone "${timezone}", falling back to local time`);
    return format(dateObj, timeFormat);
  }
}

/**
 * Formats a date as "started X" or similar relative format with timezone support
 * @param date - Date to format (string, Date, or number)
 * @param prefix - Text to prefix the formatted date with (e.g., "started")
 * @param options - Formatting options including timezone
 * @returns Formatted string with prefix
 */
export function formatDateWithPrefix(
  date: string | Date | number,
  prefix: string,
  options: DateFormatOptions = {},
): string {
  const formatted = formatDateTime(date, options);
  return `${prefix} ${formatted}`;
}

/**
 * Formats a date for display in the container dashboard
 * Uses a compact format suitable for dashboard cards
 * @param date - Date to format (string, Date, or number)
 * @param options - Formatting options including timezone
 * @returns Formatted date string
 */
export function formatContainerDate(
  date: string | Date | number,
  options: DateFormatOptions = {},
): string {
  const { timezone } = options;
  const dateObj = typeof date === "string" ? new Date(date) : new Date(date);

  if (!timezone) {
    return format(dateObj, "MMM d, HH:mm");
  }

  try {
    return formatInTimezone(dateObj, timezone, "MMM d, HH:mm");
  } catch {
    console.warn(`Invalid timezone "${timezone}", falling back to local time`);
    return format(dateObj, "MMM d, HH:mm");
  }
}

/**
 * Formats a date as a relative time string (e.g., "2 hours ago", "3 days ago")
 * @param date - Date to format (string, Date, or number)
 * @returns Relative time string
 */
export function formatRelativeTime(date: string | Date | number): string {
  const dateObj = typeof date === "string" ? new Date(date) : new Date(date);
  return formatDistanceToNow(dateObj, { addSuffix: true });
}
