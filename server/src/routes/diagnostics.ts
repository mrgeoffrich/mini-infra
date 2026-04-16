import { Router, RequestHandler } from "express";
import { createReadStream } from "fs";
import { stat, unlink } from "fs/promises";
import v8 from "v8";
import os from "os";
import path from "path";
import { createRouteDescriber } from "../lib/describe-route";
import { getLogger } from "../lib/logger-factory";
import {
  readProcStatus,
  readSmapsRollup,
  readSmapsByPathname,
  readSmapsRegions,
  peekMemoryRegion,
} from "../lib/proc-memory";
import {
  MemoryDiagnosticsResponse,
  SmapsTopQuery,
  SmapsTopResponse,
  SmapsRegionsQuery,
  SmapsRegionsResponse,
  RegionPeekRequest,
  RegionPeekResponse,
} from "./diagnostics.schemas";

const router = Router();
const logger = getLogger("platform", "diagnostics");
const describe = createRouteDescriber(router, "/api/diagnostics");

describe(
  "get",
  "/memory",
  {
    summary: "Current server process memory and V8 heap statistics",
    description:
      "Snapshot of process.memoryUsage(), v8.getHeapStatistics(), heap spaces, and /proc/self/{status,smaps_rollup}. Safe to poll.",
    tags: ["Diagnostics"],
    permission: "settings:read",
    sideEffects: "none — safe to poll",
    response: MemoryDiagnosticsResponse,
  },
  (async (_req, res) => {
    const mem = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    const heapSpaces = v8.getHeapSpaceStatistics();
    const [procStatus, smapsRollup] = await Promise.all([
      readProcStatus(),
      readSmapsRollup(),
    ]);

    res.json({
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      process: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
      },
      heap: {
        totalHeapSize: heap.total_heap_size,
        totalHeapSizeExecutable: heap.total_heap_size_executable,
        totalPhysicalSize: heap.total_physical_size,
        totalAvailableSize: heap.total_available_size,
        usedHeapSize: heap.used_heap_size,
        heapSizeLimit: heap.heap_size_limit,
        mallocedMemory: heap.malloced_memory,
        peakMallocedMemory: heap.peak_malloced_memory,
        numberOfNativeContexts: heap.number_of_native_contexts,
        numberOfDetachedContexts: heap.number_of_detached_contexts,
      },
      heapSpaces: heapSpaces.map((s) => ({
        name: s.space_name,
        size: s.space_size,
        used: s.space_used_size,
        available: s.space_available_size,
        physical: s.physical_space_size,
      })),
      resourceUsage: process.resourceUsage(),
      procStatus,
      smapsRollup,
    });
  }) as RequestHandler,
);

describe(
  "get",
  "/smaps-top",
  {
    summary: "Top RSS contributors aggregated from /proc/self/smaps by pathname",
    description:
      "More expensive than /memory — walks the full smaps file. Fetch on demand, not on every poll.",
    tags: ["Diagnostics"],
    permission: "settings:read",
    sideEffects:
      "reads /proc/self/smaps (Linux only); moderate CPU for large process maps",
    request: { query: SmapsTopQuery },
    response: SmapsTopResponse,
    errorResponses: [
      { status: 501, description: "smaps not available on this platform" },
    ],
  },
  (async (req, res) => {
    const limitParam = Number(req.query.limit);
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, 200)
        : 25;

    const groups = await readSmapsByPathname(limit);
    if (groups === null) {
      res.status(501).json({ error: "smaps not available on this platform" });
      return;
    }
    res.json({ limit, groups });
  }) as RequestHandler,
);

describe(
  "get",
  "/smaps-regions",
  {
    summary: "Top individual smaps regions, optionally filtered by pathname",
    description:
      "Used by the UI to pick a specific anonymous region to inspect with /region-peek.",
    tags: ["Diagnostics"],
    permission: "settings:read",
    sideEffects: "reads /proc/self/smaps (Linux only)",
    request: { query: SmapsRegionsQuery },
    response: SmapsRegionsResponse,
    errorResponses: [
      { status: 501, description: "smaps not available on this platform" },
    ],
  },
  (async (req, res) => {
    const pathname =
      typeof req.query.pathname === "string" ? req.query.pathname : undefined;
    const limitParam = Number(req.query.limit);
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, 500)
        : 25;

    const regions = await readSmapsRegions();
    if (regions === null) {
      res.status(501).json({ error: "smaps not available on this platform" });
      return;
    }
    const filtered = pathname
      ? regions.filter((r) => r.pathname === pathname)
      : regions;
    const top = filtered.sort((a, b) => b.rss - a.rss).slice(0, limit);
    res.json({ pathname: pathname ?? null, limit, regions: top });
  }) as RequestHandler,
);

