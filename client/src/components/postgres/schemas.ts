import { z } from "zod";

export const postgresDbSchema = z.object({
  name: z
    .string()
    .min(1, "Database name is required")
    .max(255, "Database name must be less than 255 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Database name can only contain letters, numbers, underscores, and hyphens",
    ),
  host: z
    .string()
    .min(1, "Host is required")
    .max(255, "Host must be less than 255 characters"),
  port: z
    .number()
    .int()
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536"),
  database: z
    .string()
    .min(1, "Database name is required")
    .max(255, "Database name must be less than 255 characters"),
  username: z
    .string()
    .min(1, "Username is required")
    .max(255, "Username must be less than 255 characters"),
  password: z
    .string()
    .min(1, "Password is required")
    .max(255, "Password must be less than 255 characters"),
  sslMode: z.enum(["require", "disable", "prefer"]),
  tags: z.array(z.string()),
});

export type PostgresDbFormData = z.infer<typeof postgresDbSchema>;

export const backupConfigSchema = z.object({
  schedule: z.string().optional(),
  timezone: z.string().optional(),
  azureContainerName: z
    .string()
    .min(1, "Azure container name is required")
    .max(255, "Container name must be less than 255 characters"),
  azurePathPrefix: z.string().optional(),
  retentionDays: z
    .number()
    .int()
    .min(1, "Retention must be at least 1 day")
    .max(365, "Retention cannot exceed 365 days"),
  backupFormat: z.enum(["custom", "plain", "tar"]),
  compressionLevel: z
    .number()
    .int()
    .min(0, "Compression level must be between 0-9")
    .max(9, "Compression level must be between 0-9"),
  isEnabled: z.boolean(),
});

export type BackupConfigFormData = z.infer<typeof backupConfigSchema>;
