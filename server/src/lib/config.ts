import { z } from "zod";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

const configSchema = z.object({
  // Server configuration
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z
    .string()
    .optional()
    .default("5000")
    .transform((val) => Number(val)),

  // Database
  DATABASE_URL: z.string().default("file:./dev.db"),

  // Authentication
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().optional(),

  // Logging
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),

  // Security
  PUBLIC_URL: z.string().optional(),
  RATE_LIMIT_WINDOW_MS: z
    .string()
    .optional()
    .default("900000")
    .transform((val) => Number(val)), // 15 minutes
  RATE_LIMIT_MAX_REQUESTS: z
    .string()
    .optional()
    .default("100")
    .transform((val) => Number(val)), // 100 requests per window
});

export type Config = z.infer<typeof configSchema>;

let config: Config;

try {
  config = configSchema.parse(process.env);
} catch (error) {
  console.error("❌ Invalid environment configuration:", error);
  process.exit(1);
}

export default config;
