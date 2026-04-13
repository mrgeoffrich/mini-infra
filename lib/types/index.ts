// ====================
// Shared Types Export
// ====================

// Authentication types
export * from "./auth";

// Permission types
export * from "./permissions";

// Container types
export * from "./containers";

// Docker resource types (networks, volumes)
export * from "./docker";

// Settings types
export * from "./settings";

// Azure types
export * from "./azure";

// Cloudflare types
export * from "./cloudflare";

// GitHub types
export * from "./github";

// GitHub App types
export * from "./github-app";

// PostgreSQL types
export * from "./postgres";

// Deployment types
export * from "./deployments";

// DNS types
export * from "./dns";

// Service types
export * from "./services";

// Environment types
export * from "./environments";

// Self-backup types
export * from "./self-backup";

// Monitoring types
export * from "./monitoring";

// Registry types
export * from "./registry";

// TLS types
export * from "./tls";

// User Events types
export * from "./user-events";

// API response types
export * from "./api";

// Agent conversation types
export * from "./agent";

// Stacks types
export * from "./stacks";

// Stack Template types
export * from "./stack-templates";

// Socket.IO event types
export * from "./socket-events";

// Self-update types
export * from "./self-update";

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
