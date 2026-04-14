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
  IconEye,
  IconFileText,
  IconLoader2,
  IconRefresh,
  IconSearch,
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

const PROC_STATUS_EXPLANATIONS: Record<string, string> = {
  "VmRSS": "Resident set — RAM pages currently held by the process. Should match RSS above.",
  "VmHWM": "High-water mark — peak RSS since the process started.",
  "RssAnon": "Anonymous RSS — JS heap, native heap (Prisma, etc.), and thread stacks.",
  "RssFile": "File-backed RSS — shared libraries and mmap'd files currently paged in.",
  "RssShmem": "Shared-memory RSS (tmpfs / /dev/shm mappings).",
  "VmData": "Data segment — writable heap + anonymous pages committed to the process.",
  "VmStk": "Total stack space across all threads.",
  "VmExe": "Text segment — the node executable's code mapped into memory.",
  "VmLib": "Shared library code mapped in (libssl, libc, Prisma query engine, etc.).",
  "VmSize": "Total virtual address space reserved (much larger than RSS; most is unresident).",
  "VmPeak": "Largest VmSize ever reached by the process.",
  "VmSwap": "Pages swapped out to disk.",
  "VmPTE": "Kernel memory used to track this process's page tables.",
  "Threads": "Number of OS threads the process currently has.",
};

const SMAPS_ROLLUP_EXPLANATIONS: Record<string, string> = {
  "RSS": "Same as VmRSS — total resident pages.",
  "PSS": "Proportional Set Size — your 'fair share' of RAM. Shared pages are divided by the number of processes sharing them.",
  "PSS Anon": "PSS attributable to anonymous pages (heaps + stacks).",
  "PSS File": "PSS attributable to file-backed pages (shared libraries, mmap'd files).",
  "PSS Shmem": "PSS attributable to shared-memory pages.",
  "Shared Clean":
    "Pages shared with other processes and unchanged since mapped (e.g. libc code). Cheap — cost is shared.",
  "Shared Dirty": "Shared writable pages that have been modified (rare outside shmem).",
  "Private Clean":
    "Pages private to this process and unchanged since mapped (e.g. your copy of a read-only lib).",
  "Private Dirty":
    "Pages private to this process and modified. This is unambiguously your own memory cost.",
  "Anonymous": "Anonymous pages (not backed by any file) currently in RAM.",
  "Referenced": "Pages marked as recently accessed by the kernel's page-replacement algorithm.",
  "Swap": "Pages swapped out to disk.",
};

const RESOURCE_USAGE_EXPLANATIONS: Record<string, string> = {
  "Max RSS": "Peak RSS ever reached by the process (from getrusage).",
  "User CPU": "Total CPU time spent in user-space code.",
  "System CPU": "Total CPU time spent in kernel-space (syscalls, I/O).",
  "Minor page faults":
    "Page faults resolved without disk I/O (page was already in memory or freshly allocated).",
  "Major page faults":
    "Page faults that required reading from disk — slow. High numbers suggest swapping or cold mmap'd files.",
  "Voluntary ctx switches":
    "Times the process yielded the CPU (waiting on I/O, locks, etc.).",
  "Involuntary ctx switches":
    "Times the kernel preempted the process (CPU contention, time slice expired).",
  "FS reads": "Number of reads from the filesystem performed on behalf of this process.",
  "FS writes": "Number of writes to the filesystem performed on behalf of this process.",
  "IPC sent": "Messages sent over IPC channels (Unix signals, pipes).",
  "IPC received": "Messages received over IPC channels.",
  "Signals": "Signals received (SIGTERM, SIGUSR1, etc.).",
  "Swapped out": "Times the process (or pages) were swapped to disk.",
};

interface ProcStatus {
  vmPeak: number | null;
  vmSize: number | null;
  vmHWM: number | null;
  vmRSS: number | null;
  rssAnon: number | null;
  rssFile: number | null;
  rssShmem: number | null;
  vmData: number | null;
  vmStk: number | null;
  vmExe: number | null;
  vmLib: number | null;
  vmPTE: number | null;
  vmSwap: number | null;
  threads: number | null;
}

interface SmapsRollup {
  rss: number | null;
  pss: number | null;
  pssAnon: number | null;
  pssFile: number | null;
  pssShmem: number | null;
  sharedClean: number | null;
  sharedDirty: number | null;
  privateClean: number | null;
  privateDirty: number | null;
  referenced: number | null;
  anonymous: number | null;
  swap: number | null;
  swapPss: number | null;
  locked: number | null;
}

