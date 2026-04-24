import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Stat, StatGrid } from "./stat-grid";
import { formatBytes, formatUptime, formatMicroseconds, formatCount } from "./diagnostics-utils";
import {
  PROCESS_EXPLANATIONS,
  HEAP_EXPLANATIONS,
  PROC_STATUS_EXPLANATIONS,
  SMAPS_ROLLUP_EXPLANATIONS,
  RESOURCE_USAGE_EXPLANATIONS,
} from "./diagnostics-explanations";
import type { MemoryDiagnostics, ProcStatus, SmapsRollup, ResourceUsage } from "./diagnostics-types";

export function ProcessSection({
  data,
  showExplanations,
}: {
  data: MemoryDiagnostics;
  showExplanations: boolean;
}) {
  const explain = (key: string) =>
    showExplanations ? PROCESS_EXPLANATIONS[key] : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Process</CardTitle>
        <CardDescription>
          PID {data.pid} · Node {data.nodeVersion} · {data.platform} · Uptime{" "}
          {formatUptime(data.uptimeSeconds)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <StatGrid showExplanations={showExplanations} cols={5}>
          <Stat label="RSS" value={formatBytes(data.process.rss)} description={explain("RSS")} />
          <Stat
            label="Heap used"
            value={formatBytes(data.process.heapUsed)}
            description={explain("Heap used")}
          />
          <Stat
            label="Heap total"
            value={formatBytes(data.process.heapTotal)}
            description={explain("Heap total")}
          />
          <Stat
            label="External"
            value={formatBytes(data.process.external)}
            description={explain("External")}
          />
          <Stat
            label="Array buffers"
            value={formatBytes(data.process.arrayBuffers)}
            description={explain("Array buffers")}
          />
        </StatGrid>
      </CardContent>
    </Card>
  );
}

export function LinuxProcessSection({
  procStatus,
  showExplanations,
}: {
  procStatus: ProcStatus;
  showExplanations: boolean;
}) {
  const explain = (key: string) =>
    showExplanations ? PROC_STATUS_EXPLANATIONS[key] : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Linux Process Memory</CardTitle>
        <CardDescription>
          /proc/self/status — explains where RSS goes beyond the V8 heap.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <StatGrid showExplanations={showExplanations}>
          <Stat label="VmRSS" value={formatBytes(procStatus.vmRSS)} description={explain("VmRSS")} />
          <Stat label="VmHWM" value={formatBytes(procStatus.vmHWM)} description={explain("VmHWM")} />
          <Stat label="RssAnon" value={formatBytes(procStatus.rssAnon)} description={explain("RssAnon")} />
          <Stat label="RssFile" value={formatBytes(procStatus.rssFile)} description={explain("RssFile")} />
          <Stat label="RssShmem" value={formatBytes(procStatus.rssShmem)} description={explain("RssShmem")} />
          <Stat label="VmData" value={formatBytes(procStatus.vmData)} description={explain("VmData")} />
          <Stat label="VmStk" value={formatBytes(procStatus.vmStk)} description={explain("VmStk")} />
          <Stat label="VmExe" value={formatBytes(procStatus.vmExe)} description={explain("VmExe")} />
          <Stat label="VmLib" value={formatBytes(procStatus.vmLib)} description={explain("VmLib")} />
          <Stat label="VmSize" value={formatBytes(procStatus.vmSize)} description={explain("VmSize")} />
          <Stat label="VmPeak" value={formatBytes(procStatus.vmPeak)} description={explain("VmPeak")} />
          <Stat label="VmSwap" value={formatBytes(procStatus.vmSwap)} description={explain("VmSwap")} />
          <Stat label="VmPTE" value={formatBytes(procStatus.vmPTE)} description={explain("VmPTE")} />
          <Stat
            label="Threads"
            value={procStatus.threads?.toString() ?? "—"}
            description={explain("Threads")}
          />
        </StatGrid>
      </CardContent>
    </Card>
  );
}

