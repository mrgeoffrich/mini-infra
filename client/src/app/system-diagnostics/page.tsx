import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  IconAlertCircle,
  IconDownload,
  IconLoader2,
  IconRefresh,
} from "@tabler/icons-react";

const PROCESS_EXPLANATIONS: Record<string, string> = {
  RSS: "Resident Set Size — total RAM the process holds, including heap, code, stacks, and native allocations.",
  "Heap used": "JavaScript objects currently alive in the V8 heap.",
  "Heap total": "Size V8 has committed for the heap; grows as needed up to the limit.",
  External:
    "Memory held by C++ objects bound to JS (Buffers, native addons, etc.) — lives outside the V8 heap.",
  "Array buffers":
    "Bytes allocated for ArrayBuffers / SharedArrayBuffers. Counted within External.",
};

const HEAP_EXPLANATIONS: Record<string, string> = {
  Used: "Live JS objects in the heap right now.",
  Total: "Committed heap size — what V8 has reserved from the OS.",
  Physical:
    "Heap pages actually backed by RAM. Can be lower than Total if pages were released.",
  Available: "Headroom before hitting the heap size limit.",
  Limit:
    "Maximum heap V8 will grow to (controlled by --max-old-space-size). OOM crashes happen past this.",
  Malloced: "V8's current internal C++ allocations (metadata, parser state, etc.).",
  "Peak malloced": "Highest malloced value since process start — useful for spotting transient spikes.",
  "Native contexts":
    "Top-level JS contexts. Normally 1. Growing numbers usually indicate leaked vm/iframe contexts.",
};

const HEAP_SPACE_EXPLANATIONS: Record<string, string> = {
  read_only_space: "Immutable V8 internals (builtins, snapshots). Shared, never GC'd.",
  new_space:
    "Young generation — where new allocations land. Collected frequently (scavenge GC).",
  old_space: "Objects that survived enough young GCs to be promoted. Collected by mark-sweep.",
  code_space: "JIT-compiled machine code for hot JS functions.",
  shared_space: "Objects shared across isolates (worker threads).",
  trusted_space: "V8 internal objects treated as trusted (sandbox-related).",
  shared_trusted_space: "Trusted objects shared across isolates.",
  new_large_object_space:
    "Large allocations (≥~500 KB) made in the young generation — too big for new_space.",
  large_object_space: "Large allocations in the old generation.",
  code_large_object_space: "Oversized compiled code objects.",
  shared_large_object_space: "Large shared objects across isolates.",
  shared_trusted_large_object_space: "Large trusted shared objects.",
  trusted_large_object_space: "Large trusted objects.",
};

