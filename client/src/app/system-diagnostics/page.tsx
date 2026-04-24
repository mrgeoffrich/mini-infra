import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  IconAlertCircle,
  IconDownload,
  IconFileText,
  IconLoader2,
  IconRefresh,
} from "@tabler/icons-react";
import { useDiagnostics } from "./use-diagnostics";
import { formatBytes, downloadFromResponse } from "./diagnostics-utils";
import {
  ProcessSection,
  LinuxProcessSection,
  SmapsRollupSection,
  HeapSection,
  ResourceUsageSection,
} from "./diagnostics-sections";
import { HeapSpacesTable, SmapsTopTable } from "./diagnostics-tables";
import { RegionInspectPanel } from "./region-inspect";

export default function SystemDiagnosticsPage() {
  const [downloadingHeap, setDownloadingHeap] = useState(false);
  const [downloadingReport, setDownloadingReport] = useState(false);
  const [showExplanations, setShowExplanations] = useState(false);

  const {
    query,
    smapsQuery,
    regionsQuery,
    smapsLoaded,
    inspectPathname,
    setInspectPathname,
    inspectPeek,
    peekingStart,
    handlePeek,
    loadOrRefreshSmaps,
  } = useDiagnostics();

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
          <Button size="sm" onClick={handleDownloadSnapshot} disabled={downloadingHeap}>
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
          <ProcessSection data={data} showExplanations={showExplanations} />
          {data.procStatus && (
            <LinuxProcessSection
              procStatus={data.procStatus}
              showExplanations={showExplanations}
            />
          )}
          {data.smapsRollup && (
            <SmapsRollupSection
              smapsRollup={data.smapsRollup}
              showExplanations={showExplanations}
            />
          )}
          <HeapSection data={data} showExplanations={showExplanations} />
          <HeapSpacesTable heapSpaces={data.heapSpaces} showExplanations={showExplanations} />
          {data.resourceUsage && (
            <ResourceUsageSection
              resourceUsage={data.resourceUsage}
              showExplanations={showExplanations}
            />
          )}
          <SmapsTopTable
            smapsQuery={smapsQuery}
            smapsLoaded={smapsLoaded}
            onLoadOrRefresh={loadOrRefreshSmaps}
          />
          <RegionInspectPanel
            regionsQuery={regionsQuery}
            smapsGroups={smapsQuery.data?.groups}
            inspectPathname={inspectPathname}
            onPathnameChange={setInspectPathname}
            inspectPeek={inspectPeek}
            peekingStart={peekingStart}
            onPeek={handlePeek}
          />

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
