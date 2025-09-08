import { useMemo } from "react";
import { useUserPreferences } from "./use-user-preferences";
import {
  formatDateTime,
  formatDate,
  formatTime,
  formatDateWithPrefix,
  formatContainerDate,
  type DateFormatOptions,
} from "../lib/date-utils";

/**
 * Hook that provides date formatting functions that automatically use the user's timezone preference
 */
export function useFormattedDate() {
  const { data: preferences } = useUserPreferences();

  const timezone = preferences?.timezone;

  const formatters = useMemo(() => {
    const baseOptions: DateFormatOptions = { timezone };

    return {
      /**
       * Formats a date as a full date and time string with user's timezone
       * @param date - Date to format
       * @param options - Additional formatting options
       */
      formatDateTime: (
        date: string | Date | number,
        options: DateFormatOptions = {},
      ) => formatDateTime(date, { ...baseOptions, ...options }),

      /**
       * Formats a date as just the date part with user's timezone
       * @param date - Date to format
       * @param options - Additional formatting options
       */
      formatDate: (
        date: string | Date | number,
        options: DateFormatOptions = {},
      ) => formatDate(date, { ...baseOptions, ...options }),

      /**
       * Formats a date as just the time part with user's timezone
       * @param date - Date to format
       * @param options - Additional formatting options
       */
      formatTime: (
        date: string | Date | number,
        options: DateFormatOptions = {},
      ) => formatTime(date, { ...baseOptions, ...options }),

      /**
       * Formats a date with a prefix (e.g., "started") using user's timezone
       * @param date - Date to format
       * @param prefix - Text to prefix the formatted date with
       * @param options - Additional formatting options
       */
      formatDateWithPrefix: (
        date: string | Date | number,
        prefix: string,
        options: DateFormatOptions = {},
      ) => formatDateWithPrefix(date, prefix, { ...baseOptions, ...options }),

      /**
       * Formats a date for container dashboard display with user's timezone
       * @param date - Date to format
       * @param options - Additional formatting options
       */
      formatContainerDate: (
        date: string | Date | number,
        options: DateFormatOptions = {},
      ) => formatContainerDate(date, { ...baseOptions, ...options }),

      /**
       * The user's current timezone setting
       */
      timezone,

      /**
       * Whether user preferences are still loading
       */
      isLoading: !preferences && timezone === undefined,
    };
  }, [timezone, preferences]);

  return formatters;
}

/**
 * Hook for formatting a specific date with user's timezone preferences
 * Returns memoized formatted strings to avoid unnecessary re-renders
 * @param date - Date to format
 * @param options - Formatting options
 */
export function useFormattedDateTime(
  date: string | Date | number | null | undefined,
  options: DateFormatOptions = {},
) {
  const { formatDateTime, timezone } = useFormattedDate();

  return useMemo(() => {
    if (!date) return null;
    return formatDateTime(date, options);
  }, [date, formatDateTime, options.showSeconds, timezone]);
}

/**
 * Hook for formatting a container date with user's timezone preferences
 * Optimized for container dashboard displays
 * @param date - Date to format
 */
export function useFormattedContainerDate(
  date: string | Date | number | null | undefined,
) {
  const { formatContainerDate, timezone } = useFormattedDate();

  return useMemo(() => {
    if (!date) return null;
    return formatContainerDate(date);
  }, [date, formatContainerDate, timezone]);
}