interface MemoryDiagnostics {
  timestamp: string;
  uptimeSeconds: number;
  pid: number;
  nodeVersion: string;
  process: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  heap: {
    totalHeapSize: number;
    totalHeapSizeExecutable: number;
    totalPhysicalSize: number;
    totalAvailableSize: number;
    usedHeapSize: number;
    heapSizeLimit: number;
    mallocedMemory: number;
    peakMallocedMemory: number;
    numberOfNativeContexts: number;
    numberOfDetachedContexts: number;
  };
  heapSpaces: Array<{
    name: string;
    size: number;
    used: number;
    available: number;
    physical: number;
  }>;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function SystemDiagnosticsPage() {
  const [downloading, setDownloading] = useState(false);
  const [showExplanations, setShowExplanations] = useState(false);

  const query = useQuery<MemoryDiagnostics>({
    queryKey: ["diagnostics", "memory"],
    queryFn: async () => {
      const res = await fetch("/api/diagnostics/memory");
      if (!res.ok) throw new Error(`Failed to load memory diagnostics (${res.status})`);
      return res.json();
    },
    refetchInterval: 5000,
  });

  const handleDownloadSnapshot = async () => {
    setDownloading(true);
    const toastId = toast.loading(
      "Capturing heap snapshot — this can take several seconds and temporarily pause the server...",
    );
    try {
      const res = await fetch("/api/diagnostics/heap-snapshot", {
        method: "POST",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Snapshot failed (${res.status})`);
      }

      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match?.[1] ?? `heap-${Date.now()}.heapsnapshot`;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      toast.success(`Heap snapshot downloaded (${formatBytes(blob.size)})`, {
        id: toastId,
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to capture heap snapshot",
        { id: toastId },
      );
    } finally {
      setDownloading(false);
    }
  };

  const data = query.data;

  return (
    <div className="container mx-auto max-w-5xl space-y-6 py-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">System Diagnostics</h1>
          <p className="text-sm text-muted-foreground">
            Server process memory, V8 heap statistics, and heap snapshots.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="show-explanations"
              checked={showExplanations}
              onCheckedChange={setShowExplanations}
            />
            <Label htmlFor="show-explanations" className="text-sm">
              Show explanations
            </Label>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            {query.isFetching ? (
              <IconLoader2 className="h-4 w-4 animate-spin" />
            ) : (
              <IconRefresh className="h-4 w-4" />
            )}
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={handleDownloadSnapshot}
            disabled={downloading}
          >
            {downloading ? (
              <IconLoader2 className="h-4 w-4 animate-spin" />
            ) : (
              <IconDownload className="h-4 w-4" />
            )}
            Download heap snapshot
          </Button>
        </div>
      </div>

      {query.isError && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            {query.error instanceof Error
              ? query.error.message
              : "Failed to load diagnostics"}
          </AlertDescription>
        </Alert>
      )}

      {data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Process</CardTitle>
              <CardDescription>
                PID {data.pid} · Node {data.nodeVersion} · Uptime{" "}
                {formatUptime(data.uptimeSeconds)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl
                className={`grid gap-x-6 gap-y-3 ${
                  showExplanations
                    ? "grid-cols-1 md:grid-cols-2"
                    : "grid-cols-2 md:grid-cols-5"
                }`}
              >
                <Stat
                  label="RSS"
                  value={formatBytes(data.process.rss)}
                  description={showExplanations ? PROCESS_EXPLANATIONS.RSS : undefined}
                />
                <Stat
                  label="Heap used"
                  value={formatBytes(data.process.heapUsed)}
                  description={
                    showExplanations ? PROCESS_EXPLANATIONS["Heap used"] : undefined
                  }
                />
                <Stat
                  label="Heap total"
                  value={formatBytes(data.process.heapTotal)}
                  description={
                    showExplanations ? PROCESS_EXPLANATIONS["Heap total"] : undefined
                  }
                />
                <Stat
                  label="External"
                  value={formatBytes(data.process.external)}
                  description={
                    showExplanations ? PROCESS_EXPLANATIONS.External : undefined
                  }
                />
                <Stat
                  label="Array buffers"
                  value={formatBytes(data.process.arrayBuffers)}
                  description={
                    showExplanations
                      ? PROCESS_EXPLANATIONS["Array buffers"]
                      : undefined
                  }
                />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">V8 Heap</CardTitle>
              <CardDescription>
                Used {formatBytes(data.heap.usedHeapSize)} of{" "}
                {formatBytes(data.heap.heapSizeLimit)} limit
                {data.heap.numberOfDetachedContexts > 0 && (
                  <span className="ml-2 text-destructive">
                    · {data.heap.numberOfDetachedContexts} detached context
                    {data.heap.numberOfDetachedContexts === 1 ? "" : "s"}
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl
                className={`grid gap-x-6 gap-y-3 ${
                  showExplanations
                    ? "grid-cols-1 md:grid-cols-2"
                    : "grid-cols-2 md:grid-cols-4"
                }`}
              >
                <Stat
                  label="Used"
                  value={formatBytes(data.heap.usedHeapSize)}
                  description={showExplanations ? HEAP_EXPLANATIONS.Used : undefined}
                />
                <Stat
                  label="Total"
                  value={formatBytes(data.heap.totalHeapSize)}
                  description={showExplanations ? HEAP_EXPLANATIONS.Total : undefined}
                />
                <Stat
                  label="Physical"
                  value={formatBytes(data.heap.totalPhysicalSize)}
                  description={showExplanations ? HEAP_EXPLANATIONS.Physical : undefined}
                />
                <Stat
                  label="Available"
                  value={formatBytes(data.heap.totalAvailableSize)}
                  description={
                    showExplanations ? HEAP_EXPLANATIONS.Available : undefined
                  }
                />
                <Stat
                  label="Limit"
                  value={formatBytes(data.heap.heapSizeLimit)}
                  description={showExplanations ? HEAP_EXPLANATIONS.Limit : undefined}
                />
                <Stat
                  label="Malloced"
                  value={formatBytes(data.heap.mallocedMemory)}
                  description={showExplanations ? HEAP_EXPLANATIONS.Malloced : undefined}
                />
                <Stat
                  label="Peak malloced"
                  value={formatBytes(data.heap.peakMallocedMemory)}
                  description={
                    showExplanations ? HEAP_EXPLANATIONS["Peak malloced"] : undefined
                  }
                />
                <Stat
                  label="Native contexts"
                  value={data.heap.numberOfNativeContexts.toString()}
                  description={
                    showExplanations
                      ? HEAP_EXPLANATIONS["Native contexts"]
                      : undefined
                  }
                />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Heap Spaces</CardTitle>
              <CardDescription>Per-space allocation breakdown</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Space</TableHead>
                    <TableHead className="text-right">Used</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead className="text-right">Physical</TableHead>
                    {showExplanations && <TableHead>What it holds</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.heapSpaces.map((space) => (
                    <TableRow key={space.name}>
                      <TableCell className="font-mono text-xs">
                        {space.name}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatBytes(space.used)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatBytes(space.size)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatBytes(space.available)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatBytes(space.physical)}
                      </TableCell>
                      {showExplanations && (
                        <TableCell className="text-xs text-muted-foreground">
                          {HEAP_SPACE_EXPLANATIONS[space.name] ?? "—"}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Alert>
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Heap snapshots can be large (tens to hundreds of MB) and
              briefly pause the event loop while they&apos;re written. Load the
              downloaded <code className="font-mono">.heapsnapshot</code> file
              in Chrome DevTools → Memory tab to analyse retainers.
            </AlertDescription>
          </Alert>
        </>
      )}

      {!data && query.isLoading && (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <IconLoader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description?: string;
}) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm">{value}</dd>
      {description && (
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
