import React, { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconCopy, IconDownload } from "@tabler/icons-react";
import { toast } from "sonner";
import type { LogEntry } from "@/hooks/use-loki-logs";

interface LogStreamProps {
  entries: LogEntry[];
  isLoading: boolean;
  search: string;
  tailing: boolean;
  entryCount?: number;
}

function detectLogLevel(
  line: string,
): "error" | "warn" | "debug" | null {
  const prefix = line.slice(0, 120).toLowerCase();
  if (/\b(error|fatal|panic|err)\b/.test(prefix)) return "error";
  if (/\b(warn|warning|wrn)\b/.test(prefix)) return "warn";
  if (/\b(debug|dbg|trace)\b/.test(prefix)) return "debug";
  return null;
}

const LEVEL_COLORS: Record<string, string> = {
  error: "text-red-400",
  warn: "text-yellow-400",
  debug: "text-gray-500",
};

const LEVEL_BORDER: Record<string, string> = {
  error: "border-red-500/50",
  warn: "border-yellow-500/50",
};

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatTime(ms: number): string {
  if (!ms || isNaN(ms)) return "--:--:--.---";
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const frac = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${frac}`;
}

function formatFullTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

export function LogStream({
  entries,
  isLoading,
  search,
  tailing,
  entryCount,
}: LogStreamProps) {
  const [expandedLines, setExpandedLines] = useState<Set<number>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  const toggleExpanded = useCallback((index: number) => {
    setExpandedLines((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  // Auto-scroll to top when tailing (newest first = new entries at top)
  useEffect(() => {
    if (tailing && containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [entries, tailing]);

  const handleCopy = useCallback(async () => {
    const text = entries
      .map(
        (e) =>
          `${formatFullTimestamp(e.timestamp)} [${e.labels.container || "unknown"}] ${e.line}`,
      )
      .join("\n");
    await navigator.clipboard.writeText(text);
    toast.success("Logs copied to clipboard");
  }, [entries]);

  const handleDownload = useCallback(() => {
    const text = entries
      .map(
        (e) =>
          `${formatFullTimestamp(e.timestamp)} [${e.labels.container || "unknown"}] ${e.line}`,
      )
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `container-logs-${new Date().toISOString().slice(0, 19)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Logs downloaded");
  }, [entries]);

  const highlightSearch = useCallback(
    (text: string): React.ReactNode => {
      if (!search) return text;
      try {
        const escaped = escapeRegExp(search);
        const parts = text.split(new RegExp(`(${escaped})`, "gi"));
        if (parts.length === 1) return text;
        return parts.map((part, i) =>
          i % 2 === 1 ? (
            <mark
              key={i}
              className="bg-yellow-500/40 text-yellow-200 rounded-sm px-0.5"
            >
              {part}
            </mark>
          ) : (
            part
          ),
        );
      } catch {
        return text;
      }
    },
    [search],
  );

  if (isLoading && entries.length === 0) {
    return (
      <div className="bg-black rounded-md h-[calc(100vh-300px)] min-h-[400px] flex items-center justify-center text-gray-500 font-mono text-sm">
        Loading logs...
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="bg-black rounded-md h-[calc(100vh-300px)] min-h-[400px] flex items-center justify-center text-gray-500 font-mono text-sm">
        No logs found for the selected filters
      </div>
    );
  }

  return (
    <div>
      {/* Stats and action buttons */}
      <div className="flex items-center justify-between mb-1">
        {entryCount !== undefined ? (
          <span className="text-sm text-muted-foreground">
            {entryCount.toLocaleString()} log{" "}
            {entryCount === 1 ? "line" : "lines"} - Most recent logs are at
            the top.
            {tailing && " · auto-refreshing"}
          </span>
        ) : (
          <span />
        )}
        <div className="flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={handleCopy}
          title="Copy all logs"
        >
          <IconCopy className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={handleDownload}
          title="Download logs"
        >
          <IconDownload className="h-3.5 w-3.5" />
        </Button>
        </div>
      </div>

      {/* Log lines */}
      <div
        ref={containerRef}
        className="bg-black rounded-md h-[calc(100vh-300px)] min-h-[400px] overflow-auto font-mono text-xs"
      >
        {entries.map((entry, index) => {
          const level = detectLogLevel(entry.line);
          const isExpanded = expandedLines.has(index);
          const textColor = level
            ? (LEVEL_COLORS[level] ?? "text-gray-200")
            : "text-gray-200";
          const borderColor = level
            ? (LEVEL_BORDER[level] ?? "border-transparent")
            : "border-transparent";

          return (
            <div key={`${entry.timestampNano}-${index}`}>
              <div
                className={`flex items-start gap-2 px-3 py-0.5 hover:bg-gray-800/60 cursor-pointer border-l-2 ${borderColor}`}
                onClick={() => toggleExpanded(index)}
              >
                <span className="text-white select-none shrink-0 tabular-nums">
                  {formatTime(entry.timestamp)}
                </span>
                <span
                  className="text-cyan-600 shrink-0 w-28 truncate"
                  title={entry.labels.container}
                >
                  {entry.labels.compose_service ||
                    entry.labels.container ||
                    "unknown"}
                </span>
                <span
                  className={`${textColor} whitespace-pre-wrap break-all flex-1`}
                >
                  {highlightSearch(entry.line)}
                </span>
              </div>

              {isExpanded && (
                <div className="bg-gray-900/80 px-3 py-2 ml-8 border-l-2 border-gray-700 mb-1">
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {Object.entries(entry.labels).map(([key, value]) => (
                      <Badge
                        key={key}
                        variant="outline"
                        className="text-[10px] text-gray-400 border-gray-700 font-mono"
                      >
                        {key}={value}
                      </Badge>
                    ))}
                    <Badge
                      variant="outline"
                      className="text-[10px] text-gray-400 border-gray-700 font-mono"
                    >
                      time={formatFullTimestamp(entry.timestamp)}
                    </Badge>
                  </div>
                  <pre className="text-gray-300 whitespace-pre-wrap break-all text-[11px] leading-relaxed">
                    {entry.line}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
