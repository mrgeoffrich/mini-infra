import { z } from "zod";
import { POSTGRES_SSL_MODES, BACKUP_FORMATS } from "@mini-infra/types";

export const postgresDbSchema = z.object({
  name: z
    .string()
    .min(1, "Configuration name is required")
    .max(255, "Configuration name must be less than 255 characters"),
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
  sslMode: z.enum(POSTGRES_SSL_MODES),
  tags: z.array(z.string()),
});

export const postgresConnectionSchema = z.object({
  host: z
    .string()
    .min(1, "Host is required")
    .max(255, "Host must be less than 255 characters"),
  port: z
    .number()
    .int()
    .min(1, "Port must be greater than 0")
    .max(65535, "Port must be less than 65536"),
  username: z
    .string()
    .min(1, "Username is required")
    .max(255, "Username must be less than 255 characters"),
  password: z
    .string()
    .min(1, "Password is required")
    .max(255, "Password must be less than 255 characters"),
  sslMode: z.enum(POSTGRES_SSL_MODES),
});

export type PostgresDbFormData = z.infer<typeof postgresDbSchema>;
export type PostgresConnectionFormData = z.infer<typeof postgresConnectionSchema>;

export const backupConfigSchema = z.object({
  schedule: z.string().optional(),
  timezone: z.string().optional(),
  storageLocationId: z
    .string()
    .min(1, "Storage location id is required")
    .max(255, "Storage location id must be less than 255 characters"),
  storagePathPrefix: z.string().optional(),
  retentionDays: z
    .number()
    .int()
    .min(1, "Retention must be at least 1 day")
    .max(365, "Retention cannot exceed 365 days"),
  backupFormat: z.enum(BACKUP_FORMATS),
  compressionLevel: z
    .number()
    .int()
    .min(0, "Compression level must be between 0-9")
    .max(9, "Compression level must be between 0-9"),
  isEnabled: z.boolean(),
});

export type BackupConfigFormData = z.infer<typeof backupConfigSchema>;
