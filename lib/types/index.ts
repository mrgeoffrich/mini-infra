// ====================
// Shared Types Export
// ====================

// Authentication types
export * from "./auth";

// Container types
export * from "./containers";

// Settings types
export * from "./settings";

// Azure types
export * from "./azure";

// API response types
export * from "./api";

// Job management types
export * from "./job";

// SSE event types
export * from "./sse";

// ====================
// Type Utilities
// ====================

// Utility type to convert Date fields to string (for JSON serialization)
export type Serialize<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | null
      ? string | null
      : T[K] extends Date | undefined
        ? string | undefined
        : T[K] extends object
          ? Serialize<T[K]>
          : T[K];
};

// Utility type to convert string fields to Date (for deserialization)
export type Deserialize<T> = {
  [K in keyof T]: T[K] extends string
    ? T[K] extends `${number}-${number}-${number}T${string}`
      ? Date
      : T[K]
    : T[K] extends string | null
      ? T[K] extends `${number}-${number}-${number}T${string}` | null
        ? Date | null
        : T[K]
      : T[K] extends object
        ? Deserialize<T[K]>
        : T[K];
};

// Utility type for making certain fields optional
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

// Utility type for making certain fields required
export type RequiredBy<T, K extends keyof T> = Omit<T, K> &
  Required<Pick<T, K>>;
