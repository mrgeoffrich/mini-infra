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
        <div className="flex gap-2">
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
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-5">
                <Stat label="RSS" value={formatBytes(data.process.rss)} />
                <Stat
                  label="Heap used"
                  value={formatBytes(data.process.heapUsed)}
                />
                <Stat
                  label="Heap total"
                  value={formatBytes(data.process.heapTotal)}
                />
                <Stat
                  label="External"
                  value={formatBytes(data.process.external)}
                />
                <Stat
                  label="Array buffers"
                  value={formatBytes(data.process.arrayBuffers)}
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
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
                <Stat
                  label="Used"
                  value={formatBytes(data.heap.usedHeapSize)}
                />
                <Stat
                  label="Total"
                  value={formatBytes(data.heap.totalHeapSize)}
                />
                <Stat
                  label="Physical"
                  value={formatBytes(data.heap.totalPhysicalSize)}
                />
                <Stat
                  label="Available"
                  value={formatBytes(data.heap.totalAvailableSize)}
                />
                <Stat
                  label="Limit"
                  value={formatBytes(data.heap.heapSizeLimit)}
                />
                <Stat
                  label="Malloced"
                  value={formatBytes(data.heap.mallocedMemory)}
                />
                <Stat
                  label="Peak malloced"
                  value={formatBytes(data.heap.peakMallocedMemory)}
                />
                <Stat
                  label="Native contexts"
                  value={data.heap.numberOfNativeContexts.toString()}
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm">{value}</dd>
    </div>
  );
}
