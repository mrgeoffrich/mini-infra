import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { IconTerminal, IconAlertCircle, IconArrowsMaximize, IconArrowsMinimize } from "@tabler/icons-react";
import { useMonitoringStatus } from "@/hooks/use-monitoring";
import {
  useLogFilters,
  useLokiServices,
  useLokiLogs,
  TIME_RANGE_SECONDS,
} from "@/hooks/use-loki-logs";
import { LogControls } from "./LogControls";
import { LogStream } from "./LogStream";

interface LogsPageProps {
  fullscreen?: boolean;
}

export function LogsPage({ fullscreen = false }: LogsPageProps) {
  const queryClient = useQueryClient();
  const { data: status, isLoading: statusLoading, error: statusError } =
    useMonitoringStatus();
  const isRunning = status?.running === true;

  const { filters, updateFilter } = useLogFilters();
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(filters.search), 500);
    return () => clearTimeout(timer);
  }, [filters.search]);

  const { data: servicesData } = useLokiServices({
    enabled: isRunning,
  });
  const services = servicesData?.data ?? [];

  const {
    data: logsData,
    isLoading: logsLoading,
    isFetching,
    error: logsError,
  } = useLokiLogs(
    {
      services: filters.services,
      search: debouncedSearch,
      timeRangeSeconds: TIME_RANGE_SECONDS[filters.timeRange],
      limit: filters.limit,
      direction: filters.direction,
    },
    {
      enabled: isRunning,
      refetchInterval: filters.tailing ? 2000 : false,
    },
  );

  const maximizeButton = !fullscreen ? (
    <a href="/logs/fullscreen" target="_blank" rel="noopener noreferrer">
      <Button variant="outline" size="icon" className="h-9 w-9" title="Open fullscreen">
        <IconArrowsMaximize className="h-4 w-4" />
      </Button>
    </a>
  ) : (
    <Button
      variant="outline"
      size="icon"
      className="h-9 w-9"
      title="Close fullscreen"
      onClick={() => window.close()}
    >
      <IconArrowsMinimize className="h-4 w-4" />
    </Button>
  );

  if (statusError) {
    return (
      <div className={`flex flex-col gap-4 ${fullscreen ? "p-3" : "py-4 md:gap-6 md:py-6"}`}>
        <div className={fullscreen ? "" : "px-4 lg:px-6"}>
          {!fullscreen && <PageHeader />}
          <Alert variant="destructive" className={!fullscreen ? "mt-4" : ""}>
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load monitoring status: {statusError.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col ${fullscreen ? "h-screen" : "gap-4 py-4 md:gap-6 md:py-6"}`}>
      {!fullscreen && (
        <div className="px-4 lg:px-6">
          <PageHeader />
        </div>
      )}

      <div className={fullscreen ? "flex flex-col flex-1 min-h-0" : "px-4 lg:px-6"}>
        {statusLoading ? (
          <div className="text-center py-12 text-muted-foreground">
            Loading...
          </div>
        ) : !isRunning ? (
          <Card>
            <CardContent className="py-12 text-center">
              <IconAlertCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-lg font-medium mb-2">
                Monitoring Service Not Running
              </p>
              <p className="text-muted-foreground mb-4">
                Start the monitoring service to collect and query container
                logs.
              </p>
              <Link to="/monitoring">
                <Button>Go to Monitoring</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className={fullscreen ? "flex flex-col flex-1 min-h-0 gap-1" : "space-y-3"}>
            <div className={fullscreen ? "px-3 pt-2" : ""}>
              <LogControls
                filters={filters}
                services={services}
                updateFilter={updateFilter}
                onRefresh={() => queryClient.invalidateQueries({ queryKey: ["lokiLogs"] })}
                isLoading={logsLoading || isFetching}
                extraActions={maximizeButton}
              />
            </div>

            {logsError && (
              <Alert variant="destructive">
                <IconAlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Failed to query logs: {logsError.message}
                </AlertDescription>
              </Alert>
            )}

            <LogStream
              entries={logsData?.entries ?? []}
              isLoading={logsLoading}
              search={debouncedSearch}
              tailing={filters.tailing}
              entryCount={logsData?.entries.length}
              fullscreen={fullscreen}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function PageHeader() {
  return (
    <div className="flex items-center gap-3">
      <div className="p-3 rounded-md bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300">
        <IconTerminal className="h-6 w-6" />
      </div>
      <div>
        <h1 className="text-3xl font-bold">Container Logs</h1>
        <p className="text-muted-foreground">
          Search and browse centralized logs from all containers
        </p>
      </div>
    </div>
  );
}

export default LogsPage;
