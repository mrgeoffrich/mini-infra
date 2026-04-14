import { Router, RequestHandler } from "express";
import { createReadStream } from "fs";
import { stat, unlink } from "fs/promises";
import v8 from "v8";
import os from "os";
import path from "path";
import { requirePermission } from "../middleware/auth";
import { appLogger } from "../lib/logger-factory";
import {
  readProcStatus,
  readSmapsRollup,
  readSmapsByPathname,
} from "../lib/proc-memory";

const router = Router();
const logger = appLogger();

// GET /api/diagnostics/memory - current memory usage snapshot
router.get("/memory", requirePermission("settings:read") as RequestHandler, (async (_req, res) => {
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
}) as RequestHandler);

// GET /api/diagnostics/smaps-top - aggregate /proc/self/smaps by pathname
// Returns the top N contributors to RSS. More expensive than /memory because
// smaps contains every mapped region — fetch on demand, not on every poll.
router.get("/smaps-top", requirePermission("settings:read") as RequestHandler, (async (req, res) => {
  const limitParam = Number(req.query.limit);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 25;

  const groups = await readSmapsByPathname(limit);
  if (groups === null) {
    res.status(501).json({ error: "smaps not available on this platform" });
    return;
  }
  res.json({ limit, groups });
}) as RequestHandler);

// GET /api/diagnostics/report - Node.js diagnostic report (process.report)
// Streams a JSON file that includes shared objects, libuv handles, native stack,
// environment variables, and more — useful for deep post-mortem analysis.
router.get("/report", requirePermission("settings:read") as RequestHandler, ((_req, res) => {
  try {
    const report = process.report.getReport();
    const filename = `diagnostic-report-${Date.now()}-${process.pid}.json`;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(report);
  } catch (error) {
    logger.error({ error }, "Failed to generate diagnostic report");
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to generate diagnostic report",
    });
  }
}) as RequestHandler);

// POST /api/diagnostics/heap-snapshot - write a heap snapshot and stream it to the client
// The file is created in a temp dir, streamed back as a download, then deleted.
router.post("/heap-snapshot", requirePermission("settings:write") as RequestHandler, (async (_req, res) => {
  const dir = process.env.HEAP_SNAPSHOT_DIR || os.tmpdir();
  const filename = `heap-${Date.now()}-${process.pid}.heapsnapshot`;
  const fullPath = path.join(dir, filename);

  let written: string | undefined;
  try {
    const startedAt = Date.now();
    written = v8.writeHeapSnapshot(fullPath);
    const writeDurationMs = Date.now() - startedAt;
    const { size } = await stat(written);
    logger.info({ path: written, writeDurationMs, size }, "Heap snapshot written, streaming to client");

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(written)}"`);
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
        error: error instanceof Error ? error.message : "Failed to write heap snapshot",
      });
    } else {
      res.end();
    }
  } finally {
    if (written) {
      unlink(written).catch((err) => {
        logger.warn({ err, path: written }, "Failed to clean up heap snapshot file");
      });
    }
  }
}) as RequestHandler);

export default router;