export function SmapsRollupSection({
  smapsRollup,
  showExplanations,
}: {
  smapsRollup: SmapsRollup;
  showExplanations: boolean;
}) {
  const explain = (key: string) =>
    showExplanations ? SMAPS_ROLLUP_EXPLANATIONS[key] : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Shared vs Private Memory</CardTitle>
        <CardDescription>
          /proc/self/smaps_rollup — your fair share (PSS) vs raw RSS.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <StatGrid showExplanations={showExplanations}>
          <Stat label="RSS" value={formatBytes(smapsRollup.rss)} description={explain("RSS")} />
          <Stat label="PSS" value={formatBytes(smapsRollup.pss)} description={explain("PSS")} />
          <Stat label="PSS Anon" value={formatBytes(smapsRollup.pssAnon)} description={explain("PSS Anon")} />
          <Stat label="PSS File" value={formatBytes(smapsRollup.pssFile)} description={explain("PSS File")} />
          <Stat
            label="Private Dirty"
            value={formatBytes(smapsRollup.privateDirty)}
            description={explain("Private Dirty")}
          />
          <Stat
            label="Private Clean"
            value={formatBytes(smapsRollup.privateClean)}
            description={explain("Private Clean")}
          />
          <Stat
            label="Shared Clean"
            value={formatBytes(smapsRollup.sharedClean)}
            description={explain("Shared Clean")}
          />
          <Stat
            label="Shared Dirty"
            value={formatBytes(smapsRollup.sharedDirty)}
            description={explain("Shared Dirty")}
          />
          <Stat
            label="Anonymous"
            value={formatBytes(smapsRollup.anonymous)}
            description={explain("Anonymous")}
          />
          <Stat
            label="Referenced"
            value={formatBytes(smapsRollup.referenced)}
            description={explain("Referenced")}
          />
          <Stat label="Swap" value={formatBytes(smapsRollup.swap)} description={explain("Swap")} />
        </StatGrid>
      </CardContent>
    </Card>
  );
}

export function HeapSection({
  data,
  showExplanations,
}: {
  data: MemoryDiagnostics;
  showExplanations: boolean;
}) {
  const explain = (key: string) =>
    showExplanations ? HEAP_EXPLANATIONS[key] : undefined;
  return (
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
        <StatGrid showExplanations={showExplanations}>
          <Stat label="Used" value={formatBytes(data.heap.usedHeapSize)} description={explain("Used")} />
          <Stat label="Total" value={formatBytes(data.heap.totalHeapSize)} description={explain("Total")} />
          <Stat
            label="Physical"
            value={formatBytes(data.heap.totalPhysicalSize)}
            description={explain("Physical")}
          />
          <Stat
            label="Available"
            value={formatBytes(data.heap.totalAvailableSize)}
            description={explain("Available")}
          />
          <Stat label="Limit" value={formatBytes(data.heap.heapSizeLimit)} description={explain("Limit")} />
          <Stat
            label="Malloced"
            value={formatBytes(data.heap.mallocedMemory)}
            description={explain("Malloced")}
          />
          <Stat
            label="Peak malloced"
            value={formatBytes(data.heap.peakMallocedMemory)}
            description={explain("Peak malloced")}
          />
          <Stat
            label="Native contexts"
            value={data.heap.numberOfNativeContexts.toString()}
            description={explain("Native contexts")}
          />
        </StatGrid>
      </CardContent>
    </Card>
  );
}

export function ResourceUsageSection({
  resourceUsage,
  showExplanations,
}: {
  resourceUsage: ResourceUsage;
  showExplanations: boolean;
}) {
  const explain = (key: string) =>
    showExplanations ? RESOURCE_USAGE_EXPLANATIONS[key] : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Resource Usage</CardTitle>
        <CardDescription>
          getrusage() — cumulative CPU, I/O, faults, and context switches since start.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <StatGrid showExplanations={showExplanations}>
          <Stat
            label="Max RSS"
            value={formatBytes(resourceUsage.maxRSS * 1024)}
            description={explain("Max RSS")}
          />
          <Stat
            label="User CPU"
            value={formatMicroseconds(resourceUsage.userCPUTime)}
            description={explain("User CPU")}
          />
          <Stat
            label="System CPU"
            value={formatMicroseconds(resourceUsage.systemCPUTime)}
            description={explain("System CPU")}
          />
          <Stat
            label="Minor page faults"
            value={formatCount(resourceUsage.minorPageFault)}
            description={explain("Minor page faults")}
          />
          <Stat
            label="Major page faults"
            value={formatCount(resourceUsage.majorPageFault)}
            description={explain("Major page faults")}
          />
          <Stat
            label="Voluntary ctx switches"
            value={formatCount(resourceUsage.voluntaryContextSwitches)}
            description={explain("Voluntary ctx switches")}
          />
          <Stat
            label="Involuntary ctx switches"
            value={formatCount(resourceUsage.involuntaryContextSwitches)}
            description={explain("Involuntary ctx switches")}
          />
          <Stat
            label="FS reads"
            value={formatCount(resourceUsage.fsRead)}
            description={explain("FS reads")}
          />
          <Stat
            label="FS writes"
            value={formatCount(resourceUsage.fsWrite)}
            description={explain("FS writes")}
          />
          <Stat
            label="IPC sent"
            value={formatCount(resourceUsage.ipcSent)}
            description={explain("IPC sent")}
          />
          <Stat
            label="IPC received"
            value={formatCount(resourceUsage.ipcReceived)}
            description={explain("IPC received")}
          />
          <Stat
            label="Signals"
            value={formatCount(resourceUsage.signalsCount)}
            description={explain("Signals")}
          />
        </StatGrid>
      </CardContent>
    </Card>
  );
}