interface ResourceUsage {
  userCPUTime: number;
  systemCPUTime: number;
  maxRSS: number;
  sharedMemorySize: number;
  unsharedDataSize: number;
  unsharedStackSize: number;
  minorPageFault: number;
  majorPageFault: number;
  swappedOut: number;
  fsRead: number;
  fsWrite: number;
  ipcSent: number;
  ipcReceived: number;
  signalsCount: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
}

interface MemoryDiagnostics {
  timestamp: string;
  uptimeSeconds: number;
  pid: number;
  nodeVersion: string;
  platform: string;
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
  resourceUsage: ResourceUsage;
  procStatus: ProcStatus | null;
  smapsRollup: SmapsRollup | null;
}

interface SmapsRegionGroup {
  pathname: string;
  regions: number;
  rss: number;
  pss: number;
  size: number;
  privateDirty: number;
  sharedClean: number;
}

interface SmapsTopResponse {
  limit: number;
  groups: SmapsRegionGroup[];
}

interface SmapsRegion {
  start: string;
  end: string;
  perms: string;
  pathname: string;
  size: number;
  rss: number;
  pss: number;
  privateDirty: number;
  sharedClean: number;
}

interface SmapsRegionsResponse {
  pathname: string | null;
  limit: number;
  regions: SmapsRegion[];
}

