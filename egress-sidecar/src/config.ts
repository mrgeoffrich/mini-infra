/**
 * Environment-variable configuration with defaults.
 */

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseStringListEnv(name: string, defaultValue: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseLogLevel(
  raw: string | undefined,
): "debug" | "info" | "warn" | "error" {
  const valid = ["debug", "info", "warn", "error"] as const;
  if (raw && (valid as readonly string[]).includes(raw)) {
    return raw as "debug" | "info" | "warn" | "error";
  }
  return "info";
}

export interface Config {
  dnsPort: number;
  adminPort: number;
  upstreamDns: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  dedupWindowMs: number;
  queryTimeoutMs: number;
}

export const config: Config = {
  dnsPort: parseIntEnv("DNS_PORT", 53),
  adminPort: parseIntEnv("ADMIN_PORT", 8054),
  upstreamDns: parseStringListEnv("UPSTREAM_DNS", ["1.1.1.1", "8.8.8.8"]),
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  dedupWindowMs: parseIntEnv("DEDUP_WINDOW_MS", 1000),
  queryTimeoutMs: parseIntEnv("QUERY_TIMEOUT_MS", 2000),
};