describe(
  "post",
  "/region-peek",
  {
    summary: "Read a slice of /proc/self/mem and extract ASCII strings",
    description:
      "Inspects live process memory contents. Sensitive — may expose in-process secrets. Length capped at 4 MiB per request.",
    tags: ["Diagnostics"],
    permission: "settings:write",
    sideEffects:
      "reads /proc/self/mem (Linux only); may expose in-process secrets in response",
    request: { body: RegionPeekRequest },
    response: RegionPeekResponse,
    errorResponses: [
      { status: 400, description: "Invalid start address or length" },
      { status: 501, description: "/proc/self/mem not available on this platform" },
    ],
  },
  (async (req, res) => {
    const body = (req.body ?? {}) as {
      start?: string;
      length?: number;
      minLen?: number;
      maxStrings?: number;
    };
    if (typeof body.start !== "string" || !/^[0-9a-f]+$/i.test(body.start)) {
      res
        .status(400)
        .json({ error: "start must be a hex address string (no 0x prefix)" });
      return;
    }
    const length = Number(body.length);
    if (!Number.isFinite(length) || length <= 0) {
      res.status(400).json({ error: "length must be a positive integer" });
      return;
    }

    const userId = (req as unknown as { user?: { id?: string } }).user?.id;
    logger.info(
      { userId, address: body.start, length, minLen: body.minLen },
      "region-peek: reading /proc/self/mem",
    );

    const result = await peekMemoryRegion(body.start.toLowerCase(), length, {
      minLen: body.minLen,
      maxStrings: body.maxStrings,
    });
    if (result === null) {
      res
        .status(501)
        .json({ error: "/proc/self/mem not available on this platform" });
      return;
    }
    res.json(result);
  }) as RequestHandler,
);

describe(
  "get",
  "/report",
  {
    summary: "Node.js diagnostic report (process.report.getReport)",
    description:
      "Downloads a JSON file that includes shared objects, libuv handles, native stack, and environment variables.",
    tags: ["Diagnostics"],
    permission: "settings:read",
    sideEffects: "generates an in-memory report (~1-10 MB); no side effects on the process",
    response: {
      contentType: "application/json",
      description: "Diagnostic report JSON (attachment)",
    },
    errorResponses: [
      { status: 500, description: "Failed to generate diagnostic report" },
    ],
  },
  ((_req, res) => {
    try {
      const report = process.report.getReport();
      const filename = `diagnostic-report-${Date.now()}-${process.pid}.json`;
      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.send(report);
    } catch (error) {
      logger.error({ error }, "Failed to generate diagnostic report");
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate diagnostic report",
      });
    }
  }) as RequestHandler,
);

describe(
  "post",
  "/heap-snapshot",
  {
    summary: "Capture a V8 heap snapshot and stream it to the caller",
    description:
      "Writes a .heapsnapshot file to a temp dir, streams it as a download, then deletes it. Loadable by Chrome DevTools Memory tab.",
    tags: ["Diagnostics"],
    permission: "settings:write",
    sideEffects:
      "briefly pauses the event loop while the snapshot is written; produces a 50-500 MB file",
    response: {
      contentType: "application/octet-stream",
      description: "V8 heap snapshot (.heapsnapshot attachment)",
    },
    errorResponses: [
      { status: 500, description: "Failed to write heap snapshot" },
    ],
  },
  (async (_req, res) => {
    const dir = process.env.HEAP_SNAPSHOT_DIR || os.tmpdir();
    const filename = `heap-${Date.now()}-${process.pid}.heapsnapshot`;
    const fullPath = path.join(dir, filename);

    let written: string | undefined;
    try {
      const startedAt = Date.now();
      written = v8.writeHeapSnapshot(fullPath);
      const writeDurationMs = Date.now() - startedAt;
      const { size } = await stat(written);
      logger.info(
        { path: written, writeDurationMs, size },
        "Heap snapshot written, streaming to client",
      );

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${path.basename(written)}"`,
      );
      res.setHeader("Content-Length", String(size));
      res.setHeader("X-Heap-Snapshot-Write-Duration-Ms", String(writeDurationMs));

      const stream = createReadStream(written);
      stream.pipe(res);

      await new Promise<void>((resolve, reject) => {
        stream.on("end", () => resolve());
        stream.on("error", reject);
        res.on("close", () => resolve());
      });
    } catch (error) {
      logger.error({ error }, "Failed to write heap snapshot");
      if (!res.headersSent) {
        res.status(500).json({
          error:
            error instanceof Error
              ? error.message
              : "Failed to write heap snapshot",
        });
      } else {
        res.end();
      }
    } finally {
      if (written) {
        unlink(written).catch((err) => {
          logger.warn(
            { err, path: written },
            "Failed to clean up heap snapshot file",
          );
        });
      }
    }
  }) as RequestHandler,
);

export default router;
