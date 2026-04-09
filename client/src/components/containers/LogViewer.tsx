import React, { useEffect, useRef, useState, useCallback } from "react";
import { ansiToHtml } from "@/lib/ansi-to-html";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useContainerLogs } from "@/hooks/use-container-logs";
import {
  IconDownload,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconTrash,
  IconSearch,
  IconX,
  IconClock,
  IconClockOff,
  IconAlertCircle,
  IconCircleCheck,
  IconCircleDashed,
} from "@tabler/icons-react";

interface LogViewerProps {
  containerId: string;
  containerName: string;
}

// Escape regex metacharacters to prevent ReDoS
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function LogViewer({ containerId, containerName }: LogViewerProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const { logs, isConnected, error, clear, reconnect } = useContainerLogs({
    containerId,
    timestamps: showTimestamps,
    enabled: true,
  });

  // Filter logs based on search query
  const filteredLogs = React.useMemo(() => {
    if (!searchQuery.trim()) return logs;
    const query = searchQuery.toLowerCase();
    return logs.filter((log) => log.message.toLowerCase().includes(query));
  }, [logs, searchQuery]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && logContainerRef.current && filteredLogs.length > 0) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [filteredLogs, autoScroll]);

  const handleDownloadLogs = useCallback(() => {
    const logText = filteredLogs
      .map((log) => {
        const timestamp = log.timestamp ? `${log.timestamp} ` : "";
        const stream = log.stream === "stderr" ? "[stderr] " : "";
        return `${timestamp}${stream}${log.message}`;
      })
      .join("\n");

    const blob = new Blob([logText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${containerName}-logs-${new Date().toISOString()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filteredLogs, containerName]);

  const handleClearLogs = useCallback(() => {
    clear();
    setSearchQuery("");
  }, [clear]);

  const toggleAutoScroll = useCallback(() => {
    setAutoScroll((prev) => !prev);
  }, []);

  const toggleTimestamps = useCallback(() => {
    setShowTimestamps((prev) => !prev);
  }, []);

  const handleSearchToggle = useCallback(() => {
    setIsSearching((prev) => !prev);
    if (isSearching) {
      setSearchQuery("");
    }
  }, [isSearching]);

  // Render individual log line
  const renderLogLine = useCallback((log: any, index: number) => {
    const isStderr = log.stream === "stderr";

    // Convert ANSI codes to HTML
    const htmlMessage = ansiToHtml(log.message);

    // Highlight search matches safely:
    // 1. Escape regex metacharacters to prevent ReDoS
    // 2. Skip HTML tags to prevent XSS via dangerouslySetInnerHTML
    let displayMessage = htmlMessage;
    if (searchQuery.trim()) {
      const escapedQuery = escapeRegExp(searchQuery);
      // Match HTML tags (to preserve them) OR the search term (to highlight it)
      const tagOrMatch = new RegExp(`(<[^>]*>)|(${escapedQuery})`, "gi");
      displayMessage = displayMessage.replace(
        tagOrMatch,
        (_match, tag, text) =>
          tag
            ? tag
            : `<span class="bg-yellow-500/30 text-yellow-200">${text}</span>`
      );
    }

    return (
      <div
        key={index}
        className={`font-mono text-xs px-4 py-1 ${
          isStderr ? "text-gray-400" : "text-white"
        } hover:bg-gray-800/50`}
      >
        {showTimestamps && log.timestamp && (
          <span className="text-gray-500 mr-2">[{log.timestamp}]</span>
        )}
        <span
          dangerouslySetInnerHTML={{ __html: displayMessage }}
          className="whitespace-pre-wrap break-words"
        />
      </div>
    );
  }, [showTimestamps, searchQuery]);

  return (
    <Card className="flex flex-col h-full gap-2">
      <CardHeader className="pb-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CardTitle className="text-lg">Container Logs</CardTitle>
            {isConnected ? (
              <Badge variant="outline" className="gap-1">
                <IconCircleCheck className="h-3 w-3 text-green-500" />
                Connected
              </Badge>
            ) : error ? (
              <Badge variant="outline" className="gap-1">
                <IconAlertCircle className="h-3 w-3 text-red-500" />
                Disconnected
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1">
                <IconCircleDashed className="h-3 w-3 text-yellow-500" />
                Connecting...
              </Badge>
            )}
            <span className="text-sm text-muted-foreground">
              {filteredLogs.length} {filteredLogs.length === 1 ? "line" : "lines"}
              {searchQuery && logs.length !== filteredLogs.length && (
                <span className="ml-1">
                  (filtered from {logs.length})
                </span>
              )}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {isSearching && (
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  placeholder="Search logs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-64 h-8"
                  autoFocus
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSearchQuery("")}
                  disabled={!searchQuery}
                  className="h-8"
                >
                  <IconX className="h-4 w-4" />
                </Button>
              </div>
            )}

            <Button
              variant={isSearching ? "secondary" : "ghost"}
              size="sm"
              onClick={handleSearchToggle}
              className="h-8 w-8 p-0"
              title="Search logs"
            >
              <IconSearch className="h-4 w-4" />
            </Button>

            <Button
              variant={showTimestamps ? "secondary" : "ghost"}
              size="sm"
              onClick={toggleTimestamps}
              className="h-8 w-8 p-0"
              title={showTimestamps ? "Hide timestamps" : "Show timestamps"}
            >
              {showTimestamps ? (
                <IconClock className="h-4 w-4" />
              ) : (
                <IconClockOff className="h-4 w-4" />
              )}
            </Button>

            <Button
              variant={autoScroll ? "secondary" : "ghost"}
              size="sm"
              onClick={toggleAutoScroll}
              className="h-8 w-8 p-0"
              title={autoScroll ? "Disable auto-scroll" : "Enable auto-scroll"}
            >
              {autoScroll ? (
                <IconPlayerPause className="h-4 w-4" />
              ) : (
                <IconPlayerPlay className="h-4 w-4" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearLogs}
              disabled={logs.length === 0}
              className="h-8 w-8 p-0"
              title="Clear logs"
            >
              <IconTrash className="h-4 w-4" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={reconnect}
              disabled={isConnected}
              className="h-8 w-8 p-0"
              title="Reconnect"
            >
              <IconRefresh className="h-4 w-4" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownloadLogs}
              disabled={filteredLogs.length === 0}
              className="h-8 w-8 p-0"
              title="Download logs"
            >
              <IconDownload className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 p-0 overflow-hidden">
        {error && (
          <div className="px-4 py-2">
            <Alert variant="destructive">
              <IconAlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}

        <div
          ref={logContainerRef}
          className="bg-black rounded-md overflow-auto h-full"
          style={{ height: "calc(100% - 1rem)", margin: "0.5rem" }}
        >
          {filteredLogs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              {searchQuery ? "No logs match your search" : "No logs available"}
            </div>
          ) : (
            <div className="min-h-full">
              {filteredLogs.map((log, index) => renderLogLine(log, index))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