interface PeekResult {
  address: string;
  bytesRead: number;
  truncated: boolean;
  strings: Array<{ offset: number; text: string }>;
  hexPreview: string;
  error?: string;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
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

function formatMicroseconds(us: number): string {
  const seconds = us / 1_000_000;
  if (seconds >= 1) return `${seconds.toFixed(2)}s`;
  return `${(us / 1000).toFixed(1)}ms`;
}

function formatCount(n: number): string {
  return n.toLocaleString();
}

async function downloadFromResponse(res: Response, fallbackName: string) {
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = match?.[1] ?? fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return blob.size;
}

export default function SystemDiagnosticsPage() {
  const [downloadingHeap, setDownloadingHeap] = useState(false);
  const [downloadingReport, setDownloadingReport] = useState(false);
  const [showExplanations, setShowExplanations] = useState(false);
  const [smapsLoaded, setSmapsLoaded] = useState(false);
  const [inspectPathname, setInspectPathname] = useState("[anon]");
  const [inspectPeek, setInspectPeek] = useState<PeekResult | null>(null);
  const [peekingStart, setPeekingStart] = useState<string | null>(null);

  const query = useQuery<MemoryDiagnostics>({
    queryKey: ["diagnostics", "memory"],
    queryFn: async () => {
      const res = await fetch("/api/diagnostics/memory");
      if (!res.ok) throw new Error(`Failed to load memory diagnostics (${res.status})`);
      return res.json();
    },
    refetchInterval: 5000,
  });

  const smapsQuery = useQuery<SmapsTopResponse>({
    queryKey: ["diagnostics", "smaps-top"],
    queryFn: async () => {
      const res = await fetch("/api/diagnostics/smaps-top?limit=25");
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Failed to load smaps (${res.status})`);
      }
      return res.json();
    },
    enabled: smapsLoaded,
    refetchInterval: smapsLoaded ? 10000 : false,
  });

  const regionsQuery = useQuery<SmapsRegionsResponse>({
    queryKey: ["diagnostics", "smaps-regions", inspectPathname],
    queryFn: async () => {
      const res = await fetch(
        `/api/diagnostics/smaps-regions?pathname=${encodeURIComponent(inspectPathname)}&limit=10`,
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Failed to load regions (${res.status})`);
      }
      return res.json();
    },
    enabled: false,
  });

  const handlePeek = async (region: SmapsRegion) => {
    if (region.rss === 0) {
      toast.error("Region has no resident pages — nothing to peek.");
      return;
    }
    setPeekingStart(region.start);
    setInspectPeek(null);
    try {
      const res = await fetch("/api/diagnostics/region-peek", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: region.start,
          length: Math.min(region.rss, 2 * 1024 * 1024),
          minLen: 8,
          maxStrings: 200,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Peek failed (${res.status})`);
      }
      const data: PeekResult = await res.json();
      setInspectPeek(data);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to peek region",
      );
    } finally {
      setPeekingStart(null);
    }
  };

  const handleDownloadSnapshot = async () => {
    setDownloadingHeap(true);
    const toastId = toast.loading(
      "Capturing heap snapshot — this can take several seconds and temporarily pause the server...",
    );
    try {
      const res = await fetch("/api/diagnostics/heap-snapshot", { method: "POST" });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Snapshot failed (${res.status})`);
      }
      const size = await downloadFromResponse(res, `heap-${Date.now()}.heapsnapshot`);
      toast.success(`Heap snapshot downloaded (${formatBytes(size)})`, { id: toastId });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to capture heap snapshot",
        { id: toastId },
      );
    } finally {
      setDownloadingHeap(false);
    }
  };

  const handleDownloadReport = async () => {
    setDownloadingReport(true);
    const toastId = toast.loading("Generating diagnostic report...");
    try {
      const res = await fetch("/api/diagnostics/report");
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Report failed (${res.status})`);
      }
      const size = await downloadFromResponse(res, `diagnostic-report-${Date.now()}.json`);
      toast.success(`Diagnostic report downloaded (${formatBytes(size)})`, { id: toastId });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to generate diagnostic report",
        { id: toastId },
      );
    } finally {
      setDownloadingReport(false);
    }
  };

  const data = query.data;
  const procStatus = data?.procStatus;
  const smapsRollup = data?.smapsRollup;
  const resourceUsage = data?.resourceUsage;

  return (
    <div className="container mx-auto max-w-5xl space-y-6 py-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">System Diagnostics</h1>
          <p className="text-sm text-muted-foreground">
            Server process memory, V8 heap statistics, Linux memory maps, and downloadable diagnostic artifacts.
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
            variant="outline"
            size="sm"
            onClick={handleDownloadReport}
            disabled={downloadingReport}
          >
            {downloadingReport ? (
              <IconLoader2 className="h-4 w-4 animate-spin" />
            ) : (
              <IconFileText className="h-4 w-4" />
            )}
            Download report
          </Button>
          <Button
            size="sm"
            onClick={handleDownloadSnapshot}
            disabled={downloadingHeap}
          >
            {downloadingHeap ? (
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
                PID {data.pid} · Node {data.nodeVersion} · {data.platform} · Uptime{" "}
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

          {procStatus && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Linux Process Memory</CardTitle>
                <CardDescription>
                  /proc/self/status — explains where RSS goes beyond the V8 heap.
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
                    label="VmRSS"
                    value={formatBytes(procStatus.vmRSS)}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.VmRSS : undefined
                    }
                  />
                  <Stat
                    label="VmHWM"
                    value={formatBytes(procStatus.vmHWM)}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.VmHWM : undefined
                    }
                  />
                  <Stat
                    label="RssAnon"
                    value={formatBytes(procStatus.rssAnon)}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.RssAnon : undefined
                    }
                  />
                  <Stat
                    label="RssFile"
                    value={formatBytes(procStatus.rssFile)}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.RssFile : undefined
                    }
                  />
                  <Stat
                    label="RssShmem"
                    value={formatBytes(procStatus.rssShmem)}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.RssShmem : undefined
                    }
                  />
                  <Stat
                    label="VmData"
                    value={formatBytes(procStatus.vmData)}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.VmData : undefined
                    }
                  />
                  <Stat
                    label="VmStk"
                    value={formatBytes(procStatus.vmStk)}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.VmStk : undefined
                    }
                  />
                  <Stat
                    label="VmExe"
                    value={formatBytes(procStatus.vmExe)}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.VmExe : undefined
                    }
                  />
                  <Stat
                    label="VmLib"
                    value={formatBytes(procStatus.vmLib)}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.VmLib : undefined
                    }
                  />
                  <Stat
                    label="VmSize"
                    value={formatBytes(procStatus.vmSize)}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.VmSize : undefined
                    }
                  />
                  <Stat
                    label="VmPeak"
                    value={formatBytes(procStatus.vmPeak)}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.VmPeak : undefined
                    }
                  />
                  <Stat
                    label="VmSwap"
                    value={formatBytes(procStatus.vmSwap)}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.VmSwap : undefined
                    }
                  />
                  <Stat
                    label="VmPTE"
                    value={formatBytes(procStatus.vmPTE)}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.VmPTE : undefined
                    }
                  />
                  <Stat
                    label="Threads"
                    value={procStatus.threads?.toString() ?? "—"}
                    description={
                      showExplanations ? PROC_STATUS_EXPLANATIONS.Threads : undefined
                    }
                  />
                </dl>
              </CardContent>
            </Card>
          )}

          {smapsRollup && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Shared vs Private Memory</CardTitle>
                <CardDescription>
                  /proc/self/smaps_rollup — your fair share (PSS) vs raw RSS.
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
                    label="RSS"
                    value={formatBytes(smapsRollup.rss)}
                    description={
                      showExplanations ? SMAPS_ROLLUP_EXPLANATIONS.RSS : undefined
                    }
                  />
                  <Stat
                    label="PSS"
                    value={formatBytes(smapsRollup.pss)}
                    description={
                      showExplanations ? SMAPS_ROLLUP_EXPLANATIONS.PSS : undefined
                    }
                  />
                  <Stat
                    label="PSS Anon"
                    value={formatBytes(smapsRollup.pssAnon)}
                    description={
                      showExplanations
                        ? SMAPS_ROLLUP_EXPLANATIONS["PSS Anon"]
                        : undefined
                    }
                  />
                  <Stat
                    label="PSS File"
                    value={formatBytes(smapsRollup.pssFile)}
                    description={
                      showExplanations
                        ? SMAPS_ROLLUP_EXPLANATIONS["PSS File"]
                        : undefined
                    }
                  />
                  <Stat
                    label="Private Dirty"
                    value={formatBytes(smapsRollup.privateDirty)}
                    description={
                      showExplanations
                        ? SMAPS_ROLLUP_EXPLANATIONS["Private Dirty"]
                        : undefined
                    }
                  />
                  <Stat
                    label="Private Clean"
                    value={formatBytes(smapsRollup.privateClean)}
                    description={
                      showExplanations
                        ? SMAPS_ROLLUP_EXPLANATIONS["Private Clean"]
                        : undefined
                    }
                  />
                  <Stat
                    label="Shared Clean"
                    value={formatBytes(smapsRollup.sharedClean)}
                    description={
                      showExplanations
                        ? SMAPS_ROLLUP_EXPLANATIONS["Shared Clean"]
                        : undefined
                    }
                  />
                  <Stat
                    label="Shared Dirty"
                    value={formatBytes(smapsRollup.sharedDirty)}
                    description={
                      showExplanations
                        ? SMAPS_ROLLUP_EXPLANATIONS["Shared Dirty"]
                        : undefined
                    }
                  />
                  <Stat
                    label="Anonymous"
                    value={formatBytes(smapsRollup.anonymous)}
                    description={
                      showExplanations
                        ? SMAPS_ROLLUP_EXPLANATIONS.Anonymous
                        : undefined
                    }
                  />
                  <Stat
                    label="Referenced"
                    value={formatBytes(smapsRollup.referenced)}
                    description={
                      showExplanations
                        ? SMAPS_ROLLUP_EXPLANATIONS.Referenced
                        : undefined
                    }
                  />
                  <Stat
                    label="Swap"
                    value={formatBytes(smapsRollup.swap)}
                    description={
                      showExplanations ? SMAPS_ROLLUP_EXPLANATIONS.Swap : undefined
                    }
                  />
                </dl>
              </CardContent>
            </Card>
          )}

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

          {resourceUsage && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Resource Usage</CardTitle>
                <CardDescription>
                  getrusage() — cumulative CPU, I/O, faults, and context switches since start.
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
                    label="Max RSS"
                    value={formatBytes(resourceUsage.maxRSS * 1024)}
                    description={
                      showExplanations
                        ? RESOURCE_USAGE_EXPLANATIONS["Max RSS"]
                        : undefined
                    }
                  />
                  <Stat
                    label="User CPU"
                    value={formatMicroseconds(resourceUsage.userCPUTime)}
                    description={
                      showExplanations
                        ? RESOURCE_USAGE_EXPLANATIONS["User CPU"]
                        : undefined
                    }
                  />
                  <Stat
                    label="System CPU"
                    value={formatMicroseconds(resourceUsage.systemCPUTime)}
                    description={
                      showExplanations
                        ? RESOURCE_USAGE_EXPLANATIONS["System CPU"]
                        : undefined
                    }
                  />
                  <Stat
                    label="Minor page faults"
                    value={formatCount(resourceUsage.minorPageFault)}
                    description={
                      showExplanations
                        ? RESOURCE_USAGE_EXPLANATIONS["Minor page faults"]
                        : undefined
                    }
                  />
                  <Stat
                    label="Major page faults"
                    value={formatCount(resourceUsage.majorPageFault)}
                    description={
                      showExplanations
                        ? RESOURCE_USAGE_EXPLANATIONS["Major page faults"]
                        : undefined
                    }
                  />
                  <Stat
                    label="Voluntary ctx switches"
                    value={formatCount(resourceUsage.voluntaryContextSwitches)}
                    description={
                      showExplanations
                        ? RESOURCE_USAGE_EXPLANATIONS["Voluntary ctx switches"]
                        : undefined
                    }
                  />
                  <Stat
                    label="Involuntary ctx switches"
                    value={formatCount(resourceUsage.involuntaryContextSwitches)}
                    description={
                      showExplanations
                        ? RESOURCE_USAGE_EXPLANATIONS["Involuntary ctx switches"]
                        : undefined
                    }
                  />
                  <Stat
                    label="FS reads"
                    value={formatCount(resourceUsage.fsRead)}
                    description={
                      showExplanations
                        ? RESOURCE_USAGE_EXPLANATIONS["FS reads"]
                        : undefined
                    }
                  />
                  <Stat
                    label="FS writes"
                    value={formatCount(resourceUsage.fsWrite)}
                    description={
                      showExplanations
                        ? RESOURCE_USAGE_EXPLANATIONS["FS writes"]
                        : undefined
                    }
                  />
                  <Stat
                    label="IPC sent"
                    value={formatCount(resourceUsage.ipcSent)}
                    description={
                      showExplanations
                        ? RESOURCE_USAGE_EXPLANATIONS["IPC sent"]
                        : undefined
                    }
                  />
                  <Stat
                    label="IPC received"
                    value={formatCount(resourceUsage.ipcReceived)}
                    description={
                      showExplanations
                        ? RESOURCE_USAGE_EXPLANATIONS["IPC received"]
                        : undefined
                    }
                  />
                  <Stat
                    label="Signals"
                    value={formatCount(resourceUsage.signalsCount)}
                    description={
                      showExplanations
                        ? RESOURCE_USAGE_EXPLANATIONS.Signals
                        : undefined
                    }
                  />
                </dl>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-base">Top Contributors to RSS</CardTitle>
                  <CardDescription>
                    /proc/self/smaps aggregated by mapped pathname. Accounts for shared libraries and mmap'd files.
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (!smapsLoaded) setSmapsLoaded(true);
                    else smapsQuery.refetch();
                  }}
                  disabled={smapsQuery.isFetching}
                >
                  {smapsQuery.isFetching ? (
                    <IconLoader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <IconSearch className="h-4 w-4" />
                  )}
                  {smapsLoaded ? "Refresh" : "Load"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {smapsQuery.isError && (
                <Alert variant="destructive" className="mb-4">
                  <IconAlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {smapsQuery.error instanceof Error
                      ? smapsQuery.error.message
                      : "Failed to load smaps"}
                  </AlertDescription>
                </Alert>
              )}
              {!smapsLoaded && !smapsQuery.data && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Click Load to aggregate /proc/self/smaps by pathname.
                </p>
              )}
              {smapsQuery.data && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Pathname</TableHead>
                      <TableHead className="text-right">Regions</TableHead>
                      <TableHead className="text-right">RSS</TableHead>
                      <TableHead className="text-right">PSS</TableHead>
                      <TableHead className="text-right">Private Dirty</TableHead>
                      <TableHead className="text-right">Size</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {smapsQuery.data.groups.map((g) => (
                      <TableRow key={g.pathname}>
                        <TableCell
                          className="max-w-md truncate font-mono text-xs"
                          title={g.pathname}
                        >
                          {g.pathname}
                        </TableCell>
                        <TableCell className="text-right">{g.regions}</TableCell>
                        <TableCell className="text-right">
                          {formatBytes(g.rss)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatBytes(g.pss)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatBytes(g.privateDirty)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatBytes(g.size)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-base">Inspect Memory Region</CardTitle>
                  <CardDescription>
                    Pick a pathname, load its top regions by RSS, then peek one to
                    extract printable strings from /proc/self/mem. Helpful for
                    guessing what&apos;s living in an anonymous region (SQL text, JSON
                    payloads, identifier patterns, etc.).
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <select
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                    value={inspectPathname}
                    onChange={(e) => {
                      setInspectPathname(e.target.value);
                      setInspectPeek(null);
                    }}
                  >
                    <option value="[anon]">[anon]</option>
                    <option value="[heap]">[heap]</option>
                    <option value="[stack]">[stack]</option>
                    {smapsQuery.data?.groups
                      .filter(
                        (g) =>
                          !["[anon]", "[heap]", "[stack]"].includes(g.pathname),
                      )
                      .map((g) => (
                        <option key={g.pathname} value={g.pathname}>
                          {g.pathname}
                        </option>
                      ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => regionsQuery.refetch()}
                    disabled={regionsQuery.isFetching}
                  >
                    {regionsQuery.isFetching ? (
                      <IconLoader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <IconSearch className="h-4 w-4" />
                    )}
                    Find regions
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {regionsQuery.isError && (
                <Alert variant="destructive">
                  <IconAlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {regionsQuery.error instanceof Error
                      ? regionsQuery.error.message
                      : "Failed to load regions"}
                  </AlertDescription>
                </Alert>
              )}

              {!regionsQuery.data && !regionsQuery.isFetching && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Pick a pathname (defaults to [anon] — the bulk of your RSS) and
                  click Find regions.
                </p>
              )}

              {regionsQuery.data && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Address</TableHead>
                      <TableHead>Perms</TableHead>
                      <TableHead className="text-right">RSS</TableHead>
                      <TableHead className="text-right">PSS</TableHead>
                      <TableHead className="text-right">Size</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {regionsQuery.data.regions.map((r) => (
                      <TableRow key={`${r.start}-${r.end}`}>
                        <TableCell className="font-mono text-xs">
                          0x{r.start}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {r.perms}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatBytes(r.rss)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatBytes(r.pss)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatBytes(r.size)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handlePeek(r)}
                            disabled={peekingStart === r.start || r.rss === 0}
                          >
                            {peekingStart === r.start ? (
                              <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <IconEye className="h-3.5 w-3.5" />
                            )}
                            Peek
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              {inspectPeek && (
                <div className="space-y-2 rounded-md border p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-sm font-semibold">
                      {inspectPeek.address} · {formatBytes(inspectPeek.bytesRead)} read
                      {inspectPeek.truncated && " (strings truncated)"}
                    </div>
                    {inspectPeek.error && (
                      <span className="text-xs text-destructive">
                        {inspectPeek.error}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {inspectPeek.strings.length} strings (min length 8). Hex
                    preview of first 256 bytes:
                  </div>
                  <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
                    {inspectPeek.hexPreview.match(/.{1,32}/g)?.join("\n") ?? ""}
                  </pre>
                  {inspectPeek.strings.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No printable ASCII strings of length ≥ 8 found. This region is
                      likely binary data (V8 internal state, compressed pages,
                      compiled code, etc.).
                    </p>
                  ) : (
                    <div className="max-h-96 overflow-auto rounded bg-muted p-2">
                      <table className="w-full text-xs">
                        <tbody>
                          {inspectPeek.strings.map((s, i) => (
                            <tr key={i} className="align-top">
                              <td className="pr-3 font-mono text-muted-foreground">
                                +{s.offset.toString(16)}
                              </td>
                              <td className="break-all font-mono">{s.text}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {data.procStatus === null && (
            <Alert>
              <IconAlertCircle className="h-4 w-4" />
              <AlertDescription>
                /proc/self is unavailable on this platform ({data.platform}) — Linux-only memory
                maps are hidden. Container-hosted deployments should see the full breakdown.
              </AlertDescription>
            </Alert>
          )}

          <Alert>
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Heap snapshots can be large (tens to hundreds of MB) and briefly pause the event loop
              while they&apos;re written. Load the downloaded{" "}
              <code className="font-mono">.heapsnapshot</code> file in Chrome DevTools → Memory
              tab to analyse retainers. The diagnostic report is a JSON file listing shared objects,
              libuv handles, and native stack info. The memory-region peek reads raw process memory
              via /proc/self/mem — treat any returned strings as potentially sensitive (may include
              query text, tokens, or PII held in caches).
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
