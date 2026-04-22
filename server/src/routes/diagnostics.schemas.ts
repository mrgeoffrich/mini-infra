import { z } from "zod";
import "../lib/openapi-registry";

const NullableBytes = z.number().nullable();

const ProcStatusSchema = z
  .object({
    vmPeak: NullableBytes.openapi({ description: "Peak virtual memory (bytes)" }),
    vmSize: NullableBytes.openapi({ description: "Current virtual memory (bytes)" }),
    vmHWM: NullableBytes.openapi({ description: "Peak resident set size (bytes)" }),
    vmRSS: NullableBytes.openapi({ description: "Current resident set size (bytes)" }),
    rssAnon: NullableBytes,
    rssFile: NullableBytes,
    rssShmem: NullableBytes,
    vmData: NullableBytes,
    vmStk: NullableBytes,
    vmExe: NullableBytes,
    vmLib: NullableBytes,
    vmPTE: NullableBytes,
    vmSwap: NullableBytes,
    threads: z.number().nullable(),
  })
  .nullable()
  .openapi("ProcStatus", {
    description: "Parsed /proc/self/status. Null on non-Linux hosts.",
  });

const SmapsRollupSchema = z
  .object({
    rss: NullableBytes,
    pss: NullableBytes,
    pssAnon: NullableBytes,
    pssFile: NullableBytes,
    pssShmem: NullableBytes,
    sharedClean: NullableBytes,
    sharedDirty: NullableBytes,
    privateClean: NullableBytes,
    privateDirty: NullableBytes,
    referenced: NullableBytes,
    anonymous: NullableBytes,
    swap: NullableBytes,
    swapPss: NullableBytes,
    locked: NullableBytes,
  })
  .nullable()
  .openapi("SmapsRollup", {
    description: "Parsed /proc/self/smaps_rollup. Null on non-Linux hosts.",
  });

export const MemoryDiagnosticsResponse = z
  .object({
    timestamp: z.string().datetime(),
    uptimeSeconds: z.number().openapi({ description: "Process uptime in seconds" }),
    pid: z.number(),
    nodeVersion: z.string(),
    platform: z.string(),
    process: z.object({
      rss: z.number().openapi({ description: "Resident Set Size in bytes" }),
      heapTotal: z.number(),
      heapUsed: z.number(),
      external: z.number(),
      arrayBuffers: z.number(),
    }),
    heap: z.object({
      totalHeapSize: z.number(),
      totalHeapSizeExecutable: z.number(),
      totalPhysicalSize: z.number(),
      totalAvailableSize: z.number(),
      usedHeapSize: z.number(),
      heapSizeLimit: z.number(),
      mallocedMemory: z.number(),
      peakMallocedMemory: z.number(),
      numberOfNativeContexts: z.number(),
      numberOfDetachedContexts: z.number(),
    }),
    heapSpaces: z.array(
      z.object({
        name: z.string(),
        size: z.number(),
        used: z.number(),
        available: z.number(),
        physical: z.number(),
      }),
    ),
    resourceUsage: z.record(z.string(), z.number()),
    procStatus: ProcStatusSchema,
    smapsRollup: SmapsRollupSchema,
  })
  .openapi("MemoryDiagnostics");

const SmapsRegionGroupSchema = z.object({
  pathname: z.string(),
  regions: z.number(),
  rss: z.number(),
  pss: z.number(),
  size: z.number(),
  privateDirty: z.number(),
  sharedClean: z.number(),
});

export const SmapsTopQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .openapi({ description: "Max groups to return (default 25, max 200)" }),
});

export const SmapsTopResponse = z
  .object({
    limit: z.number(),
    groups: z.array(SmapsRegionGroupSchema),
  })
  .openapi("SmapsTopResponse");

const SmapsRegionSchema = z.object({
  start: z.string().openapi({ description: "Hex start address (no 0x prefix)" }),
  end: z.string(),
  perms: z.string(),
  pathname: z.string(),
  size: z.number(),
  rss: z.number(),
  pss: z.number(),
  privateDirty: z.number(),
  sharedClean: z.number(),
});

export const SmapsRegionsQuery = z.object({
  pathname: z
    .string()
    .optional()
    .openapi({ description: "Filter to regions with this pathname (e.g. '[anon]')" }),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const SmapsRegionsResponse = z
  .object({
    pathname: z.string().nullable(),
    limit: z.number(),
    regions: z.array(SmapsRegionSchema),
  })
  .openapi("SmapsRegionsResponse");

export const RegionPeekRequest = z
  .object({
    start: z
      .string()
      .regex(/^[0-9a-f]+$/i)
      .openapi({ description: "Hex start address, no 0x prefix" }),
    length: z.number().int().positive().openapi({ description: "Bytes to read (capped at 4 MiB)" }),
    minLen: z.number().int().min(1).max(64).optional(),
    maxStrings: z.number().int().min(1).max(500).optional(),
  })
  .openapi("RegionPeekRequest");

export const RegionPeekResponse = z
  .object({
    address: z.string(),
    bytesRead: z.number(),
    truncated: z.boolean(),
    strings: z.array(
      z.object({
        offset: z.number(),
        text: z.string(),
      }),
    ),
    hexPreview: z.string(),
    error: z.string().optional(),
  })
  .openapi("RegionPeekResponse");
